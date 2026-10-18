// Search-engine discovery (KTK-163).
//
// A sitemap is only useful if it lists pages that exist and can be opened. It
// therefore goes through the same chain verification as the events directory:
// unverified registry rows are hidden, never advertised to crawlers.

import { eventPath } from "@kticket/kit";
import type { VerifiedEvent } from "./provenance.js";

const SITEMAP_HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
const SITEMAP_FOOTER = "</urlset>";

/** Render the sitemap for the verified events, with absolute URLs. */
export function sitemapXml(events: readonly Pick<VerifiedEvent, "covenant_id">[], origin: string): string {
  const base = origin.replace(/\/+$/, "");
  const entries = events.map((event) => {
    const loc = escapeXml(`${base}${eventPath(event.covenant_id)}`);
    return `  <url>\n    <loc>${loc}</loc>\n  </url>`;
  });
  return [SITEMAP_HEADER, ...entries, SITEMAP_FOOTER, ""].join("\n");
}

/**
 * robots.txt points crawlers at the sitemap and keeps per-person surfaces out of
 * the index: check-in links, a wallet's tickets, and the API itself.
 */
export function robotsTxt(origin: string, sitemapPath: string): string {
  const base = origin.replace(/\/+$/, "");
  return [
    "User-agent: *",
    "Allow: /",
    "",
    "Disallow: /gate/",
    "Disallow: /tickets",
    "Disallow: /my-events",
    "Disallow: /v1/",
    "Disallow: /health",
    "",
    `Sitemap: ${base}${sitemapPath}`,
    "",
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
