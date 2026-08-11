// Shared tx-flow helpers (buy / transfer / handover) — the backend owns the
// whole flow: merge the wallet's signatures, validate, broadcast over wRPC, and
// wait for the tx to be accepted before reporting success. The frontend only
// relays the template + the wallet's output.

import { invalidError } from "./errors.js";
import type { KaspaClientLike } from "./kaspa-client.js";
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

const CONFIRM_MAX_ATTEMPTS = 5;
const CONFIRM_BASE_DELAY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until a broadcast tx is accepted on chain (visible via `getTransaction`).
 * Doubling backoff (1s, 2s, 4s, 8s, 16s). Throws `invalid` if it never appears.
 */
export async function waitForTransaction(
  kaspa: KaspaClientLike,
  txid: string,
): Promise<void> {
  let delay = CONFIRM_BASE_DELAY_MS;
  for (let attempt = 0; attempt <= CONFIRM_MAX_ATTEMPTS; attempt++) {
    const tx = await kaspa.getTransaction(txid);
    if (tx) return;
    if (attempt < CONFIRM_MAX_ATTEMPTS) {
      await sleep(delay);
      delay *= 2;
    }
  }
  throw invalidError(`transaction ${txid} was not confirmed on chain`);
}

export interface BroadcastContext {
  kaspa: KaspaClientLike;
  networkId: string;
}

/**
 * Broadcast a merged, signed transaction over wRPC and wait for it to be
 * accepted. Returns the txid. `validate` may reject a template that is not the
 * expected flow type.
 */
export async function broadcastAndConfirm(
  template: WireTransaction,
  signed: unknown,
  ctx: BroadcastContext,
  validate: (tx: WireTransaction) => void = () => {},
): Promise<string> {
  const merged = mergeSignatures(template, signed);
  validate(merged);
  let txid: string;
  try {
    txid = await submitTransactionOverWrpc(ctx.networkId, merged);
  } catch (err) {
    // Surface the node's raw rejection instead of leaking a generic 500 — the
    // route handler logs it via the ApiError detail (KTK buy/transfer).
    throwRejectionError(err instanceof Error ? err.message : String(err));
  }
  const id = txid.toLowerCase();
  await waitForTransaction(ctx.kaspa, id);
  return id;
}
