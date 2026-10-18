// KTK-159 / KTK-160: the event shell must show verified facts to a client that
// never runs JavaScript, and must never block or leak an unverified value.
//
// The chain is mocked (FakeKaspa + canned compiler artifacts); the app, the
// verification policy, and the HTTP route are the real code under test. The
// HTML rendering itself is covered in event-preview-html.test.ts.

import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { EVENT_SHELL_CACHE_CONTROL } from "./docs-paths.js";
import { resolveEventMeta, type EventShellContext } from "./event-shell.js";
import type { VerifiedEvent } from "./provenance.js";
import {
  FakeKaspa,
  G_ID,
  NETWORK,
  ORG_PKH_HEX,
  TEST_COVENANT_ID,
  eventArtifact,
} from "./test-chain.js";
import { PREVIEW_ORIGIN } from "./test-share-fixtures.js";
import { withShareApp } from "./test-share-app.js";
import { VerifiedEventCache } from "./verified-cache.js";

vi.mock("./wrpc-client.js", () => ({
  submitTransactionOverWrpc: vi.fn(),
}));

vi.mock("./compiler.js", async () => {
  const { createCompilerMock } = await import("./test-artifacts.js");
  return createCompilerMock();
});

const UNKNOWN_COVENANT_ID = "cd".repeat(32);
const UNVERIFIED_COVENANT_ID = "ef".repeat(32);

function requestEvent(app: FastifyInstance, covenantId: string) {
  return app.inject({ method: "GET", url: `/events/${covenantId}` });
}

describe("event shell (KTK-159)", () => {
  it("serves the verified event's metadata to a non-JavaScript client", async () => {
    await withShareApp(async ({ app }) => {
      const response = await requestEvent(app, TEST_COVENANT_ID);

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.headers["cache-control"]).toBe(EVENT_SHELL_CACHE_CONTROL);

      const html = response.body;
      expect(html).toContain("<title>Testnet Rave — kticket</title>");
      expect(html).toContain('name="description" content="Testnet Rave — 31 December 2026');
      expect(html).toContain(
        `<link rel="canonical" href="${PREVIEW_ORIGIN}/events/${TEST_COVENANT_ID}">`,
      );
      expect(html).toContain('property="og:title" content="Testnet Rave — kticket"');
      expect(html).toContain(
        `property="og:url" content="${PREVIEW_ORIGIN}/events/${TEST_COVENANT_ID}"`,
      );
      expect(html).toContain('name="twitter:card" content="summary"');
      expect(html).toContain('name="twitter:title" content="Testnet Rave — kticket"');

      // The shell still boots the real SPA and carries exactly one title.
      expect(html).toContain('<div id="root"></div>');
      expect(html).toContain('src="/assets/app.js"');
      expect(html.match(/<title/g) ?? []).toHaveLength(1);
      // The generic description was replaced, not duplicated.
      expect(html).not.toContain("generic description");
    });
  });

  it("returns generic metadata with 200 for an unknown event", async () => {
    await withShareApp(async ({ app }) => {
      const response = await requestEvent(app, UNKNOWN_COVENANT_ID);

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("<title>kticket — tickets on the chain</title>");
      expect(response.body).toContain(`<link rel="canonical" href="${PREVIEW_ORIGIN}/">`);
      expect(response.body).not.toContain("Testnet Rave");
      expect(response.body).toContain('<div id="root"></div>');
    });
  });

  it("returns generic metadata for a registry entry that fails verification", async () => {
    await withShareApp(
      async ({ app }) => {
        const response = await requestEvent(app, UNVERIFIED_COVENANT_ID);

        expect(response.statusCode).toBe(200);
        expect(response.body).toContain("<title>kticket — tickets on the chain</title>");
        expect(response.body).not.toContain("Testnet Rave");
      },
      {
        seedRegistry: async (events) => {
          await events.register({
            covenantId: UNVERIFIED_COVENANT_ID,
            deployTxId: "12".repeat(32),
            organizerAddress: "kaspatest:not-a-real-event",
          });
        },
      },
    );
  });

  it("returns generic metadata when the chain is unavailable", async () => {
    await withShareApp(async ({ app, kaspa }) => {
      kaspa.getTransaction = async () => {
        throw new Error("upstream unavailable");
      };

      const response = await requestEvent(app, TEST_COVENANT_ID);

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("<title>kticket — tickets on the chain</title>");
      expect(response.body).not.toContain("Testnet Rave");
    });
  });

  it("escapes verified values before injecting them into HTML", async () => {
    const verified = new VerifiedEventCache();
    verified.verify = async () => craftedEvent();

    await withShareApp(
      async ({ app }) => {
        const response = await requestEvent(app, TEST_COVENANT_ID);

        expect(response.statusCode).toBe(200);
        expect(response.body).not.toContain("<script>alert");
        expect(response.body).toContain(
          "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co",
        );
      },
      { verified },
    );
  });

  it("does not wait indefinitely for a slow chain", async () => {
    const ctx: EventShellContext = {
      kaspa: new FakeKaspa(),
      network: NETWORK,
      events: {
        byCovenantId: () => ({
          covenantId: TEST_COVENANT_ID,
          deployTxId: G_ID,
          organizerAddress: "kaspatest:org",
        }),
      },
      verified: { verify: () => new Promise<VerifiedEvent>(() => {}) },
    };

    const started = Date.now();
    const meta = await resolveEventMeta(ctx, TEST_COVENANT_ID, {
      origin: PREVIEW_ORIGIN,
      deadlineMs: 20,
    });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(meta.canonicalUrl).toBe(`${PREVIEW_ORIGIN}/`);
  });
});

function craftedEvent(): VerifiedEvent {
  return {
    covenant_id: TEST_COVENANT_ID,
    deploy_txid: G_ID,
    name: '<script>alert("x")</script> & Co',
    date: "2026-12-31",
    time: "20:00",
    ticker: "",
    decimals: 0,
    image: "",
    image_hash: "",
    price: 1_000,
    capacity: 2,
    organizer_address: "kaspatest:org",
    owner_pkh: ORG_PKH_HEX,
    org_spk: "",
    burn_template_hash: "",
    authorizing_txid: "",
    raw_chain: {} as VerifiedEvent["raw_chain"],
    artifact: eventArtifact(),
  };
}
