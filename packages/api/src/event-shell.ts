// The shareable event shell (KTK-159).
//
// `/events/:covenantId` is a real page for people and a real document for
// crawlers. The API serves the built SPA's index.html with per-event metadata
// injected, built from chain-verified facts by the shared pure builder. A
// crawler that never runs JavaScript still sees the event name, date, price,
// canonical URL, and preview tags.
//
// Safety rules:
//   - only verified facts reach the metadata (never a registry row or payload);
//   - a missing, unverified, or unreachable event returns HTTP 200 with the
//     generic site metadata, so a preview can never block the page;
//   - the chain read is bounded, so a slow node delays HTML by at most the
//     deadline and the verified cache is the only chain path used.

import {
  buildEventMeta,
  buildGenericMeta,
  SITE_NAME,
  type EventMeta,
} from "@kticket/kit";
import type { FastifyInstance } from "fastify";
import type { KaspaNetwork } from "@kticket/kit";
import type { EventRegistry } from "./eventstore.js";
import { EVENT_SHELL_CACHE_CONTROL } from "./docs-paths.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import type { VerifiedEventCache } from "./verified-cache.js";

/** How long the shell may wait for chain verification before falling back. */
export const SHELL_DEADLINE_MS = 1_500;

const HTML_CONTENT_TYPE = "text/html; charset=utf-8";

export interface EventShellContext {
  kaspa: KaspaClientLike;
  network: KaspaNetwork;
  events: Pick<EventRegistry, "byCovenantId">;
  verified: Pick<VerifiedEventCache, "verify">;
}

export interface EventShellOptions {
  /** Absolute origin used for canonical and preview URLs. */
  origin: string;
  /** The built SPA shell (`index.html`). */
  shellHtml: string;
  deadlineMs?: number;
}

interface ShellLogger {
  warn: (fields: Record<string, unknown>, message: string) => void;
}

export function registerEventShell(
  app: FastifyInstance,
  ctx: EventShellContext,
  options: EventShellOptions,
): void {
  const deadlineMs = options.deadlineMs ?? SHELL_DEADLINE_MS;

  app.get<{ Params: { covenantId: string } }>("/events/:covenantId", async (req, reply) => {
    const meta = await resolveEventMeta(
      ctx,
      req.params.covenantId,
      options.origin,
      deadlineMs,
      req.log,
    );
    return reply
      .header("cache-control", EVENT_SHELL_CACHE_CONTROL)
      .header("content-type", HTML_CONTENT_TYPE)
      .send(injectEventMeta(options.shellHtml, meta));
  });
}

/**
 * Resolve the metadata for one event. Missing registry entries never touch the
 * chain; verification failures and deadline overruns fall back to the generic
 * site metadata. Exported so the fallback policy is testable without HTTP.
 */
export async function resolveEventMeta(
  ctx: EventShellContext,
  covenantId: string,
  origin: string,
  deadlineMs: number = SHELL_DEADLINE_MS,
  logger?: ShellLogger,
): Promise<EventMeta> {
  const entry = ctx.events.byCovenantId(covenantId);
  if (!entry) return buildGenericMeta(origin);

  try {
    const verified = await withDeadline(
      ctx.verified.verify(ctx.kaspa, ctx.network, entry.deployTxId),
      deadlineMs,
    );
    return buildEventMeta(verified, origin);
  } catch (err) {
    logger?.warn(
      {
        covenant_id: covenantId,
        reason: err instanceof Error ? err.message : "unknown",
      },
      "event shell served generic metadata",
    );
    return buildGenericMeta(origin);
  }
}

/** Render the metadata block; every value is HTML-escaped exactly once. */
export function renderEventMetaTags(meta: EventMeta): string {
  const tags = [
    `<title>${escapeHtml(meta.title)}</title>`,
    `<meta name="description" content="${escapeHtml(meta.description)}">`,
    `<link rel="canonical" href="${escapeHtml(meta.canonicalUrl)}">`,
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
  tags.push(`<meta name="twitter:card" content="${meta.twitterCard}">`);
  tags.push(`<meta name="twitter:title" content="${escapeHtml(meta.title)}">`);
  tags.push(`<meta name="twitter:description" content="${escapeHtml(meta.description)}">`);
  if (meta.imageUrl) {
    tags.push(`<meta name="twitter:image" content="${escapeHtml(meta.imageUrl)}">`);
  }
  return tags.join("\n");
}

/**
 * Replace the shell's generic title/description/canonical/preview tags with the
 * resolved set. Removing the originals first keeps a document from carrying two
 * conflicting titles or canonical links.
 */
export function injectEventMeta(shellHtml: string, meta: EventMeta): string {
  const stripped = shellHtml
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, "")
    .replace(/<meta\b[^>]*\bname=["']description["'][^>]*>/gi, "")
    .replace(/<link\b[^>]*\brel=["']canonical["'][^>]*>/gi, "")
    .replace(/<meta\b[^>]*\bproperty=["']og:[^"']+["'][^>]*>/gi, "")
    .replace(/<meta\b[^>]*\bname=["']twitter:[^"']+["'][^>]*>/gi, "");

  const block = renderEventMetaTags(meta)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");

  if (/<\/head>/i.test(stripped)) {
    return stripped.replace(/<\/head>/i, `${block}\n  </head>`);
  }
  return `${renderEventMetaTags(meta)}\n${stripped}`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function withDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`event metadata deadline exceeded (${deadlineMs}ms)`)),
      deadlineMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
