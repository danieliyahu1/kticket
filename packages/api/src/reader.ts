// The reader — verify a ticket (HLD v0.22 §2.2, GET /v1/tickets/{ticket_id}).
//
// The chain stores `P2SH(blake3(redeem_script))`, so the reader never decodes a
// preimage from chain bytes; it derives each address from the on-chain script
// hash and walks the covenant owner lineage exactly as the HLD pseudocode:
//
//   outpoint = deploy covenant output (event); walk from the ticket outpoint:
//   for depth in 0..16:
//     utxos non-empty at addr                     -> ALIVE { live_outpoint }
//     spender = tx spending outpoint
//     none                                        -> UNKNOWN { unresolved-spend }
//     successor = spender's covenant output
//     successor is the event's burn-owner template -> GONE { at_tx }
//     addr = successor address; outpoint = successor
//   -> UNKNOWN { depth-exceeded }
//
// Invariant (DEC-12): ALIVE only on a live UTXO; GONE only on a burn-owner
// successor; everything else UNKNOWN (retryable), never fabricated.

import {
  addressFromScriptHash,
  BURN_ARTIFACT,
  burnTemplateHash,
  type KaspaNetwork,
} from "@kticket/kit";
import { invalidError } from "./errors.js";
import type { StoredEventInternal } from "./eventstore.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import { findSpend, findSuccessor, type OutpointRef } from "./lineage.js";

export const MAX_LINEAGE_DEPTH = 16;

export type TicketState = "alive" | "gone" | "unknown";
export type UnknownCause = "unresolved-spend" | "no-successor" | "unknown-event" | "depth-exceeded";

export interface VerifyResult {
  state: TicketState;
  cause?: UnknownCause;
  event?: { authorizing_txid: string; name: string; date: string };
  price?: number;
  liveOutpoint?: { transaction_id: string; index: number };
  atTx?: string;
}

export interface ReaderContext {
  kaspa: KaspaClientLike;
  events: { byGenesisTxId(txId: string): StoredEventInternal | undefined };
  network: KaspaNetwork;
}

const TICKET_ID_RE = /^([0-9a-fA-F]{64}):([0-9]{1,3})$/;
const HEX64 = /^[0-9a-fA-F]{64}$/;
const P2SH_SCRIPT = /^aa20[0-9a-fA-F]{64}87$/;

export function parseTicketId(raw: string): { txId: string; index: number } {
  const [, txId, indexStr] = TICKET_ID_RE.exec(raw.trim()) ?? [];
  if (!(txId && indexStr)) {
    throw invalidError("ticket_id must be '<64-hex genesis txid>:<index>'");
  }
  return { txId: txId.toLowerCase(), index: Number(indexStr) };
}

async function loadGenesis(ctx: ReaderContext, txId: string, index: number) {
  const genesis = await ctx.kaspa.getTransaction(txId);
  if (!genesis) throw invalidError(`genesis transaction ${txId} not found`);

  const output = (genesis.outputs ?? []).find((o) => o.index === index);
  if (!output) throw invalidError(`genesis transaction ${txId} has no output index ${index}`);

  const spk = output.script_public_key;
  if (typeof spk !== "string" || !(HEX64.test(spk) || P2SH_SCRIPT.test(spk))) {
    throw invalidError("output is not a kticket covenant output");
  }
  return spk;
}

function liveResult(
  utxos: readonly { outpoint: OutpointRef }[],
  event: StoredEventInternal | undefined,
): VerifyResult | undefined {
  const live = utxos[0];
  if (!live) return undefined;
  return {
    state: "alive",
    liveOutpoint: {
      transaction_id: live.outpoint.transactionId,
      index: live.outpoint.index,
    },
    ...eventMeta(event),
  };
}

function isBurnSuccessor(event: StoredEventInternal | undefined, scriptPublicKey: string): boolean {
  if (event === undefined) return false;
  const hash = burnTemplateHash(event.authorizingTxId, BURN_ARTIFACT.code);
  return scriptPublicKey.toLowerCase() === `aa20${hash}87`;
}

type AdvanceOutcome =
  | { done: true; result: VerifyResult }
  | { done: false; address: string; outpoint: OutpointRef };

async function advance(
  ctx: ReaderContext,
  address: string,
  outpoint: OutpointRef,
  event: StoredEventInternal | undefined,
): Promise<AdvanceOutcome> {
  const utxos = await ctx.kaspa.getUtxos(address);
  const alive = liveResult(utxos, event);
  if (alive) return { done: true, result: alive };

  const txs = await ctx.kaspa.getFullTransactions(address);
  const spend = findSpend(txs, outpoint);
  if (!spend) {
    return {
      done: true,
      result: { state: "unknown", cause: "unresolved-spend", ...eventMeta(event) },
    };
  }

  const successor = findSuccessor(spend.tx, spend.input);
  const scriptPublicKey = successor?.script_public_key;
  if (!successor || typeof scriptPublicKey !== "string") {
    return { done: true, result: { state: "unknown", cause: "no-successor", ...eventMeta(event) } };
  }

  if (isBurnSuccessor(event, scriptPublicKey)) {
    return {
      done: true,
      result: { state: "gone", atTx: spend.tx.transaction_id, ...eventMeta(event) },
    };
  }

  if (!event) {
    return {
      done: true,
      result: { state: "unknown", cause: "unknown-event", ...eventMeta(event) },
    };
  }

  return {
    done: false,
    address: addressFromScriptHash(scriptPublicKey, ctx.network),
    outpoint: { transactionId: spend.tx.transaction_id, index: successor.index },
  };
}

export async function verifyTicket(raw: string, ctx: ReaderContext): Promise<VerifyResult> {
  const { txId, index } = parseTicketId(raw);
  const spk = await loadGenesis(ctx, txId, index);

  const event = ctx.events.byGenesisTxId(txId);
  let address = addressFromScriptHash(spk, ctx.network);
  let outpoint: OutpointRef = { transactionId: txId, index };

  for (let depth = 0; depth <= MAX_LINEAGE_DEPTH; depth++) {
    const outcome = await advance(ctx, address, outpoint, event);
    if (outcome.done) return outcome.result;
    address = outcome.address;
    outpoint = outcome.outpoint;
  }

  return { state: "unknown", cause: "depth-exceeded", ...eventMeta(event) };
}

function eventMeta(event: StoredEventInternal | undefined) {
  if (!event) return {};
  return {
    event: { authorizing_txid: event.authorizingTxId, name: event.name, date: event.date },
    price: event.price,
  };
}
