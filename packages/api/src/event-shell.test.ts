// KTK-159 / KTK-160: the event shell must show verified facts to a client that
// never runs JavaScript, and must never block or leak an unverified value.
//
// The chain is mocked (FakeKaspa + canned compiler artifacts); the app, the
// verification policy, and the HTML rendering are the real code under test.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { p2pkAddress } from "@kticket/kit";
import { hexToBytes } from "@noble/hashes/utils.js";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { EVENT_SHELL_CACHE_CONTROL } from "./docs-paths.js";
import { EventStore } from "./eventstore.js";
import {
  escapeHtml,
  injectEventMeta,
  renderEventMetaTags,
  resolveEventMeta,
  type EventShellContext,
} from "./event-shell.js";
import { ListingStoreFile } from "./listings.js";
import type { VerifiedEvent } from "./provenance.js";
import {
  FakeKaspa,
  G_ID,
  NETWORK,
  ORG_PKH_HEX,
  TEST_COVENANT_ID,
  eventArtifact,
  seedBaseChain,
} from "./test-chain.js";
import { VerifiedEventCache } from "./verified-cache.js";

vi.mock("./wrpc-client.js", () => ({
  submitTransactionOverWrpc: vi.fn(),
}));

vi.mock("./compiler.js", async () => {
  const { createCompilerMock } = await import("./test-artifacts.js");
  return createCompilerMock();
});

const ORIGIN = "https://kticket.example.com";
const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="description" content="generic description" />
    <title>kticket</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/assets/app.js"></script>
  </body>
