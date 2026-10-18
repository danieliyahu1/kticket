// The public HTTP contract (KTK-152 / KTK-154).
//
// This module is the composer and the public entry point. The document is the
// source of truth for the /v1 API: the browser app, a script, and an agent all
// read the same contract. It is authored in code (not a hand-maintained JSON
// file) so it is served, rendered, and tested from one place.
//
//   openapi-schemas.ts     — the component schemas, grouped by flow
//   openapi-operations.ts  — the documented operations, grouped by flow
//   openapi-examples.ts    — fixtures the docs render and the tests validate
//   openapi-helpers.ts     — the shared JSON Schema/response vocabulary
//
// `openapi.test.ts` enforces parity against the Fastify route table: adding a
// route without documenting it — or documenting one that does not exist —
// fails the test suite.

import { isJsonObject, type JsonObject } from "./json.js";
import { toOpenApiPath, type OpenApiOptions } from "./openapi-helpers.js";
import { buildOperations } from "./openapi-operations.js";
import { buildComponents } from "./openapi-schemas.js";

export type { OpenApiOptions } from "./openapi-helpers.js";
export { OPENAPI_EXAMPLES } from "./openapi-examples.js";
export { toOpenApiPath } from "./openapi-helpers.js";

/**
 * Build the OpenAPI 3.1 document for the current server. `options.origin` is
 * the public origin, so a client that fetched `/llms.txt` follows absolute
 * links that resolve against the same deployment.
 */
export function openApiDocument(options: OpenApiOptions): JsonObject {
  const paths: JsonObject = {};

  for (const { method, route, operation } of buildOperations(options)) {
    const path = toOpenApiPath(route);
    const existing = paths[path];
    const pathItem: JsonObject = isJsonObject(existing) ? existing : (paths[path] = {});
    pathItem[method] = operation;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "kticket API",
      version: "1.0.0",
      description:
        "On-chain event ticketing on Kaspa. The HTTP API is the product: the browser app, a script, and an agent all use it the same way. Identity is wallet ownership — sign a server-issued challenge, then send the bearer token.",
      license: { name: "MIT" },
    },
    servers: [{ url: options.origin, description: `kticket on ${options.network}` }],
    tags: [
      { name: "auth", description: "Challenge → signature → session token." },
      { name: "events", description: "Verified events, deploys, and primary ticket purchases." },
      { name: "tickets", description: "The caller's tickets and the door (check-in) flow." },
      { name: "resale", description: "List, delist, browse, and trustlessly purchase tickets." },
    ],
    paths,
    components: buildComponents(),
    "x-network": { network: options.network, networkId: options.networkId },
  };
}
