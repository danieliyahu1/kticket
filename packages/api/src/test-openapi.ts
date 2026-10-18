// Test support for the published contract (KTK-154). It lives beside the other
// fakes (`test-chain.ts`, `test-artifacts.ts`) and is excluded from the build:
// the tests read the contract as a document and validate it as one.

import { isJsonObject, type JsonObject } from "./json.js";

export const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

export interface DocumentedOperation {
  path: string;
  method: string;
  operation: JsonObject;
}

function compareRoutes(
  a: { method: string; path: string },
  b: { method: string; path: string },
): number {
  return `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`);
}

/** Every operation in the document, in path order. */
export function documentedOperations(document: JsonObject): DocumentedOperation[] {
  const paths = isJsonObject(document.paths) ? document.paths : {};
  const found: DocumentedOperation[] = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isJsonObject(pathItem)) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.includes(method) || !isJsonObject(operation)) continue;
      found.push({ path, method, operation });
    }
  }

  return found;
}

/** The route set the document claims, sorted for comparison with Fastify. */
export function documentedRoutes(document: JsonObject): { method: string; path: string }[] {
  return documentedOperations(document)
    .map(({ method, path }) => ({ method, path }))
    .sort(compareRoutes);
}

/** Resolve an operation by id, so a test never hard-codes a path. */
export function operationPath(document: JsonObject, operationId: string): string {
  const found = documentedOperations(document).find(
    ({ operation }) => operation.operationId === operationId,
  );
  if (found === undefined) {
    throw new Error(`operation ${operationId} is not in the published contract`);
  }
  return found.path;
}

export function lookupJsonPointer(root: JsonObject, pointer: string): unknown {
  if (!pointer.startsWith("#/")) return undefined;
  return pointer
    .slice(2)
    .split("/")
    .reduce<unknown>((node, key) => (isJsonObject(node) ? node[key] : undefined), root);
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isJsonObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

/**
 * Validate a value against the JSON Schema subset this contract uses. Returns
 * human-readable failures; an empty array means the value is valid.
 */
export function validateJsonSchema(
  schema: unknown,
  value: unknown,
  root: JsonObject,
  path = "$",
): string[] {
  if (!isJsonObject(schema)) return [];
  const errors: string[] = [];

  if (typeof schema.$ref === "string") {
    const target = lookupJsonPointer(root, schema.$ref);
    if (target === undefined) return [`${path}: unresolved $ref ${schema.$ref}`];
    return validateJsonSchema(target, value, root, path);
  }

  for (const keyword of ["anyOf", "oneOf"] as const) {
    const variants = schema[keyword];
    if (!Array.isArray(variants)) continue;
    const matches = variants.filter(
      (variant) => validateJsonSchema(variant, value, root, path).length === 0,
    );
    const isValid = keyword === "oneOf" ? matches.length === 1 : matches.length > 0;
    if (!isValid) errors.push(`${path}: no valid ${keyword} variant`);
  }

  if (Array.isArray(schema.allOf)) {
    for (const variant of schema.allOf) {
      errors.push(...validateJsonSchema(variant, value, root, path));
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => entry === value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not in enum`);
  }

  if ("const" in schema && schema.const !== value) {
    errors.push(`${path}: ${JSON.stringify(value)} !== const ${JSON.stringify(schema.const)}`);
  }

  const type = schema.type;
  if (typeof type === "string" && !matchesType(type, value)) {
    errors.push(`${path}: expected ${type}, got ${value === null ? "null" : typeof value}`);
    return errors;
  }
  if (
    Array.isArray(type) &&
    !type.some((entry) => typeof entry === "string" && matchesType(entry, value))
  ) {
    errors.push(`${path}: expected ${type.join(" | ")}`);
    return errors;
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
    }
  }

  if (typeof value === "string" && typeof schema.pattern === "string") {
    if (!new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${path}: "${value}" does not match ${schema.pattern}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path}: ${value.length} items < minItems ${schema.minItems}`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${path}: ${value.length} items > maxItems ${schema.maxItems}`);
    }
    if (schema.items !== undefined) {
      value.forEach((entry, index) => {
        errors.push(...validateJsonSchema(schema.items, entry, root, `${path}[${index}]`));
      });
    }
  }

  if (isJsonObject(value)) {
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    for (const key of required) {
      if (!(key in value)) errors.push(`${path}: missing required property "${key}"`);
    }
    if (isJsonObject(schema.properties)) {
      for (const [key, propertySchema] of Object.entries(schema.properties)) {
        if (key in value) {
          errors.push(...validateJsonSchema(propertySchema, value[key], root, `${path}.${key}`));
        }
      }
    }
  }

  return errors;
}