</html>
`;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function spaDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "kticket-shell-"));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, "index.html"), SHELL);
  return directory;
}

interface ShellApp {
  app: FastifyInstance;
  kaspa: FakeKaspa;
  events: EventStore;
}

async function withShellApp(
  run: (harness: ShellApp) => Promise<void>,
  options: { verified?: VerifiedEventCache } = {},
): Promise<void> {
  const kaspa = new FakeKaspa();
  seedBaseChain(kaspa);
  const events = new EventStore();
  await events.register({
    covenantId: TEST_COVENANT_ID,
    deployTxId: G_ID,
    organizerAddress: p2pkAddress(hexToBytes(ORG_PKH_HEX), NETWORK),
  });

  const app = await buildApp(
    loadConfig({
      KASPANET: NETWORK,
      AUTH_SECRET: "test-secret-for-kticket-api",
      PUBLIC_ORIGIN: ORIGIN,
    }),
    {
      kaspa,
      events,
      listings: new ListingStoreFile(),
      network: NETWORK,
      networkId: "testnet-10",
      verified: options.verified ?? new VerifiedEventCache(),
    },
    { serveStatic: spaDirectory() },
  );

  try {
    await run({ app, kaspa, events });
  } finally {
    await app.close();
  }
}

describe("event shell (KTK-159)", () => {
  it("serves the verified event's metadata to a non-JavaScript client", async () => {
    await withShellApp(async ({ app }) => {
      const response = await app.inject({ method: "GET", url: `/events/${TEST_COVENANT_ID}` });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.headers["cache-control"]).toBe(EVENT_SHELL_CACHE_CONTROL);

      const html = response.body;
      expect(html).toContain("<title>Testnet Rave — kticket</title>");
      expect(html).toContain('name="description" content="Testnet Rave — 31 December 2026');
      expect(html).toContain(
        `<link rel="canonical" href="${ORIGIN}/events/${TEST_COVENANT_ID}">`,
      );
      expect(html).toContain('property="og:title" content="Testnet Rave — kticket"');
      expect(html).toContain(`property="og:url" content="${ORIGIN}/events/${TEST_COVENANT_ID}"`);
      expect(html).toContain('name="twitter:card" content="summary"');
      expect(html).toContain('name="twitter:title" content="Testnet Rave — kticket"');

      // The shell still boots the real SPA and carries exactly one title.
      expect(html).toContain('<div id="root"></div>');
      expect(html).toContain("src=\"/assets/app.js\"");
      expect(html.match(/<title/g) ?? []).toHaveLength(1);
      // The generic description was replaced, not duplicated.
      expect(html).not.toContain("generic description");
    });
  });

  it("returns generic metadata with 200 for an unknown event", async () => {
    await withShellApp(async ({ app }) => {
      const response = await app.inject({ method: "GET", url: `/events/${"cd".repeat(32)}` });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("<title>kticket — tickets on the chain</title>");
      expect(response.body).toContain(`<link rel="canonical" href="${ORIGIN}/">`);
      expect(response.body).not.toContain("Testnet Rave");
      expect(response.body).toContain('<div id="root"></div>');
    });
  });

  it("returns generic metadata for a registry entry that fails verification", async () => {
    await withShellApp(async ({ app, events }) => {
      const bogusCovenantId = "ef".repeat(32);
      await events.register({
        covenantId: bogusCovenantId,
        deployTxId: "12".repeat(32),
        organizerAddress: "kaspatest:not-a-real-event",
      });

      const response = await app.inject({ method: "GET", url: `/events/${bogusCovenantId}` });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("<title>kticket — tickets on the chain</title>");
      expect(response.body).not.toContain("Testnet Rave");
    });
  });

  it("returns generic metadata when the chain is unavailable", async () => {
    await withShellApp(async ({ app, kaspa }) => {
      kaspa.getTransaction = async () => {
        throw new Error("upstream unavailable");
      };

      const response = await app.inject({ method: "GET", url: `/events/${TEST_COVENANT_ID}` });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("<title>kticket — tickets on the chain</title>");
      expect(response.body).not.toContain("Testnet Rave");
    });
  });

  it("escapes verified values before injecting them into HTML", async () => {
    const crafted = {
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
    } satisfies VerifiedEvent;

    const verified = new VerifiedEventCache();
    verified.verify = async () => crafted;

    await withShellApp(
      async ({ app }) => {
        const response = await app.inject({ method: "GET", url: `/events/${TEST_COVENANT_ID}` });

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
    const meta = await resolveEventMeta(ctx, TEST_COVENANT_ID, ORIGIN, 20);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(meta.canonicalUrl).toBe(`${ORIGIN}/`);
  });
});

describe("metadata rendering (KTK-160)", () => {
  it("renders every preview tag once and escapes each value", () => {
    const tags = renderEventMetaTags({
      title: 'A & B <"C">',
      description: "One & two",
      canonicalUrl: `${ORIGIN}/events/x?a=1&b=2`,
      imageUrl: `${ORIGIN}/img.png?a=1&b=2`,
      twitterCard: "summary_large_image",
    });

    expect(tags).toContain("<title>A &amp; B &lt;&quot;C&quot;&gt;</title>");
    expect(tags).toContain('content="One &amp; two"');
    expect(tags).toContain('href="https://kticket.example.com/events/x?a=1&amp;b=2"');
    expect(tags).toContain('property="og:image" content="https://kticket.example.com/img.png?a=1&amp;b=2"');
    expect(tags).toContain('name="twitter:card" content="summary_large_image"');
  });

  it("replaces stale tags instead of accumulating them", () => {
    const html = injectEventMeta(
      `<!doctype html><html><head><title>old</title>
<meta name="description" content="old">
<link rel="canonical" href="https://old.example.com/events/1">
<meta property="og:title" content="old">
<meta name="twitter:card" content="summary">
</head><body></body></html>`,
      {
        title: "New",
        description: "New description",
        canonicalUrl: `${ORIGIN}/events/1`,
        twitterCard: "summary",
      },
    );

    expect(html.match(/<title/g) ?? []).toHaveLength(1);
    expect(html.match(/rel="canonical"/g) ?? []).toHaveLength(1);
    expect(html.match(/property="og:title"/g) ?? []).toHaveLength(1);
    expect(html).toContain("<title>New</title>");
    expect(html).not.toContain("old");
  });

  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});
