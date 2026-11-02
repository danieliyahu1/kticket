// Buy flow (POST /v1/events/{covenantId}/buy/prepare + /buy/finalize) â€” two
// stateless calls, all logic on the backend:
//
//   prepare  â€” backend verifies the event from the chain, computes
//              availability, fetches the buyer's UTXOs itself, and builds the
//              unsigned buy template -> what the wallet must sign. Issues a
//              `buy_id` the client echoes on finalize so ops can spot
//              abandoned prepares (a prepared buy whose finalize never came).
//   finalize â€” backend merges the wallet's signatures, validates it is a buy,
//              broadcasts, waits for acceptance -> { txid, status }.
//
// The frontend only relays: the covenant id + the buyer's pubkey/address, then
// the template + the wallet's output. It never merges, retries, or owns state.

import { randomUUID } from "node:crypto";
import {
  MAX_BUY_UTXOS,
  MAX_EVENT_CAPACITY,
  maxFeeForInputs,
  organizerPkh,
  orgSpkFromPublicKey,
  TICKET_DUST,
} from "@kticket/kit";
import type { KaspaNetwork } from "@kticket/kit";
import { invalidError, policyError } from "./errors.js";
import { eventAvailability } from "./events.js";
import { isPaidEvent, UNPAID_EVENT_MESSAGE } from "./event-policy.js";
import { broadcastAndConfirm, type BroadcastOutcome } from "./flow.js";
import { selectFundingUtxos } from "./funding.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import type { UtxoResponse } from "./kaspa-types.js";
import { verifyEventFromChain } from "./provenance.js";
import { buildTransaction } from "./tx.js";
import { isRecord, int, str, uint } from "./validate.js";
import type { WireTransaction, WireUtxo, WireUtxoMeta } from "./wire.js";

export interface BuyContext {
  kaspa: KaspaClientLike;
  networkId: string;
  network: KaspaNetwork;
  /** Resolve the registry pointer for a covenant id (may be undefined). */
  byCovenantId: (covenantId: string) => { deployTxId: string } | undefined;
}

export interface BuyPrepareRequest {
  publicKey: string;
  /** The buyer's bech32 address â€” the backend fetches its UTXOs itself. */
  address: string;
}

export interface BuyFinalizeRequest {
  /** Correlation id issued by prepare â€” lets ops detect abandoned prepares. */
  buy_id: string;
  template: WireTransaction;
  signed: unknown;
}

export interface BuyPrepareResult {
  /** Correlation id the client echoes back on finalize (see BuyFinalizeRequest). */
  buy_id: string;
  signing_template: string;
  template: WireTransaction;
  /** Inputs the wallet must sign (excludes the covenant spend at index 0). */
  sign_inputs: { index: number }[];
  /** Ticket price in sompi (from the verified event) for the confirm dialog. */
  price: number;
  /** Value carried inside the new ticket (included in `price`, not extra). */
  ticket_value: number;
  /** Network fee taken out of `price` (sompi). */
  network_fee: number;
  /** What the organizer receives: `price - ticket_value - network_fee`. */
  organizer_proceeds: number;
}

/** The buy's answer: the mint's txid and whether the ledger accepted it. */
export type BuyFinalizeResult = BroadcastOutcome;

const COMPRESSED_PUBKEY_HEX_LEN = 66;
const X_COORD_HEX_LEN = 64;
const PUBKEY_HEX = /^[0-9a-fA-F]+$/;

function validatePublicKey(publicKey: unknown, label = "publicKey"): string {
  const key = str(publicKey, label).toLowerCase();
  if (!PUBKEY_HEX.test(key)) throw invalidError(`${label} must be hex`);
  if (key.length !== COMPRESSED_PUBKEY_HEX_LEN && key.length !== X_COORD_HEX_LEN) {
    throw invalidError(`${label} must be 66 or 64 hex chars`);
  }
  return key;
}

function parsePrepare(raw: unknown): BuyPrepareRequest {
  if (!isRecord(raw)) throw invalidError("request body must be an object");
  return {
    publicKey: validatePublicKey(raw.publicKey),
    address: str(raw.address, "address"),
  };
}

