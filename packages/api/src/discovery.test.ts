// KTK-163: search engines can discover every verified event and nothing else.
// The chain is mocked; the sitemap, the policy text, and the verification path
// are the real code under test.

import { describe, expect, it, vi } from "vitest";
import { robotsTxt, sitemapXml } from "./discovery.js";
import { DISCOVERY_CACHE_CONTROL, ROBOTS_TXT_PATH, SITEMAP_PATH } from "./docs-paths.js";
import { TEST_COVENANT_ID } from "./test-chain.js";
import { PREVIEW_ORIGIN } from "./test-share-fixtures.js";
import { withShareApp } from "./test-share-app.js";

vi.mock("./wrpc-client.js", () => ({
  submitTransactionOverWrpc: vi.fn(),
}));

vi.mock("./compiler.js", async () => {
  const { createCompilerMock } = await import("./test-artifacts.js");
  return createCompilerMock();
});

const UNVERIFIED_COVENANT_ID = "ef".repeat(32);

describe("sitemap generation", () => {
  it("lists absolute event URLs", () => {
    const xml = sitemapXml(
      [{ covenant_id: "aa" }, { covenant_id: "bb" }],
      `${PREVIEW_ORIGIN}/`,
    );

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain(`<loc>${PREVIEW_ORIGIN}/events/aa</loc>`);
    expect(xml).toContain(`<loc>${PREVIEW_ORIGIN}/events/bb</loc>`);
    expect(xml.trimEnd().endsWith("</urlset>")).toBe(true);
  });

  it("encodes ids so the XML cannot be injected and handles an empty directory", () => {
    const xml = sitemapXml([{ covenant_id: "a&b" }], PREVIEW_ORIGIN);

    expect(xml).toContain(`<loc>${PREVIEW_ORIGIN}/events/a%26b</loc>`);
    expect(xml).not.toContain("a&b");
    expect(sitemapXml([], PREVIEW_ORIGIN)).toContain("</urlset>");
    expect(sitemapXml([], PREVIEW_ORIGIN)).not.toContain("<url>");
  });
});

describe("robots policy", () => {
  it("points at the sitemap and excludes per-person and API surfaces", () => {
    const text = robotsTxt(PREVIEW_ORIGIN, SITEMAP_PATH);

    expect(text).toContain("User-agent: *");
    expect(text).toContain(`Sitemap: ${PREVIEW_ORIGIN}${SITEMAP_PATH}`);
    for (const path of ["/gate/", "/tickets", "/my-events", "/v1/", "/health"]) {
      expect(text, path).toContain(`Disallow: ${path}`);
    }
  });
});

describe("discovery routes (KTK-163)", () => {
  it("serves a sitemap containing only verified events", async () => {
    await withShareApp(
      async ({ app }) => {
        const response = await app.inject({ method: "GET", url: SITEMAP_PATH });

        expect(response.statusCode).toBe(200);
        expect(response.headers["content-type"]).toContain("application/xml");
        expect(response.headers["cache-control"]).toBe(DISCOVERY_CACHE_CONTROL);
        expect(response.body).toContain(`${PREVIEW_ORIGIN}/events/${TEST_COVENANT_ID}`);
        // The poisoned registry row never reaches a crawler.
        expect(response.body).not.toContain(UNVERIFIED_COVENANT_ID);
      },
      {
        spaShell: null,
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

  it("serves robots.txt as plain text", async () => {
    await withShareApp(
      async ({ app }) => {
        const response = await app.inject({ method: "GET", url: ROBOTS_TXT_PATH });

        expect(response.statusCode).toBe(200);
        expect(response.headers["content-type"]).toContain("text/plain");
        expect(response.body).toContain(`Sitemap: ${PREVIEW_ORIGIN}${SITEMAP_PATH}`);
      },
      { spaShell: null },
    );
  });
});
