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
    this.retryable = input.retryable ?? input.statusCode >= 500;
    this.retryAfter = input.retryAfter;
    this.detail = input.detail;
  }
}

export function invalidError(message: string, detail?: unknown): ApiError {
  return new ApiError({ type: "invalid", message, statusCode: 400, detail });
}

export function conflictError(message: string, detail?: unknown): ApiError {
  return new ApiError({ type: "conflict", message, statusCode: 409, detail });
}

export function policyError(message: string, detail?: unknown): ApiError {
  return new ApiError({ type: "policy", message, statusCode: 422, detail });
}

export function networkError(message: string, detail?: unknown): ApiError {
  return new ApiError({ type: "network", message, statusCode: 502, detail });
}

export function upstreamError(
  message: string,
  input: { retryAfter?: number; detail?: unknown } = {},
): ApiError {
  return new ApiError({
    type: "upstream",
    message,
    statusCode: 503,
    retryable: true,
    retryAfter: input.retryAfter,
    detail: input.detail,
  });
}

export function unknownError(cause: string, message: string, detail?: unknown): ApiError {
  return new ApiError({
    type: `unknown-${cause}`,
    message,
    statusCode: 500,
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
