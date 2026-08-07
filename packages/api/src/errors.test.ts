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
import type { ErrorEnvelope } from "./types";

describe("error taxonomy", () => {
  it("invalid maps to 400 (covenant/consensus)", () => {
    const err = invalidError("bad covenant");
    expect(err).toBeInstanceOf(ApiError);
    expect(err.type).toBe("invalid");
    expect(err.statusCode).toBe(400);
    expect(err.retryable).toBe(false);
  });

  it("conflict maps to 409 (double-spend)", () => {
    const err = conflictError("double spend");
    expect(err.type).toBe("conflict");
    expect(err.statusCode).toBe(409);
    expect(err.retryable).toBe(false);
  });

  it("policy maps to 422 (fee below floor)", () => {
    const err = policyError("fee below relay floor");
    expect(err.type).toBe("policy");
    expect(err.statusCode).toBe(422);
    expect(err.retryable).toBe(false);
  });

  it("network maps to 502", () => {
    const err = networkError("connection refused");
    expect(err.type).toBe("network");
    expect(err.statusCode).toBe(502);
    expect(err.retryable).toBe(true);
  });

  it("upstream maps to 503 with retry/backoff", () => {
    const err = upstreamError("rate limited", { retryAfter: 2 });
    expect(err.type).toBe("upstream");
    expect(err.statusCode).toBe(503);
    expect(err.retryable).toBe(true);
    expect(err.retryAfter).toBe(2);
  });

  it("unknown-* is retryable and never guessed", () => {
    const err = unknownError("unresolved-spend", "could not resolve spend");
    expect(err.type).toBe("unknown-unresolved-spend");
    expect(err.statusCode).toBe(500);
    expect(err.retryable).toBe(true);
  });

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
