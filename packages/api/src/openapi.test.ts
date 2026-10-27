// The contract is the product surface (KTK-154). These tests keep it honest:
// it must be valid OpenAPI 3.1, every reference must resolve, every registered
// /v1 route must appear exactly once (and nothing else), and every example the
// docs render must validate against its own schema.

import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { isJsonObject } from "./json.js";
import { OPENAPI_EXAMPLES, openApiDocument, toOpenApiPath } from "./openapi.js";
import { registerRoutes, type AppContext } from "./routes.js";
import {
  HTTP_METHODS,
  documentedOperations,
  documentedRoutes,
  lookupJsonPointer,
  validateJsonSchema,
} from "./test-openapi.js";

const OPTIONS = {
  origin: "https://tickets.example.com",
  network: "testnet10",
  networkId: "testnet-10",
};

function sortRoutes(
  routes: { method: string; path: string }[],
): { method: string; path: string }[] {
  return [...routes].sort((a, b) =>
    `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`),
  );
}

function registeredRoutes(): { method: string; path: string }[] {
  const app = Fastify();
  const routes: { method: string; path: string }[] = [];

  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      const normalized = method.toLowerCase();
      if (!HTTP_METHODS.includes(normalized)) continue;
      // Fastify auto-registers HEAD for every GET; the contract documents GET.
      if (normalized === "head") continue;
      if (!route.url.startsWith("/v1")) continue;
      routes.push({ method: normalized, path: toOpenApiPath(route.url) });
    }
  });

  // Route registration only attaches handlers; the context is read inside them.
  registerRoutes(app, {} as AppContext);

  return sortRoutes(routes);
}

describe("OpenAPI contract (KTK-154)", () => {
  const document = openApiDocument(OPTIONS);

  it("is an OpenAPI 3.1 document with identity and a server", () => {
    expect(document.openapi).toBe("3.1.0");
    if (!isJsonObject(document.info)) throw new Error("info must be an object");
    expect(document.info.title).toBe("kticket API");
    expect(document.servers).toEqual([
      { url: OPTIONS.origin, description: `kticket on ${OPTIONS.network}` },
    ]);
    expect(document["x-network"]).toEqual({
      network: OPTIONS.network,
      networkId: OPTIONS.networkId,
    });
  });

  it("resolves every $ref to a component schema", () => {
    const refs: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (!isJsonObject(value)) return;
      if (typeof value.$ref === "string") refs.push(value.$ref);
      Object.values(value).forEach(walk);
    };
    walk(document);

    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(lookupJsonPointer(document, ref), `unresolved ${ref}`).toBeDefined();
    }
  });

  it("documents every registered /v1 route exactly once — and nothing else", () => {
    expect(documentedRoutes(document)).toEqual(registeredRoutes());
  });

  it("gives every operation an id, summary, tag, and responses", () => {
    const operations = documentedOperations(document);
    expect(operations).toHaveLength(23);

    const ids = new Set<string>();
    for (const { path, method, operation } of operations) {
      const id = operation.operationId;
      expect(typeof id, `${method} ${path} operationId`).toBe("string");
      expect(ids.has(String(id)), `duplicate operationId ${id}`).toBe(false);
      ids.add(String(id));

      expect(typeof operation.summary, `${method} ${path} summary`).toBe("string");
      expect(Array.isArray(operation.tags), `${method} ${path} tags`).toBe(true);
      expect(operation.tags, `${method} ${path} tags`).not.toHaveLength(0);

      const responses = operation.responses;
      if (!isJsonObject(responses)) throw new Error(`${method} ${path} responses must be an object`);
      const statuses = Object.keys(responses);
      expect(statuses.some((status) => status.startsWith("2")), `${method} ${path} 2xx`).toBe(
        true,
      );
    }
  });

  it("validates every documented example against its schema", () => {
    const examples: { label: string; schema: unknown; value: unknown }[] = [];

    for (const { path, method, operation } of documentedOperations(document)) {
      const requestBody = operation.requestBody;
      if (isJsonObject(requestBody) && isJsonObject(requestBody.content)) {
        const media = requestBody.content["application/json"];
        if (isJsonObject(media) && media.example !== undefined) {
          examples.push({
            label: `${method.toUpperCase()} ${path} request`,
            schema: media.schema,
            value: media.example,
          });
        }
      }

      const responses = operation.responses;
      if (!isJsonObject(responses)) continue;
      for (const [status, response] of Object.entries(responses)) {
        if (!isJsonObject(response) || !isJsonObject(response.content)) continue;
        const media = response.content["application/json"];
        if (isJsonObject(media) && media.example !== undefined) {
          examples.push({
            label: `${method.toUpperCase()} ${path} ${status}`,
            schema: media.schema,
            value: media.example,
          });
        }
      }
    }

    expect(examples.length).toBeGreaterThan(15);
    for (const example of examples) {
      expect(validateJsonSchema(example.schema, example.value, document), example.label).toEqual(
        [],
      );
    }

    expect(
      validateJsonSchema(
        { $ref: "#/components/schemas/ErrorEnvelope" },
        OPENAPI_EXAMPLES.error,
        document,
      ),
    ).toEqual([]);
  });

  it("declares who needs a bearer token", () => {
    const components = document.components;
    if (!isJsonObject(components)) throw new Error("components must be an object");
    expect(components.securitySchemes).toMatchObject({
      bearerAuth: { type: "http", scheme: "bearer" },
    });

    const operations = new Map(
      documentedOperations(document).map(({ path, method, operation }) => [
        `${method} ${path}`,
        operation,
      ]),
    );
    // A user-specific read opts in.
    expect(operations.get("get /v1/tickets")?.security).toEqual([{ bearerAuth: [] }]);
    // Public, with auth only needed for the organizer filter.
    expect(operations.get("get /v1/events")?.security).toEqual([{ bearerAuth: [] }, {}]);
    // prepare/finalize prove identity with the signed transaction, not a token.
    expect(
      operations.get("post /v1/events/{covenant_id}/buy/prepare")?.security,
    ).toBeUndefined();
    expect(operations.get("post /v1/auth/challenge")?.security).toBeUndefined();
  });

  it("describes the wire transaction shape the wallet signs", () => {
    const components = document.components;
    if (!isJsonObject(components)) throw new Error("components must be an object");
    const schemas = components.schemas;
    if (!isJsonObject(schemas)) throw new Error("schemas must be an object");

    const wire = schemas.WireTransaction;
    if (!isJsonObject(wire)) throw new Error("WireTransaction must be an object");
    expect(wire.required).toEqual(["version", "inputs", "outputs", "lock_time"]);
    const properties = wire.properties;
    if (!isJsonObject(properties)) throw new Error("WireTransaction.properties missing");
    expect(Object.keys(properties).sort()).toEqual([
      "inputs",
      "lock_time",
      "outputs",
      "payload",
      "version",
    ]);

    const errorEnvelope = schemas.ErrorEnvelope;
    if (!isJsonObject(errorEnvelope)) throw new Error("ErrorEnvelope must be an object");
    const envelopeProperties = errorEnvelope.properties;
    if (!isJsonObject(envelopeProperties)) throw new Error("ErrorEnvelope.properties missing");
    expect(envelopeProperties.error).toMatchObject({
      required: ["type", "message", "retryable"],
    });
  });
});
