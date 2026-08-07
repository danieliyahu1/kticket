import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isApiError, toErrorEnvelope } from "./errors.js";
import type { ErrorEnvelope } from "./types.js";

const INTERNAL_ENVELOPE: ErrorEnvelope = {
  error: {
    type: "unknown-internal",
    message: "Internal server error",
    retryable: true,
  },
};

const NOT_FOUND_ENVELOPE: ErrorEnvelope = {
  error: {
    type: "invalid",
    message: "Route not found",
    retryable: false,
  },
};

function handleError(error: FastifyError, _request: FastifyRequest, reply: FastifyReply): void {
  if (isApiError(error)) {
    reply.code(error.statusCode).send(toErrorEnvelope(error));
    return;
  }

  if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
    reply.code(error.statusCode).send({
      error: {
        type: "invalid",
        message: error.message,
        retryable: false,
      },
    } satisfies ErrorEnvelope);
    return;
  }

  reply.code(500).send(INTERNAL_ENVELOPE);
}

/**
 * Register the error taxonomy middleware: every route error is mapped to the
 * consistent JSON error envelope (HLD v0.21 §2.2 "Error taxonomy").
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(handleError);
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send(NOT_FOUND_ENVELOPE);
  });
}
