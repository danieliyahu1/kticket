// Relay boundary: put one already-signed transaction on the wire, and own the
// one decision neither its taxonomy (`broadcast.ts`) nor the calling flow can
// make — whether the same bytes may be tried again.

import { classifyRejection, rejectionError } from "./broadcast.js";
import { elapsedSeconds, metrics } from "./metrics.js";
import { type PollOptions, sleep } from "./poll-until.js";
import type { WireTransaction } from "./wire.js";
import { submitTransactionOverWrpc } from "./wrpc-client.js";

/**
 * How long to keep re-sending a transaction the node calls an orphan. Its
 * parent output normally reaches the ledger within a block or two, so the
 * budget stays short; once it is spent the client is told when to rebuild.
 */
export const RELAY_SCHEDULE: PollOptions = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 4_000,
};

/**
 * Relay a signed transaction over wRPC and return its txid, in the lowercase
 * form every route reports.
 *
 * Only an unknown input is retried, and always with the very same bytes: the
 * txid is derived from them, so nothing can be spent twice, and a node that
 * rejected the transaction as an orphan never put it in its mempool. A double
 * spend or a bad signature cannot improve by waiting, so it is reported on the
 * first attempt through the error taxonomy.
 */
export async function relaySignedTransaction(
  tx: WireTransaction,
  networkId: string,
  schedule: PollOptions = RELAY_SCHEDULE,
): Promise<string> {
  let delay = schedule.baseDelayMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await submitOnce(tx, networkId);
    } catch (err) {
      const message = nodeMessage(err);
      const worthRetrying =
        classifyRejection(message) === "unknown-input" && attempt < schedule.maxAttempts;
      if (!worthRetrying) throw rejectionError(message);
      await sleep(delay);
      delay = Math.min(delay * 2, schedule.maxDelayMs);
    }
  }
}

/** One relay attempt: its txid, or the node's rejection. Metrics record both. */
async function submitOnce(tx: WireTransaction, networkId: string): Promise<string> {
  const started = process.hrtime();
  try {
    const txid = await submitTransactionOverWrpc(networkId, tx);
    metrics.observeUpstream("wrpc_broadcast", "success", elapsedSeconds(started));
    return txid.toLowerCase();
  } catch (err) {
    metrics.observeUpstream("wrpc_broadcast", "error", elapsedSeconds(started));
    throw err;
  }
}

/** The rejection text the node answered with. */
function nodeMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
