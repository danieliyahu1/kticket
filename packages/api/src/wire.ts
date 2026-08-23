// Wire shapes for the tx build endpoint (HLD v0.22 §2.2) and the mapping
// between the kit's camelCase `UnsignedTransaction` and the snake_case JSON the
// wallet sends/receives over HTTP.

import {
  MAX_EVENT_CAPACITY,
  type ScriptPublicKey,
  type UnsignedTransaction,
} from "@kticket/kit";
import { hexToBytes } from "@noble/hashes/utils.js";
import { invalidError } from "./errors.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import type { SubmitTxModel } from "./kaspa-types.js";
import { hex, hex64, int, isRecord, str, uint } from "./validate.js";

export interface WireOutpoint {
  transaction_id: string;
  index: number;
}

export interface WireUtxo extends WireOutpoint {
  value: number;
}

/**
 * A funding UTXO with the full prev-output metadata the wallet needs to sign
 * (`signPskt` safe-JSON carries `utxo.scriptPublicKey` etc. per input). The
 * wallet supplies these from its own lookup; the API forwards them into the
 * wasm-built signing template.
 */
export interface WireUtxoMeta extends WireUtxo {
  /** `{version, script}` public key of the previous output (v0 P2PK for kasware). */
  script_public_key: WireScriptPublicKey;
  block_daa_score: number;
  is_coinbase: boolean;
  /** Optional human-readable address for the previous output. */
  address?: string;
  /** Covenant id of the previous output (set for covenant spends). */
  covenant_id?: string | null;
}

export interface WireScriptPublicKey {
  version: number;
  script: string;
}

export interface WireCovenant {
  authorizing_input: number;
  covenant_id: string;
}

export interface WireInput {
  previous_outpoint: WireOutpoint;
  signature_script: string;
  sequence: number;
  sig_op_count: number;
}

export interface WireOutput {
  value: number;
  script_public_key: WireScriptPublicKey;
  covenant: WireCovenant | null;
}

/** The unsigned template handed to the wallet — the kit's tx shape, snake_case on the wire. */
export interface WireTransaction {
  version: number;
  inputs: WireInput[];
  outputs: WireOutput[];
  lock_time: number;
  /** Hex-encoded payload (KCC-0021 metadata for deploy txs). */
  payload?: string;
}

export interface TicketConstantsJson {
  authorizing_txid: string;
  price: number;
  org_spk: string;
  burn_template_hash: string;
}

export type BuildRequest =
  | {
      type: "deploy";
      capacity: number;
      constants: TicketConstantsJson;
      organizer: string;
      authorizing_outpoint: WireUtxo;
      organizer_utxos: WireUtxo[];
      change_spk: WireScriptPublicKey;
      /** Full prev-output metadata for every spending input, in input order (needed to sign). */
      input_utxo_metas?: WireUtxoMeta[];
      /** KCC-20 metadata — encoded as a data output in the deploy tx. */
      name?: string;
      date?: string;
      /** Local wall-clock start time (HH:MM). */
      time?: string;
      /** KCC-0021 standard token-metadata keys (display-only, optional). */
      ticker?: string;
      decimals?: number;
      image?: string;
      image_hash?: string;
    }
  | {
      type: "buy";
      event_outpoint: WireOutpoint;
      event_covenant_id: string;
      event_owner: string;
      remaining: number;
      constants: TicketConstantsJson;
      buyer: string;
      buyer_utxos: WireUtxo[];
      change_spk: WireScriptPublicKey;
      input_utxo_metas?: WireUtxoMeta[];
    }
  | {
      type: "handover";
      ticket_outpoint: WireOutpoint;
      event_covenant_id: string;
      constants: TicketConstantsJson;
      attendee_utxos: WireUtxo[];
      change_spk: WireScriptPublicKey;
    }
  | {
      type: "markUsed";
      ticket_outpoint: WireOutpoint;
      event_covenant_id: string;
      constants: TicketConstantsJson;
      /** The ticket owner's 32-byte owner identifier (pubkey x-coordinate). */
      owner: string;
      /** The owner's fee-payer UTXOs (fee payer = owner). */
      owner_utxos: WireUtxo[];
      change_spk: WireScriptPublicKey;
      input_utxo_metas?: WireUtxoMeta[];
    }
  | {
      type: "list";
      ticket_outpoint: WireOutpoint;
      event_covenant_id: string;
      constants: TicketConstantsJson;
      owner: string;
      /** Asking price in sompi — committed into the covenant state. */
      price: number;
      owner_utxos: WireUtxo[];
      change_spk: WireScriptPublicKey;
      input_utxo_metas?: WireUtxoMeta[];
    }
  | {
      type: "delist";
      ticket_outpoint: WireOutpoint;
      event_covenant_id: string;
      constants: TicketConstantsJson;
      owner: string;
      owner_utxos: WireUtxo[];
      change_spk: WireScriptPublicKey;
      input_utxo_metas?: WireUtxoMeta[];
    }
  | {
      type: "purchase";
      ticket_outpoint: WireOutpoint;
      event_covenant_id: string;
      constants: TicketConstantsJson;
      /** The seller's 32-byte identifier — the ticket's current state. */
      seller: string;
      buyer: string;
      /** The on-chain asking price the covenant enforces. */
      price: number;
      /** The buyer's fee-payer UTXOs (fee payer = buyer). */
      buyer_utxos: WireUtxo[];
      change_spk: WireScriptPublicKey;
      input_utxo_metas?: WireUtxoMeta[];
    };

