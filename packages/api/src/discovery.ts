// Search-engine discovery (KTK-163).
//
// A sitemap is only useful if it lists pages that exist and can be opened. It
// therefore goes through the same chain verification as the events directory:
// unverified registry rows are hidden, never advertised to crawlers.

import { eventPath } from "@kticket/kit";
import { API_DOCS_PATH, LLMS_TXT_PATH, OPENAPI_PATH } from "./docs-paths.js";
import type { VerifiedEvent } from "./provenance.js";

const SITEMAP_HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
const SITEMAP_FOOTER = "</urlset>";

/** Per-person and machine surfaces that must not be indexed. */
const PRIVATE_PATHS = ["/gate/", "/tickets", "/my-events", "/v1/", "/health"];

/** Render the sitemap for the verified events plus the public API reference. */
export function sitemapXml(
  events: readonly Pick<VerifiedEvent, "covenant_id">[],
  origin: string,
): string {
  const base = origin.replace(/\/+$/, "");
  const entries = [
    `  <url>\n    <loc>${escapeXml(`${base}${API_DOCS_PATH}`)}</loc>\n  </url>`,
    ...events.map((event) => {
      const loc = escapeXml(`${base}${eventPath(event.covenant_id)}`);
      return `  <url>\n    <loc>${loc}</loc>\n  </url>`;
    }),
  ];
  return [SITEMAP_HEADER, ...entries, SITEMAP_FOOTER, ""].join("\n");
}

/**
 * robots.txt points crawlers at the sitemap and the agent entry point, and
 * keeps per-person surfaces out of the index: check-in links, a wallet's
 * tickets, and the API operations. The contract and its reference stay
 * discoverable because they are the public product surface.
 */
export function robotsTxt(origin: string, sitemapPath: string): string {
  const base = origin.replace(/\/+$/, "");
  return [
    "User-agent: *",
    "Allow: /",
    `Allow: ${API_DOCS_PATH}`,
    `Allow: ${OPENAPI_PATH}`,
    "",
    ...PRIVATE_PATHS.map((path) => `Disallow: ${path}`),
    "",
    `# Agents: ${base}${LLMS_TXT_PATH}`,
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
