// Relay boundary: put one already-signed transaction on the wire, in the one
// place every flow shares.

import { rejectionError } from "./broadcast.js";
import { elapsedSeconds, metrics } from "./metrics.js";
import type { WireTransaction } from "./wire.js";
import { submitTransactionOverWrpc } from "./wrpc-client.js";

/**
 * Relay a signed transaction over wRPC and return its txid, in the lowercase
 * form every route reports. A node rejection comes back as the error taxonomy
 * says it should.
 */
export async function relaySignedTransaction(
  tx: WireTransaction,
  networkId: string,
): Promise<string> {
  const started = process.hrtime();
  try {
    const txid = await submitTransactionOverWrpc(networkId, tx);
    metrics.observeUpstream("wrpc_broadcast", "success", elapsedSeconds(started));
    return txid.toLowerCase();
  } catch (err) {
    metrics.observeUpstream("wrpc_broadcast", "error", elapsedSeconds(started));
    throw rejectionError(err instanceof Error ? err.message : String(err));
  }
}
