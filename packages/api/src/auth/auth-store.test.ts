import { describe, expect, it } from "vitest";
import { InMemoryAuthStore } from "./auth-store.js";

describe("InMemoryAuthStore", () => {
  it("issues a unique nonce for an address", async () => {
    const store = new InMemoryAuthStore();
    const a = await store.create("kaspatest:abc");
    const b = await store.create("kaspatest:abc");
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.address).toBe("kaspatest:abc");
    expect(a.expiresAt).toBeGreaterThan(Date.now());
  });

  it("consumes a nonce exactly once", async () => {
    const store = new InMemoryAuthStore();
    const { nonce } = await store.create("kaspatest:abc");
    const first = await store.consume(nonce, "kaspatest:abc");
    expect(first?.nonce).toBe(nonce);
    const second = await store.consume(nonce, "kaspatest:abc");
    expect(second).toBeNull();
  });

  it("rejects a nonce for a different address", async () => {
    const store = new InMemoryAuthStore();
    const { nonce } = await store.create("kaspatest:abc");
    await expect(store.consume(nonce, "kaspatest:def")).resolves.toBeNull();
  });

  it("rejects an expired nonce", async () => {
    let now = 1_000_000;
    const store = new InMemoryAuthStore({ now: () => now, ttlMs: 1_000 });
    const { nonce } = await store.create("kaspatest:abc");
    now = 1_000_000 + 2_000;
    await expect(store.consume(nonce, "kaspatest:abc")).resolves.toBeNull();
  });

  it("sweeps stale nonces on create", async () => {
    let now = 1_000_000;
    const store = new InMemoryAuthStore({ now: () => now, ttlMs: 1_000 });
    const stale = await store.create("kaspatest:abc");
    now = 1_000_000 + 5_000;
    await store.create("kaspatest:def");
    const fresh = await store.create("kaspatest:ghi");
    // The stale nonce is gone from the map (the public `consume` API reflects
    // the sweep: it would be null).
    await expect(store.consume(stale.nonce, "kaspatest:abc")).resolves.toBeNull();
    await expect(store.consume(fresh.nonce, "kaspatest:ghi")).resolves.not.toBeNull();
  });
});
