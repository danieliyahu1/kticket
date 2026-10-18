// KTK-163: search engines can discover every verified event and nothing else.
// The chain is mocked; the sitemap, the policy text, and the verification path
// are the real code under test.

import { p2pkAddress } from "@kticket/kit";
import { hexToBytes } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { robotsTxt, sitemapXml } from "./discovery.js";
import { DISCOVERY_CACHE_CONTROL, ROBOTS_TXT_PATH, SITEMAP_PATH } from "./docs-paths.js";
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
const apps: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function discoveryApp(extraEntry?: { covenantId: string; deployTxId: string }): Promise<
  Awaited<ReturnType<typeof buildApp>>
> {
  const kaspa = new FakeKaspa();
  seedBaseChain(kaspa);
  const events = new EventStore();
  await events.register({
    covenantId: TEST_COVENANT_ID,
    deployTxId: G_ID,
    organizerAddress: p2pkAddress(hexToBytes(ORG_PKH_HEX), NETWORK),
  });
  if (extraEntry) {
    await events.register({
      ...extraEntry,
      organizerAddress: p2pkAddress(hexToBytes(ORG_PKH_HEX), NETWORK),
    });
  }

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
  );
  apps.push(app);
  return app;
}

describe("sitemap generation", () => {
  it("lists absolute event URLs", () => {
    const xml = sitemapXml(
      [{ covenant_id: "aa" }, { covenant_id: "bb" }],
      "https://kticket.example.com/",
    );

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain("<loc>https://kticket.example.com/events/aa</loc>");
    expect(xml).toContain("<loc>https://kticket.example.com/events/bb</loc>");
    expect(xml.trimEnd().endsWith("</urlset>")).toBe(true);
  });

  it("encodes ids so the XML cannot be injected and handles an empty directory", () => {
    const xml = sitemapXml([{ covenant_id: "a&b" }], ORIGIN);
    expect(xml).toContain("<loc>https://kticket.example.com/events/a%26b</loc>");
    expect(xml).not.toContain("a&b");
    expect(sitemapXml([], ORIGIN)).toContain("</urlset>");
    expect(sitemapXml([], ORIGIN)).not.toContain("<url>");
  });
});

describe("robots policy", () => {
  it("points at the sitemap and excludes per-person and API surfaces", () => {
    const text = robotsTxt(ORIGIN, SITEMAP_PATH);

    expect(text).toContain("User-agent: *");
    expect(text).toContain(`Sitemap: ${ORIGIN}${SITEMAP_PATH}`);
    for (const path of ["/gate/", "/tickets", "/my-events", "/v1/", "/health"]) {
      expect(text, path).toContain(`Disallow: ${path}`);
    }
  });
});

describe("discovery routes (KTK-163)", () => {
  it("serves a sitemap containing only verified events", async () => {
    const app = await discoveryApp({
      covenantId: "ef".repeat(32),
      deployTxId: "12".repeat(32),
    });

    const response = await app.inject({ method: "GET", url: SITEMAP_PATH });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/xml");
    expect(response.headers["cache-control"]).toBe(DISCOVERY_CACHE_CONTROL);
    expect(response.body).toContain(`${ORIGIN}/events/${TEST_COVENANT_ID}`);
    // The poisoned registry row never reaches a crawler.
    expect(response.body).not.toContain("ef".repeat(32));
  });

  it("serves robots.txt as plain text", async () => {
    const app = await discoveryApp();

    const response = await app.inject({ method: "GET", url: ROBOTS_TXT_PATH });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain(`Sitemap: ${ORIGIN}${SITEMAP_PATH}`);
  });
});
