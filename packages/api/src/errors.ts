import {
  HTTP_BAD_GATEWAY,
  HTTP_BAD_REQUEST,
  HTTP_CONFLICT,
  HTTP_INTERNAL_SERVER_ERROR,
  HTTP_SERVICE_UNAVAILABLE,
  HTTP_UNPROCESSABLE_ENTITY,
} from "./http-status.js";
import type { ErrorEnvelope, ErrorType } from "./types.js";

export const ERROR_TYPES = {
  invalid: "invalid",
  conflict: "conflict",
  policy: "policy",
  network: "network",
  upstream: "upstream",
} as const;

export class ApiError extends Error {
  override readonly name = "ApiError";

  readonly type: ErrorType;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly retryAfter?: number;
  readonly detail?: unknown;

  constructor(input: {
    type: ErrorType;
    message: string;
    statusCode: number;
    retryable?: boolean;
    retryAfter?: number;
    detail?: unknown;
  }) {
    super(input.message);
    this.type = input.type;
    this.statusCode = input.statusCode;
    this.retryable = input.retryable ?? input.statusCode >= HTTP_INTERNAL_SERVER_ERROR;
    this.retryAfter = input.retryAfter;
    this.detail = input.detail;
  }
}

export function invalidError(message: string, detail?: unknown): ApiError {
  return new ApiError({ type: "invalid", message, statusCode: HTTP_BAD_REQUEST, detail });
}

export function conflictError(message: string, detail?: unknown): ApiError {
  return new ApiError({ type: "conflict", message, statusCode: HTTP_CONFLICT, detail });
}

export function policyError(message: string, detail?: unknown): ApiError {
  return new ApiError({
    type: "policy",
    message,
    statusCode: HTTP_UNPROCESSABLE_ENTITY,
    detail,
  });
}

export function networkError(message: string, detail?: unknown): ApiError {
  return new ApiError({ type: "network", message, statusCode: HTTP_BAD_GATEWAY, detail });
}

export function upstreamError(
  message: string,
  input: { retryAfter?: number; detail?: unknown } = {},
): ApiError {
  return new ApiError({
    type: "upstream",
    message,
    statusCode: HTTP_SERVICE_UNAVAILABLE,
    retryable: true,
    retryAfter: input.retryAfter,
    detail: input.detail,
  });
}

export function unknownError(cause: string, message: string, detail?: unknown): ApiError {
  return new ApiError({
    type: `unknown-${cause}`,
    message,
    statusCode: HTTP_INTERNAL_SERVER_ERROR,
    retryable: true,
    detail,
  });
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function toErrorEnvelope(error: ApiError): ErrorEnvelope {
  return {
    error: {
      type: error.type,
      message: error.message,
      retryable: error.retryable,
      ...(error.retryAfter !== undefined ? { retryAfter: error.retryAfter } : {}),
      ...(error.detail !== undefined ? { detail: error.detail } : {}),
    },
  };
}
