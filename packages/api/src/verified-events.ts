// One verification path for every discovery surface (KTK-153 / KTK-163).
//
// The events directory, the sitemap, and the event shell must agree on what
// "verified" means. They all call this function: each registry entry is
// re-verified against the chain (memoized by `VerifiedEventCache`), entries that
// fail verification are hidden, and real outages propagate instead of silently
// dropping events.

import type { KaspaNetwork } from "@kticket/kit";
import { isApiError } from "./errors.js";
import type { EventRegistry, StoredEvent } from "./eventstore.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import type { VerifiedEvent } from "./provenance.js";
import type { VerifiedEventCache } from "./verified-cache.js";

export interface VerificationContext {
  kaspa: KaspaClientLike;
  network: KaspaNetwork;
  events: Pick<EventRegistry, "list">;
  verified: Pick<VerifiedEventCache, "verify">;
}

/**
 * Verify every registry entry against the chain. Entries that fail verification
 * (poisoned or stale registry rows) are hidden; non-verification errors such as
 * an upstream outage propagate — the caller fails rather than serving a
 * directory that silently lost events.
 */
export async function verifyAll(
  entries: readonly StoredEvent[],
  ctx: VerificationContext,
): Promise<VerifiedEvent[]> {
  const outcomes = await Promise.all(entries.map((entry) => verifyIfValid(entry, ctx)));
  return outcomes.filter(isVerifiedEvent);
}

async function verifyIfValid(
  entry: StoredEvent,
  ctx: VerificationContext,
): Promise<VerifiedEvent | undefined> {
  try {
    return await ctx.verified.verify(ctx.kaspa, ctx.network, entry.deployTxId);
  } catch (err) {
    if (isApiError(err) && err.type === "invalid") return undefined;
    throw err;
  }
}

function isVerifiedEvent(event: VerifiedEvent | undefined): event is VerifiedEvent {
  return event !== undefined;
}
