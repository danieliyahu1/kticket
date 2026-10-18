// The rendered API reference served at `/docs/api` (KTK-157). It is generated
// from the same OpenAPI document the JSON endpoint serves, so the two cannot
// disagree, and it is fully self-contained: no CDN, no fonts, no scripts, no
// network of any kind. A reader with JavaScript disabled still gets the whole
// contract.

import { AGENT_GUIDE_PATH, API_DOCS_PATH, LLMS_TXT_PATH, OPENAPI_PATH } from "./docs-paths.js";
import { ERROR_TYPES } from "./errors.js";
import { isJsonObject, type JsonObject } from "./json.js";

const JSON_MEDIA_TYPE = "application/json";

/** The taxonomy every error envelope uses, plus the forward-compatible family. */
const DOCUMENTED_ERROR_TYPES = [...Object.values(ERROR_TYPES), "unknown-*"];

const STATUS_ORDER = [200, 201, 202, 400, 401, 403, 404, 409, 422, 500, 502, 503];

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Escape prose, then turn `backtick spans` into inline code. */
function prose(value: string): string {
  return escapeHtml(value).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function refName(schema: JsonObject): string | undefined {
  const name = schema.$ref;
  if (typeof name !== "string") return undefined;
  return name.slice(name.lastIndexOf("/") + 1);
}

/** A short, human-readable type label — enough to read the contract. */
function schemaLabel(schema: unknown): string {
  if (!isJsonObject(schema)) return "any";
  const name = refName(schema);
  if (name !== undefined) return name;
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  const variants: unknown[] = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : [];
  if (variants.length > 0) return variants.map(schemaLabel).join(" | ");
  const type = schema.type;
  if (Array.isArray(type)) return type.map((entry) => String(entry)).join(" | ");
  if (type === "array") return `${schemaLabel(schema.items)}[]`;
  if (typeof type === "string") return type;
  return "any";
}

function resolve(document: JsonObject, schema: unknown): JsonObject | undefined {
  if (!isJsonObject(schema)) return undefined;
  const name = refName(schema);
  if (name === undefined) return schema;
  const components = document.components;
  if (!isJsonObject(components)) return undefined;
  const schemas = components.schemas;
  if (!isJsonObject(schemas)) return undefined;
  const target = schemas[name];
  return isJsonObject(target) ? target : undefined;
}

function renderPropertyRows(document: JsonObject, schema: unknown): string[] {
  const resolved = resolve(document, schema);
  const properties = resolved?.properties;
  if (!isJsonObject(properties)) return [];
  const requiredValues = resolved?.required;
  const required = new Set(Array.isArray(requiredValues) ? requiredValues.map(String) : []);

  return Object.entries(properties).map(([name, value]) => {
    const description =
      isJsonObject(value) && typeof value.description === "string" ? value.description : "";
    const marker = required.has(name)
      ? '<span class="required">required</span>'
      : '<span class="optional">optional</span>';
    return `<li><code>${escapeHtml(name)}</code> ${marker} <span class="type">${escapeHtml(
      schemaLabel(value),
    )}</span>${description ? ` — ${prose(description)}` : ""}</li>`;
  });
}

function renderExample(example: unknown): string {
  if (example === undefined) return "";
  return `<pre class="example">${escapeHtml(JSON.stringify(example, null, 2))}</pre>`;
}

function renderRequestBody(document: JsonObject, operation: JsonObject): string {
  const requestBody = operation.requestBody;
  if (!isJsonObject(requestBody) || !isJsonObject(requestBody.content)) return "";
  const media = requestBody.content[JSON_MEDIA_TYPE];
  if (!isJsonObject(media)) return "";
  const rows = renderPropertyRows(document, media.schema);
  return [
    "<h4>Request body</h4>",
    `<p class="schema-name"><code>${escapeHtml(schemaLabel(media.schema))}</code></p>`,
    rows.length > 0 ? `<ul class="fields">${rows.join("")}</ul>` : "",
    renderExample(media.example),
  ].join("\n");
}

function renderParameters(operation: JsonObject): string {
  const parameters = operation.parameters;
  if (!Array.isArray(parameters) || parameters.length === 0) return "";
  const rows = parameters.map((parameter) => {
    if (!isJsonObject(parameter)) return "";
    const name = String(parameter.name ?? "");
    const location = String(parameter.in ?? "");
    const isRequired = parameter.required === true;
    const description =
      typeof parameter.description === "string" ? parameter.description : "";
    return `<li><code>${escapeHtml(name)}</code> <span class="type">${escapeHtml(
      location,
    )}</span> <span class="${isRequired ? "required" : "optional"}">${
      isRequired ? "required" : "optional"
    }</span>${description ? ` — ${prose(description)}` : ""}</li>`;
  });
  return `<h4>Parameters</h4><ul class="fields">${rows.join("")}</ul>`;
}

function statusSort(a: string, b: string): number {
  const first = STATUS_ORDER.indexOf(Number(a));
  const second = STATUS_ORDER.indexOf(Number(b));
  return (first === -1 ? 99 : first) - (second === -1 ? 99 : second);
}

function renderResponses(document: JsonObject, operation: JsonObject): string {
  const responses = operation.responses;
  if (!isJsonObject(responses)) return "";
  const rows = Object.keys(responses)
    .sort(statusSort)
    .map((status) => {
      const response = responses[status];
      if (!isJsonObject(response)) return "";
      const description =
        typeof response.description === "string" ? response.description : "";
      const content = response.content;
      const media = isJsonObject(content) ? content[JSON_MEDIA_TYPE] : undefined;
      const schema = isJsonObject(media) ? media.schema : undefined;
      const schemaName =
        schema === undefined
          ? ""
          : ` <span class="type">${escapeHtml(schemaLabel(schema))}</span>`;
      const example = isJsonObject(media) ? renderExample(media.example) : "";
      return `<tr><td><code>${escapeHtml(status)}</code></td><td>${prose(
        description,
      )}${schemaName}</td></tr>${example ? `<tr><td></td><td>${example}</td></tr>` : ""}`;
    });
  return `<h4>Responses</h4><table class="responses"><tbody>${rows.join("")}</tbody></table>`;
}

interface OperationContext {
  document: JsonObject;
  method: string;
  path: string;
  operation: JsonObject;
}

function renderOperation(context: OperationContext): string {
  const { operation } = context;
  const operationId = String(operation.operationId ?? "");
  const summary = String(operation.summary ?? "");
  const description = String(operation.description ?? "");
  const secured = Array.isArray(operation.security) && operation.security.length > 0;

  return [
    `<article class="operation" id="op-${escapeHtml(operationId)}" data-operation-id="${escapeHtml(
      operationId,
    )}">`,
    `<h3><span class="method method-${context.method}">${context.method.toUpperCase()}</span> <code class="path">${escapeHtml(
      context.path,
    )}</code></h3>`,
    `<p class="summary">${prose(summary)}</p>`,
    description ? `<p>${prose(description)}</p>` : "",
    secured ? '<p class="auth"><strong>Auth:</strong> bearer token.</p>' : "",
    renderParameters(operation),
    renderRequestBody(context.document, operation),
    renderResponses(context.document, operation),
    "</article>",
  ].join("\n");
}

function collectErrorCodes(document: JsonObject): Map<string, string> {
  const codes = new Map<string, string>();
  const paths = document.paths;
  if (!isJsonObject(paths)) return codes;

  for (const pathItem of Object.values(paths)) {
    if (!isJsonObject(pathItem)) continue;
    for (const operation of Object.values(pathItem)) {
      if (!isJsonObject(operation) || !isJsonObject(operation.responses)) continue;
      for (const [status, response] of Object.entries(operation.responses)) {
        if (Number(status) < 400 || !isJsonObject(response)) continue;
        const description =
          typeof response.description === "string" ? response.description : "";
        if (!codes.has(status)) codes.set(status, description);
      }
    }
  }

  return codes;
}

/**
 * Render the whole contract as one static HTML document. `origin` is the public
 * origin used for the canonical link back to this page.
 */
export function apiDocsHtml(document: JsonObject, origin: string): string {
  const info = isJsonObject(document.info) ? document.info : {};
  const title = typeof info.title === "string" ? info.title : "kticket API";
  const version = typeof info.version === "string" ? info.version : "";
  const description = typeof info.description === "string" ? info.description : "";

  const tags = Array.isArray(document.tags)
    ? document.tags.filter(isJsonObject).map((tag) => ({
        name: String(tag.name ?? ""),
        description: typeof tag.description === "string" ? tag.description : "",
      }))
    : [];

  const paths = isJsonObject(document.paths) ? document.paths : {};
  const renderedByTag = new Map<string, string[]>();
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isJsonObject(pathItem)) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!isJsonObject(operation)) continue;
      const operationTags = Array.isArray(operation.tags)
        ? operation.tags.map(String)
        : ["other"];
      for (const tag of operationTags) {
        const rendered = renderedByTag.get(tag) ?? [];
        rendered.push(renderOperation({ document, method, path, operation }));
        renderedByTag.set(tag, rendered);
      }
    }
  }

  const sections = tags
    .filter((tag) => renderedByTag.has(tag.name))
    .map((tag) => {
      const operations = renderedByTag.get(tag.name) ?? [];
      return [
        `<section class="tag" id="tag-${escapeHtml(tag.name)}">`,
        `<h2>${escapeHtml(tag.name)}</h2>`,
        tag.description ? `<p class="tag-description">${prose(tag.description)}</p>` : "",
        ...operations,
        "</section>",
      ].join("\n");
    });

  const errorCodes = [...collectErrorCodes(document).entries()].sort((a, b) =>
    statusSort(a[0], b[0]),
  );
  const errorRows = errorCodes.map(
    ([status, errorDescription]) =>
      `<tr><td><code>${escapeHtml(status)}</code></td><td>${prose(errorDescription)}</td></tr>`,
  );

  const tableOfContents = tags
    .filter((tag) => renderedByTag.has(tag.name))
    .map((tag) => `<li><a href="#tag-${escapeHtml(tag.name)}">${escapeHtml(tag.name)}</a></li>`)
    .join("");

  const canonical = `${origin.replace(/\/+$/, "")}${API_DOCS_PATH}`;

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    `<link rel="alternate" type="${JSON_MEDIA_TYPE}" href="${OPENAPI_PATH}">`,
    `<link rel="alternate" type="text/plain" href="${LLMS_TXT_PATH}">`,
    "<style>",
    "body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.55;max-width:60rem;margin:0 auto;padding:2rem 1.25rem;color:#111;background:#fff}",
    "h1,h2,h3,h4{line-height:1.25}h2{margin-top:2.5rem;border-bottom:1px solid #ddd;padding-bottom:.35rem}",
    "a{color:#0f5c8c}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
    "pre{background:#f6f8fa;padding:.75rem;overflow:auto;border-radius:4px;font-size:.85rem}",
    "table{border-collapse:collapse;width:100%;margin:.4rem 0 1rem}td,th{border-bottom:1px solid #eaeaea;padding:.35rem .5rem;text-align:left;vertical-align:top;font-size:.92rem}",
    ".operation{border:1px solid #e4e7eb;border-radius:6px;padding:.85rem 1rem;margin:1rem 0}",
    ".operation h3{margin:.1rem 0 .5rem}.summary{font-weight:600;margin:.25rem 0}",
    ".method{display:inline-block;min-width:3.6rem;text-align:center;border-radius:3px;padding:.05rem .35rem;font-size:.8rem;color:#fff;background:#555}",
    ".method-get{background:#116329}.method-post{background:#8a4b00}",
    ".path{font-size:1rem}.type{color:#555;font-size:.85rem}",
    ".required{color:#b42318;font-size:.78rem}.optional{color:#667085;font-size:.78rem}",
    ".fields{padding-left:1.1rem}.fields li{margin:.15rem 0}",
    ".auth{color:#8a4b00}.tag-description{color:#444}",
    ".example{max-height:22rem}",
    "nav ul{display:flex;gap:1rem;list-style:none;padding:0;flex-wrap:wrap}",
    "footer{margin-top:3rem;color:#555;font-size:.9rem}",
    "</style>",
    "</head>",
    "<body>",
    "<header>",
    `<h1>${escapeHtml(title)}</h1>`,
    `<p>${escapeHtml(description)}</p>`,
    version ? `<p class="type">Version ${escapeHtml(version)}</p>` : "",
    "<nav><ul>",
    tableOfContents,
    `<li><a href="${AGENT_GUIDE_PATH}">agent guide</a></li>`,
    `<li><a href="${OPENAPI_PATH}">OpenAPI JSON</a></li>`,
    `<li><a href="${LLMS_TXT_PATH}">llms.txt</a></li>`,
    "</ul></nav>",
    "</header>",
    "<main>",
    ...sections,
    '<section id="errors">',
    "<h2>Errors</h2>",
    "<p>Every failure uses one envelope. <code>type</code> is stable and machine-readable; <code>retryable</code> says whether the same request may succeed later.</p>",
    '<pre class="example">{\n  "error": {\n    "type": "invalid",\n    "message": "capacity must be 0..100",\n    "retryable": false\n  }\n}</pre>',
    `<p><strong>Types:</strong> ${DOCUMENTED_ERROR_TYPES.map(
      (type) => `<code>${escapeHtml(type)}</code>`,
    ).join(", ")}</p>`,
    '<table class="responses"><tbody>',
    "<tr><th>Status</th><th>Meaning</th></tr>",
    ...errorRows,
    "</tbody></table>",
    "</section>",
    "</main>",
    `<footer>Machine-readable at <a href="${OPENAPI_PATH}">${OPENAPI_PATH}</a> and <a href="${LLMS_TXT_PATH}">${LLMS_TXT_PATH}</a>. Humans can read the same flow in the <a href="${AGENT_GUIDE_PATH}">agent guide</a>.</footer>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
