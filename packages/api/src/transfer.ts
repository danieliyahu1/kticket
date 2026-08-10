// Transfer flow (POST /v1/tickets/{ticketId}/transfer) — one logical endpoint,
// two stateless calls, all logic on the backend:
//
//   prepare  — backend resolves the event, fetches the holder's UTXOs itself,
//              and builds the unsigned transfer template -> what the wallet signs.
//   finalize — backend merges the wallet's signatures, validates it is a
//              transfer, broadcasts, waits for chain confirmation -> { txid }.
//
// The frontend only relays: the ticket id + the holder's pubkey/address, then
// the template + the wallet's output. It never merges, retries, or owns state.

import { organizerPkh, orgSpkFromPublicKey } from "@kticket/kit";
import type { KaspaNetwork } from "@kticket/kit";
import { invalidError, policyError } from "./errors.js";
import { broadcastAndConfirm } from "./flow.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import type { UtxoResponse } from "./kaspa-types.js";
import { verifyEventFromChain } from "./provenance.js";
import { buildTransaction } from "./tx.js";
import { isRecord, str } from "./validate.js";
import type { WireTransaction, WireUtxo, WireUtxoMeta } from "./wire.js";

export interface TransferContext {
  kaspa: KaspaClientLike;
  networkId: string;
  network: KaspaNetwork;
  byCovenantId: (covenantId: string) => { deployTxId: string } | undefined;
}

export interface TransferPrepareRequest {
  phase: "prepare";
  /** The ticket's event covenant id (from the ticket list entry). */
  covenant_id: string;
  /** The ticket outpoint, `<txid>:<index>` — the ticket being transferred. */
  ticket_id: string;
  publicKey: string;
  address: string;
}

export interface TransferFinalizeRequest {
  phase: "finalize";
  template: WireTransaction;
  signed: unknown;
}

export interface TransferPrepareResult {
  signing_template: string;
  template: WireTransaction;
  /** Inputs the wallet must sign (excludes the ticket covenant spend at index 0). */
  sign_inputs: { index: number }[];
}

export interface TransferFinalizeResult {
  txid: string;
}

const COMPRESSED_PUBKEY_HEX_LEN = 66;
const X_COORD_HEX_LEN = 64;
const PUBKEY_HEX = /^[0-9a-fA-F]+$/;
const TXID_HEX = /^[0-9a-fA-F]{64}$/;

function validatePublicKey(publicKey: unknown, label = "publicKey"): string {
  const key = str(publicKey, label).toLowerCase();
  if (!PUBKEY_HEX.test(key)) throw invalidError(`${label} must be hex`);
  if (key.length !== COMPRESSED_PUBKEY_HEX_LEN && key.length !== X_COORD_HEX_LEN) {
    throw invalidError(`${label} must be 66 or 64 hex chars`);
  }
  return key;
}

function parseTicketOutpoint(ticketId: string): { transaction_id: string; index: number } {
  const idx = ticketId.indexOf(":");
  if (idx < 0) throw invalidError("ticket_id must be <txid>:<index>");
  const txid = ticketId.slice(0, idx);
  if (!TXID_HEX.test(txid)) throw invalidError("ticket_id txid must be 64 hex chars");
  const index = Number(ticketId.slice(idx + 1));
  if (!Number.isSafeInteger(index) || index < 0) {
    throw invalidError("ticket index must be a non-negative integer");
  }
  return { transaction_id: txid.toLowerCase(), index };
}

function parsePrepare(raw: unknown): TransferPrepareRequest {
  if (!isRecord(raw)) throw invalidError("request body must be an object");
  const covenantId = str(raw.covenant_id, "covenant_id").toLowerCase();
  if (!TXID_HEX.test(covenantId)) throw invalidError("covenant_id must be 64 hex chars");
  return {
    phase: "prepare",
    covenant_id: covenantId,
    ticket_id: str(raw.ticket_id, "ticket_id"),
    publicKey: validatePublicKey(raw.publicKey),
    address: str(raw.address, "address"),
  };
}