export interface BuildResult {
  template: WireTransaction;
  /**
   * The unsigned transaction in the kaspa-wasm safe-JSON shape Kasware's
   * `signPskt` expects (`serializeToSafeJSON()`), built on-chain-style so the
   * wallet can produce signatures (HLD §2.2 / forge reference).
   */
  signing_template?: string;
  /** Set for deploy — the event's covenant family id (HLD §2.1). */
  event_covenant_id?: string;
}

export interface BroadcastResult {
  txid: string;
}

export interface TxContext {
  kaspa: KaspaClientLike;
  /** wRPC network id ("testnet-10") for the broadcast relay. */
  networkId: string;
}

function scriptSpk(value: unknown, label: string): WireScriptPublicKey {
  if (!isRecord(value)) throw invalidError(`${label} must be { version, script }`);
  return {
    version: int(value.version, `${label}.version`),
    script: hex(value.script, `${label}.script`),
  };
}

function outpoint(value: unknown, label: string): WireOutpoint {
  if (!isRecord(value)) throw invalidError(`${label} must be { transaction_id, index }`);
  return {
    transaction_id: hex64(value.transaction_id, `${label}.transaction_id`),
    index: uint(value.index, `${label}.index`),
  };
}

function utxos(value: unknown, label: string): WireUtxo[] {
  if (!Array.isArray(value)) throw invalidError(`${label} must be an array`);
  return value.map((entry, i) => {
    if (!isRecord(entry)) throw invalidError(`${label}[${i}] must be an object`);
    return {
      ...outpoint(entry, `${label}[${i}]`),
      value: uint(entry.value, `${label}[${i}].value`),
    };
  });
}

function utxoMetas(value: unknown, label: string): WireUtxoMeta[] {
  if (!Array.isArray(value)) throw invalidError(`${label} must be an array`);
  return value.map((entry, i) => {
    if (!isRecord(entry)) throw invalidError(`${label}[${i}] must be an object`);
    const item = `${label}[${i}]`;
    const address = entry.address;
    if (address !== undefined && typeof address !== "string") {
      throw invalidError(`${item}.address must be a string`);
    }
    return {
      ...outpoint(entry, item),
      value: uint(entry.value, `${item}.value`),
      script_public_key: scriptSpk(entry.script_public_key, `${item}.script_public_key`),
      block_daa_score: uint(entry.block_daa_score, `${item}.block_daa_score`),
      is_coinbase: entry.is_coinbase === true,
      ...(typeof address === "string" ? { address } : {}),
    };
  });
}

function parseConstants(value: unknown): TicketConstantsJson {
  if (!isRecord(value)) throw invalidError("constants must be an object");
  return {
    authorizing_txid: hex64(value.authorizing_txid, "constants.authorizing_txid"),
    price: uint(value.price, "constants.price"),
    org_spk: hex(value.org_spk, "constants.org_spk"),
    burn_template_hash: hex64(value.burn_template_hash, "constants.burn_template_hash"),
  };
}

