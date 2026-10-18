import { describe, expect, it } from "vitest";
import { escapeHtml, injectEventMeta, renderEventMetaTags } from "./event-preview-html.js";
import { PREVIEW_ORIGIN, SPA_SHELL_HTML } from "./test-share-fixtures.js";

describe("event preview HTML (KTK-160)", () => {
  it("renders every preview tag once and escapes each value", () => {
    const tags = renderEventMetaTags({
      title: 'A & B <"C">',
      description: "One & two",
      canonicalUrl: `${PREVIEW_ORIGIN}/events/x?a=1&b=2`,
      imageUrl: `${PREVIEW_ORIGIN}/img.png?a=1&b=2`,
      twitterCard: "summary_large_image",
    });

    expect(tags).toContain("<title>A &amp; B &lt;&quot;C&quot;&gt;</title>");
    expect(tags).toContain('content="One &amp; two"');
    expect(tags).toContain('href="https://kticket.example.com/events/x?a=1&amp;b=2"');
    expect(tags).toContain(
      'property="og:image" content="https://kticket.example.com/img.png?a=1&amp;b=2"',
    );
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
        canonicalUrl: `${PREVIEW_ORIGIN}/events/1`,
        twitterCard: "summary",
      },
    );

    expect(html.match(/<title/g) ?? []).toHaveLength(1);
    expect(html.match(/rel="canonical"/g) ?? []).toHaveLength(1);
    expect(html.match(/property="og:title"/g) ?? []).toHaveLength(1);
    expect(html).toContain("<title>New</title>");
    expect(html).not.toContain("old");
  });

  it("leaves the SPA shell intact when injecting metadata", () => {
    const html = injectEventMeta(SPA_SHELL_HTML, {
      title: "New",
      description: "New description",
      canonicalUrl: `${PREVIEW_ORIGIN}/events/1`,
      twitterCard: "summary",
    });

    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('src="/assets/app.js"');
  });

  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});