function parseFinalize(raw: unknown): TransferFinalizeRequest {
  if (!isRecord(raw)) throw invalidError("request body must be an object");
  if (!isRecord(raw.template)) throw invalidError("template must be an object");
  const template = raw.template as unknown as WireTransaction;
  if (!Array.isArray(template.inputs) || !Array.isArray(template.outputs)) {
    throw invalidError("template must be a valid transaction");
  }
  if (typeof raw.signed !== "string" && typeof raw.signed !== "object") {
    throw invalidError("signed must be the wallet's signing output");
  }
  return { phase: "finalize", template, signed: raw.signed };
}

function toWireUtxo(u: UtxoResponse): WireUtxo {
  return {
    transaction_id: u.outpoint.transactionId,
    index: u.outpoint.index,
    value: Number(u.utxoEntry.amount),
  };
}

function toWireUtxoMeta(u: UtxoResponse): WireUtxoMeta {
  return {
    transaction_id: u.outpoint.transactionId,
    index: u.outpoint.index,
    value: Number(u.utxoEntry.amount),
    script_public_key: { version: 0, script: u.utxoEntry.scriptPublicKey.scriptPublicKey },
    block_daa_score: Number(u.utxoEntry.blockDaaScore),
    is_coinbase: u.utxoEntry.isCoinbase,
    ...(typeof u.address === "string" ? { address: u.address } : {}),
  };
}

/** validate the transfer template after merge: it must carry the covenant output. */
function validateTransfer(tx: WireTransaction): void {
  if (!tx.outputs.some((o) => o.covenant !== null)) {
    throw invalidError("template is not a transfer (no covenant output)");
  }
}

/**
 * prepare: resolve the event, fetch the holder's UTXOs, build the unsigned
 * transfer template. The recipient is the connected wallet (the same holder
 * pkh today) — derived server-side from the public key.
 */
export async function transferPrepare(
  raw: unknown,
  ctx: TransferContext,
): Promise<TransferPrepareResult> {
  const req = parsePrepare(raw);
  const entry = ctx.byCovenantId(req.covenant_id);
  if (!entry) throw invalidError(`event ${req.covenant_id} not found`);

  const verified = await verifyEventFromChain(ctx.kaspa, ctx.network, entry.deployTxId);
  const newOwner = organizerPkh(req.publicKey);
  const changeSpk = orgSpkFromPublicKey(req.publicKey);
  const holderUtxos = (await ctx.kaspa.getUtxos(req.address))
    .filter((u) => u.outpoint && u.utxoEntry)
    .sort((a, b) => Number(b.utxoEntry.amount) - Number(a.utxoEntry.amount));
  if (holderUtxos.length === 0) {
    throw policyError("no spendable UTXOs on the holder address");
  }

  const result = await buildTransaction(
    {
      type: "transfer",
      ticket_outpoint: parseTicketOutpoint(req.ticket_id),
      event_covenant_id: req.covenant_id,
      constants: {
        authorizing_txid: verified.authorizing_txid,
        price: verified.price,
        org_spk: verified.org_spk,
        burn_template_hash: verified.burn_template_hash,
      },
      new_owner: newOwner,
      holder_utxos: holderUtxos.map(toWireUtxo),
      change_spk: { version: 0, script: changeSpk },
      input_utxo_metas: holderUtxos.map(toWireUtxoMeta),
    },
    { kaspa: ctx.kaspa, networkId: ctx.networkId },
  );

  if (!result.signing_template) {
    throw invalidError("could not build a signing template for the transfer");
  }
  return {
    signing_template: result.signing_template,
    template: result.template,
    sign_inputs: result.template.inputs.slice(1).map((_, i) => ({ index: i + 1 })),
  };
}

/** finalize: merge, validate it is a transfer, broadcast, wait, return the txid. */
export async function transferFinalize(
  raw: unknown,
  ctx: TransferContext,
): Promise<TransferFinalizeResult> {
  const req = parseFinalize(raw);
  const txid = await broadcastAndConfirm(req.template, req.signed, ctx, validateTransfer);
  return { txid };
}
