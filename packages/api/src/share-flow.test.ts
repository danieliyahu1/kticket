// KTK-164: the whole share flow as a black box.
//
// Paste the event link -> a crawler reads the verified preview -> the canonical
// URL loads the SPA -> the buyer's entry point exists -> search can discover it.
// External dependencies are mocked; the app and every route are exercised end
// to end.

import { describe, expect, it, vi } from "vitest";
import { ROBOTS_TXT_PATH, SITEMAP_PATH } from "./docs-paths.js";
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

const CRAWLER = "Mozilla/5.0 (compatible; ChatPreviewBot/1.0)";
const UNKNOWN_COVENANT_ID = "cd".repeat(32);
const EVENT_URL = `/events/${TEST_COVENANT_ID}`;

describe("shared event link (KTK-164)", () => {
  it("previews the verified event and opens the purchase entry point", async () => {
    await withShareApp(async ({ app }) => {
      // A chat crawler asks for the link; it does not run JavaScript.
      const preview = await app.inject({
        method: "GET",
        url: EVENT_URL,
        headers: { "user-agent": CRAWLER },
      });

      expect(preview.statusCode).toBe(200);
      expect(preview.headers["content-type"]).toContain("text/html");
      expect(preview.body).toContain("<title>Testnet Rave — kticket</title>");
      expect(preview.body).toContain('name="description" content="Testnet Rave');
      expect(preview.body).toContain(
        `<link rel="canonical" href="${PREVIEW_ORIGIN}${EVENT_URL}">`,
      );
      expect(preview.body).toContain('property="og:title" content="Testnet Rave — kticket"');
      expect(preview.body).toContain(
        `property="og:url" content="${PREVIEW_ORIGIN}${EVENT_URL}"`,
      );
      expect(preview.body).toContain('name="twitter:card" content="summary"');
      expect(preview.body).toContain('name="twitter:title" content="Testnet Rave — kticket"');

      // The canonical URL resolves to the SPA shell the buyer uses (and the Buy
      // CTA is rendered client-side from the same verified event endpoint).
      const canonical = await app.inject({ method: "GET", url: EVENT_URL });
      expect(canonical.statusCode).toBe(200);
      expect(canonical.body).toContain('<div id="root"></div>');
      expect(canonical.body).toContain('src="/assets/app.js"');

      // The SPA renders the page (and therefore the Buy button) from the JSON
      // read; it must return the same verified facts the preview advertised.
      const facts = await app.inject({ method: "GET", url: `/v1${EVENT_URL}` });
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
        url: `/events/${UNKNOWN_COVENANT_ID}`,
        headers: { "user-agent": CRAWLER },
      });
      expect(unknown.statusCode).toBe(200);
      expect(unknown.body).toContain("<title>kticket — tickets on the chain</title>");
      expect(unknown.body).not.toContain("Testnet Rave");

      // Search can discover the verified event and is pointed at the sitemap.
      const sitemap = await app.inject({ method: "GET", url: SITEMAP_PATH });
      expect(sitemap.statusCode).toBe(200);
      expect(sitemap.body).toContain(`${PREVIEW_ORIGIN}${EVENT_URL}`);

      const robots = await app.inject({ method: "GET", url: ROBOTS_TXT_PATH });
      expect(robots.statusCode).toBe(200);
      expect(robots.body).toContain(`Sitemap: ${PREVIEW_ORIGIN}${SITEMAP_PATH}`);
    });
  });
});
