// Issue #2: the site root must preview like an event page.
//
// Slack, X, and other unfurlers read the HTML head without running JavaScript,
// so the tags have to be in the document the server sends for `/`. The event
// shell is covered in event-shell.test.ts; this file owns only the root.

import { describe, expect, it } from "vitest";
import { SHELL_CACHE_CONTROL } from "./docs-paths.js";
import { PREVIEW_ORIGIN } from "./test-share-fixtures.js";
import { withShareApp } from "./test-share-app.js";

describe("home shell (issue #2)", () => {
  it("serves the root with canonical, Open Graph, and Twitter metadata", async () => {
    await withShareApp(async ({ app }) => {
      const home = await app.inject({ method: "GET", url: "/" });

      expect(home.statusCode).toBe(200);
      expect(home.headers["content-type"]).toContain("text/html");
      expect(home.headers["cache-control"]).toBe(SHELL_CACHE_CONTROL);

      expect(home.body).toContain("<title>kticket — tickets on the chain</title>");
      expect(home.body).toContain(`<link rel="canonical" href="${PREVIEW_ORIGIN}/">`);
      expect(home.body).toContain('property="og:type" content="website"');
      expect(home.body).toContain('property="og:site_name" content="kticket"');
      expect(home.body).toContain(`property="og:url" content="${PREVIEW_ORIGIN}/"`);
      expect(home.body).toContain('name="twitter:card" content="summary"');

      // The generic shell tags were replaced, not duplicated.
      expect(home.body.match(/<title/g) ?? []).toHaveLength(1);
      expect(home.body).not.toContain("generic description");

      // It is still the SPA shell that boots the browser app.
      expect(home.body).toContain('<div id="root"></div>');
      expect(home.body).toContain('src="/assets/app.js"');
    });
  });

  it("keeps the SPA fallback for client-side routes", async () => {
    await withShareApp(async ({ app }) => {
      const fallback = await app.inject({ method: "GET", url: "/some/client/route" });

      expect(fallback.statusCode).toBe(200);
      expect(fallback.body).toContain("<title>kticket</title>");
      expect(fallback.body).toContain('<div id="root"></div>');
    });
  });
});
