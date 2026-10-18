// Shared vocabulary for the OpenAPI document (KTK-154): JSON Schema fragments,
// response builders, and the parameter/security shapes every operation uses.
// Keeping them here lets the schema and operation modules read as data.

import type { JsonObject } from "./json.js";

/** Runtime facts a client learns from the server, never guesses. */
export interface OpenApiOptions {
  /** The public origin the app is served from. */
  origin: string;
  /** Kaspa network name, e.g. "testnet10". */
  network: string;
  /** wRPC network id, e.g. "testnet-10". */
  networkId: string;
}

export const JSON_MEDIA_TYPE = "application/json";

export const HEX64_PATTERN = "^[0-9a-f]{64}$";
export const HEX_PATTERN = "^[0-9a-fA-F]*$";
export const TICKET_ID_PATTERN = "^[0-9a-f]{64}:[0-9]+$";
export const PUBLIC_KEY_PATTERN = "^(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{66})$";

/** `/v1/events/:covenantId` → `/v1/events/{covenant_id}`. */
export function toOpenApiPath(route: string): string {
  return route.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const snake = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    return `{${snake}}`;
  });
}

export const jsonRef = (name: string): JsonObject => ({
  $ref: `#/components/schemas/${name}`,
});

export const jsonContent = (schema: JsonObject): JsonObject => ({
  [JSON_MEDIA_TYPE]: { schema },
});

/** A JSON response, optionally with a worked example. */
export function jsonResponse(
  description: string,
  schema?: JsonObject,
  example?: unknown,
): JsonObject {
  if (schema === undefined) return { description };
  return {
    description,
    content: {
      [JSON_MEDIA_TYPE]: {
        schema,
        ...(example === undefined ? {} : { example }),
      },
    },
  };
}

/** A required JSON request body, optionally with a worked example. */
export function jsonRequestBody(schema: JsonObject, example?: unknown): JsonObject {
  return {
    required: true,
    content: {
      [JSON_MEDIA_TYPE]: {
        schema,
        ...(example === undefined ? {} : { example }),
      },
    },
  };
}

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: "Invalid request — a field is missing, malformed, or out of range.",
  401: "Authentication required, or the session token is missing/expired.",
  404: "The named resource is not known (or not on chain).",
  409: "Conflict — the resource changed while you worked.",
  422: "Rejected by a policy (sold out, not the owner, no spendable funds).",
  500: "Unexpected server error.",
  502: "The network refused the signed transaction.",
  503: "The chain upstream is unavailable; retry after `retryAfter`.",
};

export function errorResponse(status: number): JsonObject {
  return {
    description: ERROR_DESCRIPTIONS[status] ?? "Error.",
    content: jsonContent(jsonRef("ErrorEnvelope")),
  };
}

export function errorResponses(...statuses: number[]): JsonObject {
  return Object.fromEntries(statuses.map((status) => [String(status), errorResponse(status)]));
}

/** Every operation documents the same unexpected-failure surface. */
const UNEXPECTED_FAILURE_STATUSES = [500, 503] as const;

const pathParameter = (name: string, description: string, pattern?: string): JsonObject => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { type: "string", ...(pattern === undefined ? {} : { pattern }) },
});

export const COVENANT_ID_PARAMETER = pathParameter(
  "covenant_id",
  "The event's covenant id (64 lowercase hex), as returned by `GET /v1/events`.",
  HEX64_PATTERN,
);

export const TICKET_ID_PARAMETER = pathParameter(
  "ticket_id",
  "`<64-hex transaction id>:<output index>` — the shape served by `GET /v1/tickets`.",
  TICKET_ID_PATTERN,
);

export const BEARER_SECURITY = [{ bearerAuth: [] }];
export const OPTIONAL_BEARER_SECURITY = [...BEARER_SECURITY, {}];

interface OperationInput {
  operationId: string;
  tag: string;
  summary: string;
  description: string;
  security?: unknown;
  parameters?: JsonObject[];
  body?: JsonObject;
  responses: JsonObject;
}

/** An operation with its required metadata and the shared failure responses. */
export function operation(input: OperationInput): JsonObject {
  return {
    operationId: input.operationId,
    tags: [input.tag],
    summary: input.summary,
    description: input.description,
    ...(input.security === undefined ? {} : { security: input.security }),
    ...(input.parameters === undefined ? {} : { parameters: input.parameters }),
    ...(input.body === undefined ? {} : { requestBody: input.body }),
    responses: {
      ...input.responses,
      ...errorResponses(...UNEXPECTED_FAILURE_STATUSES),
    },
  };
}
