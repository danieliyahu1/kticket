// Shared tx-flow helpers (buy / handover) — the backend owns the whole flow:
// merge the wallet's signatures, validate, broadcast over wRPC, and wait for
// the tx to be accepted before reporting it as settled. The frontend only
// relays the template + the wallet's output.

import type { KaspaClientLike } from "./kaspa-client.js";
import { elapsedSeconds, metrics } from "./metrics.js";
import { pollUntil, type PollOptions } from "./poll-until.js";
import { throwRejectionError } from "./broadcast.js";
import { submitTransactionOverWrpc } from "./wrpc-client.js";
import type { WireTransaction } from "./wire.js";

/**
 * Merge the wallet's signatures into the template by input outpoint. The
 * wallet's signing output may arrive as a JSON string or as a parsed object.
 */
export function mergeSignatures(template: WireTransaction, signed: unknown): WireTransaction {
  let parsed: unknown = signed;
  if (typeof signed === "string") {
    parsed = JSON.parse(signed);
  }
  const inputs =
    typeof parsed === "object" && parsed !== null && "inputs" in parsed
      ? (parsed as { inputs?: unknown }).inputs
      : undefined;
  const byInput = new Map(
    (Array.isArray(inputs) ? inputs : []).map((input) => {
      const rec = input as { transactionId?: string; index?: number; signatureScript?: string };
      return [`${rec.transactionId}:${rec.index}`, rec];
    }),
  );
  return {
    ...template,
    inputs: template.inputs.map((input) => {
      const key = `${input.previous_outpoint.transaction_id}:${input.previous_outpoint.index}`;
      const si = byInput.get(key);
      return {
        ...input,
        signature_script: si?.signatureScript ?? input.signature_script,
      };
    }),
  };
}

const CONFIRM_SCHEDULE: PollOptions = {
  maxAttempts: 9,
  baseDelayMs: 1_000,
  maxDelayMs: 16_000,
};

/**
 * How a broadcast ended. `settled` — the ledger accepted the transaction, so
 * every output it declares exists. `pending` — it was relayed but acceptance is
 * not established yet; the transaction may still settle (or never land).
 */
export type BroadcastStatus = "settled" | "pending";

export interface BroadcastOutcome {
  txid: string;
  status: BroadcastStatus;
}

/**
 * Wait for the ledger to accept a broadcast transaction, and report whether it
 * did. Timing (doubling backoff) belongs to `pollUntil`; what counts as "done"
 * belongs here — an acceptance record, never mere visibility in the indexer,
 * which only means the transaction reached a block. A not-yet-accepted result
 * is `false`, not an error: the broadcast already happened, so failing here
 * would tell the client its payment never went out. For the same reason a
 * lookup failure counts as "not yet" (the upstream error is already in the
 * metrics) rather than as a failure of the broadcast.
 */
export async function waitForAcceptance(
  kaspa: KaspaClientLike,
  txid: string,
  schedule: PollOptions = CONFIRM_SCHEDULE,
): Promise<boolean> {
  const accepted = await pollUntil(async () => {
    const settled = await kaspa.isTransactionAccepted(txid).catch(() => false);
    return settled ? true : undefined;
  }, schedule);
  return accepted === true;
}

export interface BroadcastContext {
  kaspa: KaspaClientLike;
  networkId: string;
}

/**
 * Broadcast a merged, signed transaction over wRPC and wait for it to be
 * accepted. Returns the txid and whether acceptance was established.
 * `validate` may reject a template that is not the expected flow type.
 */
export async function broadcastAndConfirm(
  template: WireTransaction,
  signed: unknown,
  ctx: BroadcastContext,
  validate: (tx: WireTransaction) => void = () => {},
): Promise<BroadcastOutcome> {
  const merged = mergeSignatures(template, signed);
  validate(merged);
  let txid: string;
  const broadcastStarted = process.hrtime();
  try {
    txid = await submitTransactionOverWrpc(ctx.networkId, merged);
    metrics.observeUpstream("wrpc_broadcast", "success", elapsedSeconds(broadcastStarted));
  } catch (err) {
    metrics.observeUpstream("wrpc_broadcast", "error", elapsedSeconds(broadcastStarted));
    // Surface the node's raw rejection instead of leaking a generic 500 — the
    // route handler logs it via the ApiError detail (KTK buy).
    throwRejectionError(err instanceof Error ? err.message : String(err));
  }
  const id = txid.toLowerCase();
  const status: BroadcastStatus = (await waitForAcceptance(ctx.kaspa, id)) ? "settled" : "pending";
  if (status === "settled") {
    // KTK-115: the accepted tx invalidates cached chain reads (the covenant's
    // UTXOs and the buyer's funding UTXO). Drop them so the next availability
    // walk or buy prepare sees the post-buy state, not a ≤3s-old snapshot.
    ctx.kaspa.clearCache();
  }
  return { txid: id, status };
}

/**
 * Operator-side diagnostics for wallet-signing regressions (e.g. Kasware
 * declining to co-sign covenant inputs): for each wallet payload received at
 * finalize, which template input positions it covered and which it left
 * unsigned. Positions only — everything here is derivable from public chain
 * data, so it belongs in server logs rather than the browser console.
 */
export function describeWalletSignatures(
  flow: string,
  template: WireTransaction,
  ...payloads: unknown[]
): { flow: string; inputs: number; wallets: { signed: number[]; missing: number[] }[] } {
  return {
    flow,
    inputs: template.inputs.length,
    wallets: payloads.map((payload) => {
      const signed = walletSignedPositions(template, payload);
      return {
        signed,
        missing: template.inputs.map((_, i) => i).filter((i) => !signed.includes(i)),
      };
    }),
  };
}

function walletSignedPositions(template: WireTransaction, signed: unknown): number[] {
  let parsed: unknown = signed;
  if (typeof signed === "string") {
    try {
      parsed = JSON.parse(signed);
    } catch {
      return [];
    }
  }
  const entries =
    typeof parsed === "object" &&
    parsed !== null &&
    Array.isArray((parsed as { inputs?: unknown }).inputs)
      ? (parsed as { inputs: unknown[] }).inputs
      : [];
  const hasSignature = new Map<string, boolean>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as { transactionId?: unknown; index?: unknown; signatureScript?: unknown };
    if (typeof rec.transactionId !== "string") continue;
    hasSignature.set(
      `${rec.transactionId.toLowerCase()}:${String(rec.index ?? "")}`,
      typeof rec.signatureScript === "string" && rec.signatureScript.length > 0,
    );
  }
  return template.inputs.flatMap((input, i) =>
    hasSignature.get(
      `${input.previous_outpoint.transaction_id.toLowerCase()}:${input.previous_outpoint.index}`,
    )
      ? [i]
      : [],
  );
}
