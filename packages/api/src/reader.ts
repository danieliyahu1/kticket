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
  type KaspiaNet,
} from "@kticket/kit";
import { invalidError } from "./errors.js";
import type { RegisteredEvent } from "./events.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import type { TxInput, TxModel, TxOutput } from "./kaspa-types.js";

export const MAX_LINEAGE_DEPTH = 16;

export type TicketState = "alive" | "gone" | "unknown";
export type UnknownCause = "unresolved-spend" | "no-successor" | "unknown-event" | "depth-exceeded";

export interface VerifyResult {
  state: TicketState;
  /** Set when state is "unknown" — why the walk could not resolve (never guessed). */
  cause?: UnknownCause;
  event?: { event_id: string; name: string; date: string };
  price?: number;
  liveOutpoint?: { transaction_id: string; index: number };
  atTx?: string;
}

export interface ReaderContext {
  kaspa: KaspaClientLike;
  events: { byGenesisTxId(txId: string): RegisteredEvent | undefined };
  network: KaspiaNet;
}

const TICKET_ID_RE = /^([0-9a-fA-F]{64}):([0-9]{1,3})$/;
const HEX64 = /^[0-9a-fA-F]{64}$/;

/** Parse a `ticket_id` of the form `<64-hex deploy txid>:<index>`. */
export function parseTicketId(raw: string): { txId: string; index: number } {
  const [, txId, indexStr] = TICKET_ID_RE.exec(raw.trim()) ?? [];
  if (!txId || !indexStr) {
    throw invalidError("ticket_id must be '<64-hex genesis txid>:<index>'");
  }
  return { txId: txId.toLowerCase(), index: Number(indexStr) };
}

export async function verifyTicket(raw: string, ctx: ReaderContext): Promise<VerifyResult> {
  const { txId, index } = parseTicketId(raw);

  const genesis = await ctx.kaspa.getTransaction(txId);
  if (!genesis) throw invalidError(`genesis transaction ${txId} not found`);

  const output = (genesis.outputs ?? []).find((o) => o.index === index);
  if (!output) throw invalidError(`genesis transaction ${txId} has no output index ${index}`);

  const spk = output.script_public_key;
  if (typeof spk !== "string" || !HEX64.test(spk)) {
    throw invalidError("output is not a kticket covenant output");
  }

  const event = ctx.events.byGenesisTxId(txId);
  let address = addressFromScriptHash(spk, ctx.network);
  let outpoint = { transactionId: txId, index };

  for (let depth = 0; depth <= MAX_LINEAGE_DEPTH; depth++) {
    const utxos = await ctx.kaspa.getUtxos(address);
    if (utxos.length > 0) {
      const live = utxos[0];
      if (!live) throw invalidError("unexpected empty utxo result");
      return {
        state: "alive",
        liveOutpoint: {
          transaction_id: live.outpoint.transactionId,
          index: live.outpoint.index,
        },
        ...eventMeta(event),
      };
    }

    const txs = await ctx.kaspa.getFullTransactions(address);
    const spend = findSpend(txs, outpoint);
    if (!spend) return { state: "unknown", cause: "unresolved-spend", ...eventMeta(event) };

    const successor = findSuccessor(spend.tx, spend.input);
    if (!successor || typeof successor.script_public_key !== "string") {
      return { state: "unknown", cause: "no-successor", ...eventMeta(event) };
    }

    if (
      event &&
      successor.script_public_key.toLowerCase() ===
        burnTemplateHash(event.eventId, BURN_ARTIFACT.code)
    ) {
      return { state: "gone", atTx: spend.tx.transaction_id, ...eventMeta(event) };
    }

    if (!event) {
      // Cannot tell a burn successor from a ticket successor without the
      // event's burn template — never guess (DEC-12).
      return { state: "unknown", cause: "unknown-event", ...eventMeta(event) };
    }

    address = addressFromScriptHash(successor.script_public_key, ctx.network);
    outpoint = { transactionId: spend.tx.transaction_id, index: successor.index };
  }

  return { state: "unknown", cause: "depth-exceeded", ...eventMeta(event) };
}

function findSpend(
  txs: TxModel[],
  outpoint: { transactionId: string; index: number },
): { tx: TxModel; input: TxInput } | undefined {
  for (const tx of txs) {
    for (const input of tx.inputs ?? []) {
      if (references(input, outpoint)) return { tx, input };
    }
  }
  return undefined;
}

function references(input: TxInput, outpoint: { transactionId: string; index: number }): boolean {
  return (
    input.previous_outpoint_hash?.toLowerCase() === outpoint.transactionId.toLowerCase() &&
    Number(input.previous_outpoint_index) === outpoint.index
  );
}

/**
 * The covenant continuation output a spend authorizes: the output bound to the
 * same authorizing input. Buy/transfer/handover each produce exactly one such
 * output (the ticket or burn successor); the change output is not a covenant.
 */
function findSuccessor(tx: TxModel, spent: TxInput): TxOutput | undefined {
  const covenants = (tx.outputs ?? []).filter((o) => o.covenant_authorizing_input != null);
  if (covenants.length === 0) return undefined;
  const byInput = covenants.find((o) => o.covenant_authorizing_input === spent.index);
  if (byInput) return byInput;
  return covenants.length === 1 ? covenants[0] : undefined;
}

function eventMeta(event: RegisteredEvent | undefined) {
  if (!event) return {};
  return {
    event: { event_id: event.eventId, name: event.name, date: event.date },
    price: event.price,
  };
}
