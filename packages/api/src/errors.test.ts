import { describe, expect, it } from "vitest";
import {
  ApiError,
  conflictError,
  invalidError,
  networkError,
  policyError,
  toErrorEnvelope,
  unknownError,
  upstreamError,
} from "./errors";
import {
  HTTP_BAD_GATEWAY,
  HTTP_BAD_REQUEST,
  HTTP_CONFLICT,
  HTTP_INTERNAL_SERVER_ERROR,
  HTTP_SERVICE_UNAVAILABLE,
  HTTP_UNPROCESSABLE_ENTITY,
} from "./http-status.js";
import type { ErrorEnvelope } from "./types";

describe("error taxonomy", () => {
  it("invalid maps to 400 (covenant/consensus)", () => {
    const err = invalidError("bad covenant");
    expect(err).toBeInstanceOf(ApiError);
    expect(err.type).toBe("invalid");
    expect(err.statusCode).toBe(HTTP_BAD_REQUEST);
    expect(err.retryable).toBe(false);
  });

  it("conflict maps to 409 (double-spend)", () => {
    const err = conflictError("double spend");
    expect(err.type).toBe("conflict");
    expect(err.statusCode).toBe(HTTP_CONFLICT);
    expect(err.retryable).toBe(false);
  });

  it("policy maps to 422 (fee below floor)", () => {
    const err = policyError("fee below relay floor");
    expect(err.type).toBe("policy");
    expect(err.statusCode).toBe(HTTP_UNPROCESSABLE_ENTITY);
    expect(err.retryable).toBe(false);
  });

  it("network maps to 502", () => {
    const err = networkError("connection refused");
    expect(err.type).toBe("network");
    expect(err.statusCode).toBe(HTTP_BAD_GATEWAY);
    expect(err.retryable).toBe(true);
  });
});

describe("error taxonomy (upstream + unknown)", () => {
  it("upstream maps to 503 with retry/backoff", () => {
    const err = upstreamError("rate limited", { retryAfter: 2 });
    expect(err.type).toBe("upstream");
    expect(err.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
    expect(err.retryable).toBe(true);
    expect(err.retryAfter).toBe(2);
  });

  it("unknown-* is retryable and never guessed", () => {
    const err = unknownError("unresolved-spend", "could not resolve spend");
    expect(err.type).toBe("unknown-unresolved-spend");
    expect(err.statusCode).toBe(HTTP_INTERNAL_SERVER_ERROR);
    expect(err.retryable).toBe(true);
  });
});

describe("error taxonomy (envelope serialization)", () => {
  it("serializes a consistent JSON envelope", () => {
    const err = upstreamError("rate limited", { retryAfter: 2, detail: { retryable: true } });
    const envelope = toErrorEnvelope(err);
    expect(envelope).toEqual({
      error: {
        type: "upstream",
        message: "rate limited",
        retryable: true,
        retryAfter: 2,
        detail: { retryable: true },
      },
    } satisfies ErrorEnvelope);
  });

  it("omits optional envelope fields when absent", () => {
    const envelope = toErrorEnvelope(invalidError("nope"));
    expect(envelope.error).toEqual({
      type: "invalid",
      message: "nope",
      retryable: false,
    });
  });
});