function parseDeploy(raw: Record<string, unknown>): BuildRequest {
  const capacity = int(raw.capacity, "capacity");
  if (capacity < 0 || capacity > MAX_EVENT_CAPACITY) {
    throw invalidError(`capacity must be 0..${MAX_EVENT_CAPACITY}`);
  }
  const authorizingUtxo = isRecord(raw.authorizing_outpoint) ? raw.authorizing_outpoint : {};
  const base = {
    type: "deploy" as const,
    capacity,
    constants: parseConstants(raw.constants),
    organizer: hex64(raw.organizer, "organizer"),
    authorizing_outpoint: {
      ...outpoint(authorizingUtxo, "authorizing_outpoint"),
      value: uint(authorizingUtxo.value, "authorizing_outpoint.value"),
    },
    organizer_utxos: utxos(raw.organizer_utxos, "organizer_utxos"),
    change_spk: scriptSpk(raw.change_spk, "change_spk"),
    ...(raw.input_utxo_metas !== undefined
      ? { input_utxo_metas: utxoMetas(raw.input_utxo_metas, "input_utxo_metas") }
      : {}),
  };
  if (raw.name !== undefined) {
    if (raw.date === undefined) throw invalidError("date is required when name is set");
    const decimals = raw.decimals === undefined ? undefined : uint(raw.decimals, "decimals");
    if (decimals !== undefined && decimals > 255) {
      throw invalidError("decimals must be 0..255");
    }
    return {
      ...base,
      name: str(raw.name, "name"),
      date: str(raw.date, "date"),
      ...(raw.time !== undefined ? { time: str(raw.time, "time") } : {}),
      ...(raw.ticker !== undefined ? { ticker: str(raw.ticker, "ticker") } : {}),
      ...(decimals !== undefined ? { decimals } : {}),
      ...(raw.image !== undefined ? { image: str(raw.image, "image") } : {}),
      ...(raw.image_hash !== undefined ? { image_hash: str(raw.image_hash, "image_hash") } : {}),
    };
  }
  return base;
}

function parseBuy(raw: Record<string, unknown>): BuildRequest {
  return {
    type: "buy",
    event_outpoint: outpoint(raw.event_outpoint, "event_outpoint"),
    event_covenant_id: hex64(raw.event_covenant_id, "event_covenant_id"),
    event_owner: hex64(raw.event_owner, "event_owner"),
    remaining: uint(raw.remaining, "remaining"),
    constants: parseConstants(raw.constants),
    buyer: hex64(raw.buyer, "buyer"),
    buyer_utxos: utxos(raw.buyer_utxos, "buyer_utxos"),
    change_spk: scriptSpk(raw.change_spk, "change_spk"),
    ...(raw.input_utxo_metas !== undefined
      ? { input_utxo_metas: utxoMetas(raw.input_utxo_metas, "input_utxo_metas") }
      : {}),
  };
}

function parseHandover(raw: Record<string, unknown>): BuildRequest {
  return {
    type: "handover",
    ticket_outpoint: outpoint(raw.ticket_outpoint, "ticket_outpoint"),
    event_covenant_id: hex64(raw.event_covenant_id, "event_covenant_id"),
    constants: parseConstants(raw.constants),
    attendee_utxos: utxos(raw.attendee_utxos, "attendee_utxos"),
    change_spk: scriptSpk(raw.change_spk, "change_spk"),
  };
}

function parseMarkUsed(raw: Record<string, unknown>): BuildRequest {
  return {
    type: "markUsed",
    ticket_outpoint: outpoint(raw.ticket_outpoint, "ticket_outpoint"),
    event_covenant_id: hex64(raw.event_covenant_id, "event_covenant_id"),
    constants: parseConstants(raw.constants),
    owner: hex64(raw.owner, "owner"),
    owner_utxos: utxos(raw.owner_utxos, "owner_utxos"),
    change_spk: scriptSpk(raw.change_spk, "change_spk"),
    ...(raw.input_utxo_metas !== undefined
      ? { input_utxo_metas: utxoMetas(raw.input_utxo_metas, "input_utxo_metas") }
      : {}),
  };
}

function resaleBase(raw: Record<string, unknown>) {
  return {
    ticket_outpoint: outpoint(raw.ticket_outpoint, "ticket_outpoint"),
    event_covenant_id: hex64(raw.event_covenant_id, "event_covenant_id"),
    constants: parseConstants(raw.constants),
  };
}

function fundingMetas(raw: Record<string, unknown>) {
  return raw.input_utxo_metas !== undefined
    ? { input_utxo_metas: utxoMetas(raw.input_utxo_metas, "input_utxo_metas") }
    : {};
}

function parseList(raw: Record<string, unknown>): BuildRequest {
  return {
    type: "list",
    ...resaleBase(raw),
    price: uint(raw.price, "price"),
    owner: hex64(raw.owner, "owner"),
    owner_utxos: utxos(raw.owner_utxos, "owner_utxos"),
    change_spk: scriptSpk(raw.change_spk, "change_spk"),
    ...fundingMetas(raw),
  };
}

