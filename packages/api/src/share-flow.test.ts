// KTK-164: the whole share flow as a black box.
//
// Paste the event link -> a crawler reads the verified preview -> the canonical
// URL loads the SPA -> the buyer's entry point exists -> search can discover it.
// External dependencies are mocked (FakeKaspa + canned compiler artifacts); the
// app and every route are exercised end to end.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { p2pkAddress } from "@kticket/kit";
import { hexToBytes } from "@noble/hashes/utils.js";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { ROBOTS_TXT_PATH, SITEMAP_PATH } from "./docs-paths.js";
import { EventStore } from "./eventstore.js";
import { ListingStoreFile } from "./listings.js";
import {
  FakeKaspa,
  G_ID,
  NETWORK,
  ORG_PKH_HEX,
  TEST_COVENANT_ID,
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
const CRAWLER = "Mozilla/5.0 (compatible; ChatPreviewBot/1.0)";
const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="description" content="Tickets on the chain." />
    <title>kticket</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/assets/index.js"></script>
  </body>
</html>
`;

const temporaryDirectories: string[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function sharedLinkApp(): Promise<FastifyInstance> {
  const directory = mkdtempSync(join(tmpdir(), "kticket-share-"));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, "index.html"), SHELL);

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
      verified: new VerifiedEventCache(),
    },
    { serveStatic: directory },
  );
  apps.push(app);
  return app;
}

describe("shared event link (KTK-164)", () => {
  it("previews the verified event and opens the purchase entry point", async () => {
    const app = await sharedLinkApp();
    const eventUrl = `/events/${TEST_COVENANT_ID}`;

    // A chat crawler asks for the link; it does not run JavaScript.
    const preview = await app.inject({
      method: "GET",
      url: eventUrl,
      headers: { "user-agent": CRAWLER },
    });

    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-type"]).toContain("text/html");
    expect(preview.body).toContain("<title>Testnet Rave — kticket</title>");
    expect(preview.body).toContain('name="description" content="Testnet Rave');
    expect(preview.body).toContain(
      `<link rel="canonical" href="${ORIGIN}${eventUrl}">`,
    );
    expect(preview.body).toContain('property="og:title" content="Testnet Rave — kticket"');
    expect(preview.body).toContain(`property="og:url" content="${ORIGIN}${eventUrl}"`);
    expect(preview.body).toContain('name="twitter:card" content="summary"');
    expect(preview.body).toContain('name="twitter:title" content="Testnet Rave — kticket"');

    // The canonical URL resolves to the SPA shell the buyer uses (and the Buy
    // CTA is rendered client-side from the same verified event endpoint).
    const canonical = await app.inject({ method: "GET", url: eventUrl });
    expect(canonical.statusCode).toBe(200);
    expect(canonical.body).toContain('<div id="root"></div>');
    expect(canonical.body).toContain("src=\"/assets/index.js\"");

    // The SPA renders the page (and therefore the Buy button) from the JSON
    // read; it must return the same verified facts the preview advertised.
    const facts = await app.inject({ method: "GET", url: `/v1${eventUrl}` });
    expect(facts.statusCode).toBe(200);
    const factsBody = facts.json() as { event: unknown };
    expect(factsBody.event).toMatchObject({
      covenant_id: TEST_COVENANT_ID,
      name: "Testnet Rave",
      verified: true,
    });

    // An unknown link never fails a preview: generic metadata, 200.
    const unknown = await app.inject({
      method: "GET",
      url: `/events/${"cd".repeat(32)}`,
      headers: { "user-agent": CRAWLER },
    });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.body).toContain("<title>kticket — tickets on the chain</title>");
    expect(unknown.body).not.toContain("Testnet Rave");

    // Search can discover the verified event and is pointed at the sitemap.
    const sitemap = await app.inject({ method: "GET", url: SITEMAP_PATH });
    expect(sitemap.statusCode).toBe(200);
    expect(sitemap.body).toContain(`${ORIGIN}${eventUrl}`);

    const robots = await app.inject({ method: "GET", url: ROBOTS_TXT_PATH });
    expect(robots.statusCode).toBe(200);
    expect(robots.body).toContain(`Sitemap: ${ORIGIN}${SITEMAP_PATH}`);
  });
});
