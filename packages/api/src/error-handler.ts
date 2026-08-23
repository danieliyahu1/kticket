import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isApiError, toErrorEnvelope } from "./errors.js";
import { HTTP_BAD_REQUEST, HTTP_INTERNAL_SERVER_ERROR, HTTP_NOT_FOUND } from "./http-status.js";
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

function handleError(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  if (isApiError(error)) {
    reply.code(error.statusCode).send(toErrorEnvelope(error));
    return;
  }

  if (
    error.statusCode &&
    error.statusCode >= HTTP_BAD_REQUEST &&
    error.statusCode < HTTP_INTERNAL_SERVER_ERROR
  ) {
    reply.code(error.statusCode).send({
      error: {
        type: "invalid",
        message: error.message,
        retryable: false,
      },
    } satisfies ErrorEnvelope);
    return;
  }

  request.log.error({ err: error }, "unhandled error");
  reply.code(HTTP_INTERNAL_SERVER_ERROR).send(INTERNAL_ENVELOPE);
}

/**
 * Register the error taxonomy middleware: every route error is mapped to the
 * consistent JSON error envelope (HLD v0.21 §2.2 "Error taxonomy").
 */
export function registerErrorHandler(app: FastifyInstance, options?: { skipNotFound?: boolean }): void {
  app.setErrorHandler(handleError);
  if (!options?.skipNotFound) {
    app.setNotFoundHandler((_request, reply) => {
      reply.code(HTTP_NOT_FOUND).send(NOT_FOUND_ENVELOPE);
    });
  }
}