function parseDelist(raw: Record<string, unknown>): BuildRequest {
  return {
    type: "delist",
    ...resaleBase(raw),
    owner: hex64(raw.owner, "owner"),
    owner_utxos: utxos(raw.owner_utxos, "owner_utxos"),
    change_spk: scriptSpk(raw.change_spk, "change_spk"),
    ...fundingMetas(raw),
  };
}

function parsePurchase(raw: Record<string, unknown>): BuildRequest {
  return {
    type: "purchase",
    ...resaleBase(raw),
    seller: hex64(raw.seller, "seller"),
    buyer: hex64(raw.buyer, "buyer"),
    price: uint(raw.price, "price"),
    buyer_utxos: utxos(raw.buyer_utxos, "buyer_utxos"),
    change_spk: scriptSpk(raw.change_spk, "change_spk"),
    ...fundingMetas(raw),
  };
}

/** Parse + validate the build request body into a typed `BuildRequest`. */
export function parseBuildRequest(raw: unknown): BuildRequest {
  if (!isRecord(raw)) throw invalidError("request body must be an object");
  const type = str(raw.type, "type");
  switch (type) {
    case "deploy":
      return parseDeploy(raw);
    case "buy":
      return parseBuy(raw);
    case "handover":
      return parseHandover(raw);
    case "markUsed":
      return parseMarkUsed(raw);
    case "list":
      return parseList(raw);
    case "delist":
      return parseDelist(raw);
    case "purchase":
      return parsePurchase(raw);
    default:
      throw invalidError(
        `type must be deploy|buy|handover|markUsed|list|delist|purchase, got ${type}`,
      );
  }
}

// --- kit -> wire mapping ----------------------------------------------------

export function toOutpoint(o: WireOutpoint): { txId: Uint8Array; index: number } {
  return { txId: hexToBytes(o.transaction_id), index: o.index };
}

export function toSpk(spk: WireScriptPublicKey): ScriptPublicKey {
  return { version: spk.version, script: spk.script };
}

/** Map wire constants (snake_case) to the compiler's camelCase view. */
export function toCompilerConstants(c: TicketConstantsJson): {
  authorizingTxId: string;
  price: number;
  orgSpk: string;
  burnTemplateHash: string;
} {
  return {
    authorizingTxId: c.authorizing_txid,
    price: c.price,
    orgSpk: c.org_spk,
    burnTemplateHash: c.burn_template_hash,
  };
}

/** The `org_spk` constant is the organizer payout script (HLD §2.1). */
export function orgPayoutSpk(orgSpkHex: string): ScriptPublicKey {
  return { version: 0, script: orgSpkHex };
}

export function toWireTx(tx: UnsignedTransaction): WireTransaction {
  return {
    version: tx.version,
    inputs: tx.inputs.map((input) => ({
      previous_outpoint: {
        transaction_id: input.previousOutpoint.txId.toLowerCase(),
        index: input.previousOutpoint.index,
      },
      signature_script: input.signatureScript,
      sequence: input.sequence,
      sig_op_count: input.sigOpCount,
    })),
    outputs: tx.outputs.map((output) => ({
      value: output.value,
      script_public_key: {
        version: output.scriptPublicKey.version,
        script: output.scriptPublicKey.script,
      },
      covenant: output.covenant
        ? {
            authorizing_input: output.covenant.authorizingInput,
            covenant_id: output.covenant.covenantId,
          }
        : null,
    })),
    lock_time: tx.lockTime,
    ...(tx.payload ? { payload: tx.payload } : {}),
  };
}

/** `WireTransaction` → upstream `SubmitTxModel` (mass / broadcast relay). */
export function toSubmitModel(tx: WireTransaction): SubmitTxModel {
  return {
    version: tx.version,
    inputs: tx.inputs.map((input) => ({
      previousOutpoint: {
        transactionId: input.previous_outpoint.transaction_id,
        index: input.previous_outpoint.index,
      },
      signatureScript: input.signature_script,
      sequence: input.sequence,
      sigOpCount: input.sig_op_count,
    })),
    outputs: tx.outputs.map((output) => ({
      amount: output.value,
      scriptPublicKey: {
        version: output.script_public_key.version,
        scriptPublicKey: output.script_public_key.script,
      },
    })),
    lockTime: tx.lock_time,
  };
}
