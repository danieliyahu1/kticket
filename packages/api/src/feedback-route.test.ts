// The public feedback endpoint: anonymous, write-ahead, honest about delivery,
// and rate-limited per client.

import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { EventStore } from "./eventstore.js";
import {
  FeedbackService,
  MemoryFeedbackOutbox,
  type FeedbackOutbox,
} from "./feedback.js";
import { ListingStoreFile } from "./listings.js";
import { FakeKaspa, NETWORK } from "./test-chain.js";
import { VerifiedEventCache } from "./verified-cache.js";

const cleanup: (() => Promise<void>)[] = [];

async function appWith(outbox: FeedbackOutbox, delivery: "ok" | "fail" | "disabled") {
  const feedback = new FeedbackService({
    outbox,
    deliverer: {
      enabled: delivery !== "disabled",
      deliver:
        delivery === "fail"
          ? async () => {
              throw new Error("Telegram is down");
            }
          : async () => {},
    },
  });
  const app = await buildApp(
    loadConfig({ KASPANET: NETWORK, AUTH_SECRET: "test-secret-for-kticket-api" }),
    {
      kaspa: new FakeKaspa(),
      events: new EventStore(),
      listings: new ListingStoreFile(),
      network: NETWORK,
      networkId: "testnet-10",
      verified: new VerifiedEventCache(),
      feedback,
    },
  );
  await app.ready();
  cleanup.push(() => app.close());
  return app;
}

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});

describe("POST /v1/feedback", () => {
  it("accepts an anonymous note and reports when it was delivered", async () => {
    const outbox = new MemoryFeedbackOutbox();
    const app = await appWith(outbox, "ok");

    const response = await app.inject({
      method: "POST",
      url: "/v1/feedback",
      payload: { message: "  The check-in page was confusing.  " },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true, delivered: true });
    expect(await outbox.pendingCount()).toBe(0);
  });

  it("returns 202 with delivered:false when the note is only queued", async () => {
    const outbox = new MemoryFeedbackOutbox();
    const app = await appWith(outbox, "fail");

    const response = await app.inject({
      method: "POST",
      url: "/v1/feedback",
      payload: { message: "Please keep this" },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true, delivered: false });
    expect(await outbox.pendingCount()).toBe(1);
  });

  it("still accepts while Telegram is not configured", async () => {
    const outbox = new MemoryFeedbackOutbox();
    const app = await appWith(outbox, "disabled");

    const response = await app.inject({
      method: "POST",
      url: "/v1/feedback",
      payload: { message: "No bot yet" },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true, delivered: false });
    expect(await outbox.pendingCount()).toBe(1);
  });

  it("rejects an empty or oversized message with the shared error envelope", async () => {
    const app = await appWith(new MemoryFeedbackOutbox(), "ok");

    const empty = await app.inject({
      method: "POST",
      url: "/v1/feedback",
      payload: { message: "   " },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ error: { type: "invalid", retryable: false } });

    const oversized = await app.inject({
      method: "POST",
      url: "/v1/feedback",
      payload: { message: "x".repeat(1501) },
    });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json()).toMatchObject({ error: { type: "invalid" } });
  });

  it("rate-limits a client after five submissions per window", async () => {
    const app = await appWith(new MemoryFeedbackOutbox(), "disabled");
    const send = () =>
      app.inject({
        method: "POST",
        url: "/v1/feedback",
        headers: { "x-forwarded-for": "203.0.113.7" },
        payload: { message: "hello" },
      });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await send()).statusCode).toBe(202);
    }

    const refused = await send();
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    expect(refused.json()).toMatchObject({
      error: { type: "policy", retryable: true },
    });
  });
});
