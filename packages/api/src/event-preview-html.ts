// HTML boundary for shareable page previews (KTK-159, issue #2).
//
// This module turns an `EventMeta` value into the tags a crawler reads. It knows
// nothing about the chain, the registry, or HTTP: that keeps the rendering rules
// small and lets the route layer stay focused on policy.

import { SITE_NAME, type EventMeta } from "@kticket/kit";

const HEAD_CLOSE_INDENT = "  ";
const TAG_INDENT = "    ";

/** Render the metadata block; every value is HTML-escaped exactly once. */
export function renderEventMetaTags(meta: EventMeta): string {
  return [
    `<title>${escapeHtml(meta.title)}</title>`,
    `<meta name="description" content="${escapeHtml(meta.description)}">`,
    `<link rel="canonical" href="${escapeHtml(meta.canonicalUrl)}">`,
    ...openGraphTags(meta),
    ...twitterTags(meta),
  ].join("\n");
}

/**
 * Replace the shell's generic title/description/canonical/preview tags with the
 * resolved set. Removing the originals first keeps a document from carrying two
 * conflicting titles or canonical links.
 */
export function injectEventMeta(shellHtml: string, meta: EventMeta): string {
  const tags = renderEventMetaTags(meta);
  const stripped = stripPreviewTags(shellHtml);

  if (!/<\/head>/i.test(stripped)) return `${tags}\n${stripped}`;
  return stripped.replace(/<\/head>/i, `${indent(tags)}\n${HEAD_CLOSE_INDENT}</head>`);
}

/** Escape text for HTML text nodes and quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function openGraphTags(meta: EventMeta): string[] {
  const tags = [
    '<meta property="og:type" content="website">',
    `<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">`,
    `<meta property="og:title" content="${escapeHtml(meta.title)}">`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}">`,
    `<meta property="og:url" content="${escapeHtml(meta.canonicalUrl)}">`,
  ];
  if (meta.imageUrl) {
    tags.push(`<meta property="og:image" content="${escapeHtml(meta.imageUrl)}">`);
    tags.push(`<meta property="og:image:alt" content="${escapeHtml(meta.title)}">`);
  }
  return tags;
}

function twitterTags(meta: EventMeta): string[] {
  const tags = [
    `<meta name="twitter:card" content="${meta.twitterCard}">`,
    `<meta name="twitter:title" content="${escapeHtml(meta.title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(meta.description)}">`,
  ];
  if (meta.imageUrl) {
    tags.push(`<meta name="twitter:image" content="${escapeHtml(meta.imageUrl)}">`);
  }
  return tags;
}

/** Remove only the tags this module owns; unrelated head content is preserved. */
function stripPreviewTags(html: string): string {
  return html
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, "")
    .replace(/<meta\b[^>]*\bname=["']description["'][^>]*>/gi, "")
    .replace(/<link\b[^>]*\brel=["']canonical["'][^>]*>/gi, "")
    .replace(/<meta\b[^>]*\bproperty=["']og:[^"']+["'][^>]*>/gi, "")
    .replace(/<meta\b[^>]*\bname=["']twitter:[^"']+["'][^>]*>/gi, "");
}

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => `${TAG_INDENT}${line}`)
    .join("\n");
}
