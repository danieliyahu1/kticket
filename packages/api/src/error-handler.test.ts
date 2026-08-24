import { describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import {
  conflictError,
  invalidError,
  networkError,
  policyError,
  unknownError,
  upstreamError,
} from "./errors";
import {
  HTTP_BAD_GATEWAY,
  HTTP_BAD_REQUEST,
  HTTP_CONFLICT,
  HTTP_INTERNAL_SERVER_ERROR,
  HTTP_NOT_FOUND,
  HTTP_OK,
  HTTP_SERVICE_UNAVAILABLE,
  HTTP_UNPROCESSABLE_ENTITY,
} from "./http-status.js";

async function appWithFailures() {
  const app = await buildApp(loadConfig({ PORT: "0", AUTH_SECRET: "test-secret-for-kticket-api" }));

  app.get("/fail/invalid", async () => {
    throw invalidError("bad covenant");
  });
  app.get("/fail/conflict", async () => {
    throw conflictError("double spend");
  });
  app.get("/fail/policy", async () => {
    throw policyError("fee below floor");
  });
  app.get("/fail/network", async () => {
    throw networkError("connection refused");
  });
  app.get("/fail/upstream", async () => {
    throw upstreamError("rate limited", { retryAfter: 3 });
  });
  app.get("/fail/unknown", async () => {
    throw unknownError("unresolved-spend", "cannot resolve");
  });
  app.get("/fail/internal", async () => {
    throw new Error("boom");
  });

  return app;
}

describe("error taxonomy middleware", () => {
  it("health endpoint reports ok + network", async () => {
    const app = await buildApp(loadConfig({ KASPANET: "testnet10", PORT: "0", AUTH_SECRET: "test-secret-for-kticket-api" }));
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json()).toEqual({ status: "ok", network: "testnet10" });
  });

  it("maps invalid -> 400 with envelope", async () => {
    const app = await appWithFailures();
    const res = await app.inject({ method: "GET", url: "/fail/invalid" });
    expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
    expect(res.json()).toEqual({
      error: { type: "invalid", message: "bad covenant", retryable: false },
    });
  });

  it("maps conflict -> 409 with envelope", async () => {
    const app = await appWithFailures();
    const res = await app.inject({ method: "GET", url: "/fail/conflict" });
    expect(res.statusCode).toBe(HTTP_CONFLICT);
    expect(res.json().error.type).toBe("conflict");
    expect(res.json().error.retryable).toBe(false);
  });
});

describe("error taxonomy middleware (5xx mapping)", () => {
  it("maps policy -> 422 with envelope", async () => {
    const app = await appWithFailures();
    const res = await app.inject({ method: "GET", url: "/fail/policy" });
    expect(res.statusCode).toBe(HTTP_UNPROCESSABLE_ENTITY);
    expect(res.json().error.type).toBe("policy");
  });

  it("maps network -> 502 with envelope", async () => {
    const app = await appWithFailures();
    const res = await app.inject({ method: "GET", url: "/fail/network" });
    expect(res.statusCode).toBe(HTTP_BAD_GATEWAY);
    expect(res.json().error.type).toBe("network");
    expect(res.json().error.retryable).toBe(true);
  });

  it("maps upstream -> 503 with retryAfter", async () => {
    const app = await appWithFailures();
    const res = await app.inject({ method: "GET", url: "/fail/upstream" });
    expect(res.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
    expect(res.json()).toEqual({
      error: {
        type: "upstream",
        message: "rate limited",
        retryable: true,
        retryAfter: 3,
      },
    });
  });
});

describe("error taxonomy middleware (unknown + fallbacks)", () => {
  it("maps unknown-* -> 500 (never guessed)", async () => {
    const app = await appWithFailures();
    const res = await app.inject({ method: "GET", url: "/fail/unknown" });
    expect(res.statusCode).toBe(HTTP_INTERNAL_SERVER_ERROR);
    expect(res.json().error.type).toBe("unknown-unresolved-spend");
    expect(res.json().error.retryable).toBe(true);
  });

  it("sanitizes internal errors -> 500 without leaking internals", async () => {
    const app = await appWithFailures();
    const res = await app.inject({ method: "GET", url: "/fail/internal" });
    expect(res.statusCode).toBe(HTTP_INTERNAL_SERVER_ERROR);
    expect(res.json().error).toEqual({
      type: "unknown-internal",
      message: "Internal server error",
      retryable: true,
    });
  });

  it("returns a consistent envelope for unknown routes", async () => {
    const app = await appWithFailures();
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(HTTP_NOT_FOUND);
    expect(res.json().error).toEqual({
      type: "invalid",
      message: "Route not found",
      retryable: false,
    });
  });
});
