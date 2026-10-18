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

import { buildEventMeta, buildGenericMeta, type EventMeta } from "@kticket/kit";
import type { FastifyInstance } from "fastify";
import { EVENT_SHELL_CACHE_CONTROL } from "./docs-paths.js";
import { injectEventMeta } from "./event-preview-html.js";
import type { EventRegistry } from "./eventstore.js";
import type { VerificationContext } from "./verified-events.js";

/** How long the shell may wait for chain verification before falling back. */
export const SHELL_DEADLINE_MS = 1_500;

const HTML_CONTENT_TYPE = "text/html; charset=utf-8";

/** The same chain collaborators the directory uses, keyed for a single event. */
export interface EventShellContext extends Omit<VerificationContext, "events"> {
  events: Pick<EventRegistry, "byCovenantId">;
}

export interface EventShellOptions {
  /** Absolute origin used for canonical and preview URLs. */
  origin: string;
  /** The built SPA shell (`index.html`). */
  shellHtml: string;
  deadlineMs?: number;
}

export interface EventPreviewOptions {
  origin: string;
  deadlineMs?: number;
  logger?: EventShellLogger;
}

export interface EventShellLogger {
  warn: (fields: Record<string, unknown>, message: string) => void;
}

export function registerEventShell(
  app: FastifyInstance,
  ctx: EventShellContext,
  options: EventShellOptions,
): void {
  app.get<{ Params: { covenantId: string } }>("/events/:covenantId", async (req, reply) => {
    const meta = await resolveEventMeta(ctx, req.params.covenantId, {
      origin: options.origin,
      deadlineMs: options.deadlineMs ?? SHELL_DEADLINE_MS,
      logger: req.log,
    });
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
  { origin, deadlineMs = SHELL_DEADLINE_MS, logger }: EventPreviewOptions,
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
