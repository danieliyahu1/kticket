// In-process memo of chain-verified event facts.
//
// Deployed event facts (name, date, price, capacity, organizer) are baked into
// the deploy transaction, which the blockDAG never mutates — so once an event
// passes `verifyEventFromChain` it can never go stale. The memo therefore needs
// no TTL and no eviction: it holds immutable truth, not transient state.
//
// The chain stays the source of truth: only successful verifications are
// stored, the memo lives in process memory only, and a restart simply re-verifies
// on demand. Failed verifications are never cached, so a poisoned registry entry
// is re-checked against the chain on every read.

import type { KaspaNetwork } from "@kticket/kit";
import type { KaspaClientLike } from "./kaspa-client.js";
import { verifyEventFromChain, type VerifiedEvent } from "./provenance.js";

/** Memoizes `verifyEventFromChain` results keyed by deploy txid. */
export class VerifiedEventCache {
  readonly #memo = new Map<string, VerifiedEvent>();

  async verify(
    kaspa: KaspaClientLike,
    network: KaspaNetwork,
    deployTxId: string,
  ): Promise<VerifiedEvent> {
    const key = deployTxId.toLowerCase();
    const cached = this.#memo.get(key);
    if (cached) return cached;
    const verified = await verifyEventFromChain(kaspa, network, key);
    this.#memo.set(key, verified);
    return verified;
  }
}