function parseFinalize(raw: unknown): BuyFinalizeRequest {
  if (!isRecord(raw)) throw invalidError("request body must be an object");
  const buy_id = str(raw.buy_id, "buy_id");
  if (!isRecord(raw.template)) throw invalidError("template must be an object");
  const template = raw.template as unknown as WireTransaction;
  if (!Array.isArray(template.inputs) || !Array.isArray(template.outputs)) {
    throw invalidError("template must be a valid transaction");
  }
  if (typeof raw.signed !== "string" && typeof raw.signed !== "object") {
    throw invalidError("signed must be the wallet's signing output");
  }
  return { buy_id, template, signed: raw.signed };
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

/** validate the buy template after merge: it must carry this event's covenant output. */
function validateBuy(covenantId: string): (tx: WireTransaction) => void {
  return (tx) => {
    const matches = tx.outputs.some(
      (output) => output.covenant?.covenant_id?.toLowerCase() === covenantId.toLowerCase(),
    );
    if (!matches) {
      throw invalidError("template is not a buy for this event");
    }
  };
}

/**
 * prepare: verify the event, check availability, fetch the buyer's UTXOs, build
 * the unsigned buy template. The backend trusts only itself â€” it derives the
 * buyer pkh / change script from the public key.
 */
export async function buyPrepare(
  covenantId: string,
  raw: unknown,
  ctx: BuyContext,
): Promise<BuyPrepareResult> {
  const req = parsePrepare(raw);
  const entry = ctx.byCovenantId(covenantId);
  if (!entry) throw invalidError(`event ${covenantId} not found`);

  const verified = await verifyEventFromChain(ctx.kaspa, ctx.network, entry.deployTxId);
  if (!isPaidEvent(verified)) {
    throw policyError(UNPAID_EVENT_MESSAGE);
  }
  const availability = await eventAvailability(verified, ctx.kaspa, ctx.network);
  if (availability.left <= 0) {
    throw policyError("sold out â€” no tickets left");
  }

  const buyer = organizerPkh(req.publicKey);
  const changeSpk = orgSpkFromPublicKey(req.publicKey);
  const spendable = (await ctx.kaspa.getUtxos(req.address))
    .filter((u) => u.outpoint && u.utxoEntry)
    .sort((a, b) => Number(b.utxoEntry.amount) - Number(a.utxoEntry.amount));
  if (spendable.length === 0) {
    throw policyError("no spendable UTXOs on the buyer address");
  }
  // The buyer pays exactly the price; the covenant inspects at most MAX_ITEMS
  // inputs, and the change must not be dust (KIP-9 storage mass).
  const required = verified.legacy
    ? verified.price + TICKET_DUST + maxFeeForInputs(MAX_BUY_UTXOS + 1)
    : verified.price;
  const buyerUtxos = selectFundingUtxos(spendable, required, MAX_BUY_UTXOS);

  const result = await buildTransaction(
    {
      type: "buy",
      event_outpoint: {
        transaction_id: availability.event_txid,
        index: availability.event_index,
      },
      event_covenant_id: verified.covenant_id,
      event_owner: verified.owner_pkh,
      remaining: availability.left,
      constants: {
        authorizing_txid: verified.authorizing_txid,
        price: verified.price,
        org_spk: verified.org_spk,
        burn_template_hash: verified.burn_template_hash,
      },
      buyer,
      buyer_utxos: buyerUtxos.map(toWireUtxo),
      change_spk: { version: 0, script: changeSpk },
      input_utxo_metas: buyerUtxos.map(toWireUtxoMeta),
      ...(verified.legacy ? { legacy: true } : {}),
    },
    { kaspa: ctx.kaspa, networkId: ctx.networkId },
  );

  if (!result.signing_template) {
    throw invalidError("could not build a signing template for the buy");
  }
  const networkFee = result.network_fee ?? 0;
  return {
    buy_id: randomUUID(),
    signing_template: result.signing_template,
    template: result.template,
    sign_inputs: result.template.inputs.slice(1).map((_, i) => ({ index: i + 1 })),
    price: verified.price,
    ticket_value: TICKET_DUST,
    network_fee: networkFee,
    organizer_proceeds: verified.legacy
      ? verified.price
      : verified.price - TICKET_DUST - networkFee,
  };
}

/** finalize: re-check the paid event, merge, validate it is a buy, broadcast. */
export async function buyFinalize(
  covenantId: string,
  raw: unknown,
  ctx: BuyContext,
): Promise<BuyFinalizeResult> {
  const req = parseFinalize(raw);
  const entry = ctx.byCovenantId(covenantId);
  if (!entry) throw invalidError(`event ${covenantId} not found`);

  const verified = await verifyEventFromChain(ctx.kaspa, ctx.network, entry.deployTxId);
  if (!isPaidEvent(verified)) {
    throw policyError(UNPAID_EVENT_MESSAGE);
  }
  return broadcastAndConfirm(req.template, req.signed, ctx, validateBuy(verified.covenant_id));
}
