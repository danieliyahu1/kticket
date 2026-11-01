import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit.js";

describe("RateLimiter", () => {
  it("allows up to the limit within one window and then reports a retry delay", () => {
    let now = 1_000;
    const limiter = new RateLimiter({ limit: 2, windowMs: 10_000, now: () => now });

    expect(limiter.check("client").allowed).toBe(true);
    expect(limiter.check("client").allowed).toBe(true);
    const refused = limiter.check("client");
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(10);

    now += 10_000;
    expect(limiter.check("client").allowed).toBe(true);
  });

  it("keeps separate windows per client", () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1_000, now: () => 0 });

    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
    expect(limiter.check("b").allowed).toBe(true);
  });

  it("bounds the key space", () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1_000, maxKeys: 2, now: () => 0 });

    limiter.check("a");
    limiter.check("b");
    limiter.check("c");

    // The oldest key was evicted, so it starts a fresh window.
    expect(limiter.check("a").allowed).toBe(true);
  });
});
