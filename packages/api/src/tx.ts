// kticket tx endpoints (HLD v0.22 §2.2 — POST /v1/tx/build, POST /v1/tx/broadcast).
//
// build: turns a client description of the transaction (type + inputs) into an
// unsigned v1 template, fee-aware:
//
//   1. build a provisional template (fee = 0) to learn the structure;
//   2. compute mass + compute_mass locally (the consensus formula — the public
//      `/transactions/mass` divides by output amount and 500s on the covenant
//      outputs every kticket tx carries);
//   3. `GET /info/fee-estimate` → priority bucket feerate (sompi/gram);
//   4. fee = max(feerate × mass, 100 × max(compute_mass, 2 × sizeBytes));
//   5. rebuild with the real fee so the change output sets `inputs − outputs = fee`.
//
// The wallet supplies its own UTXOs (it knows its balance — the API never holds
// keys); the API validates they cover the payouts + fee, then returns the
// unsigned template for the wallet to sign.
//
// broadcast: relay a signed tx → `{ txid }` over wRPC (kaspa-wasm RpcClient),
// preserving covenant bindings — the public REST submit model has no covenant
// field. Idempotent: re-broadcasting an already-known tx succeeds.

import {
  BURN_ARTIFACT,
  buildBuy,
  buildDeploy,
  buildHandover,
  buildTransfer,
  computeFee,
  computeMassLocal,
  type DecodedConstants,
  EVENT_ARTIFACT,
  estimatedSerializedSize,
  type ScriptPublicKey,
  type UnsignedTransaction,
} from "@kticket/kit";
import { hexToBytes } from "@noble/hashes/utils.js";
import { conflictError, invalidError, policyError } from "./errors.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import type { SubmitTxModel } from "./kaspa-types.js";
import { submitTransactionOverWrpc } from "./wrpc-client.js";

const HEX64 = /^[0-9a-fA-F]{64}$/;
const HEX = /^[0-9a-fA-F]+$/;

// --- wire shapes -----------------------------------------------------------

export interface WireOutpoint {
  transaction_id: string;
  index: number;
}

export interface WireUtxo extends WireOutpoint {
  value: number;
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
}

export interface TicketConstantsJson {
  event_id: string;
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
    }
  | {
      type: "transfer";
      ticket_outpoint: WireOutpoint;
      event_covenant_id: string;
      constants: TicketConstantsJson;
      new_owner: string;
      holder_utxos: WireUtxo[];
      change_spk: WireScriptPublicKey;
    }
  | {
      type: "handover";
      ticket_outpoint: WireOutpoint;
      event_covenant_id: string;
      constants: TicketConstantsJson;
      attendee_utxos: WireUtxo[];
      change_spk: WireScriptPublicKey;
    };

export interface BuildResult {
  template: WireTransaction;
  /** The computed fee breakdown (sompi). */
  fee: {
    fee: number;
    mass: number;
    compute_mass: number;
    size_bytes: number;
    feerate: number;
    floor: number;
    change: number;
  };
  /** Set for deploy — the event's covenant family id (HLD §2.1). */
  event_covenant_id?: string;
}

export interface BroadcastResult {
  txid: string;
}

export interface TxContext {
  kaspa: KaspaClientLike;
  /** wRPC network id ("mainnet" | "testnet-10") for the broadcast relay. */
  networkId: string;
}

// --- parse / validate ------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function hex64(value: unknown, label: string): string {
  const s = str(value, label).toLowerCase();
  if (!HEX64.test(s)) throw invalidError(`${label} must be 64 hex chars`);
  return s;
}

function hex(value: unknown, label: string): string {
  const s = str(value, label).toLowerCase();
  if (!HEX.test(s) || s.length === 0) throw invalidError(`${label} must be hex`);
  return s;
}

function int(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw invalidError(`${label} must be an integer`);
  }
  return value;
}

function uint(value: unknown, label: string): number {
  const n = int(value, label);
  if (n < 0) throw invalidError(`${label} must be non-negative`);
  return n;
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

function owner(value: unknown, label: string): string {
  return hex64(value, label);
}

function constants(value: unknown): TicketConstantsJson {
  if (!isRecord(value)) throw invalidError("constants must be an object");
  return {
    event_id: hex64(value.event_id, "constants.event_id"),
    price: uint(value.price, "constants.price"),
    org_spk: hex(value.org_spk, "constants.org_spk"),
    burn_template_hash: hex64(value.burn_template_hash, "constants.burn_template_hash"),
  };
}

function parseBuildRequest(raw: unknown): BuildRequest {
  if (!isRecord(raw)) throw invalidError("request body must be an object");
  const type = str(raw.type, "type");
  switch (type) {
    case "deploy": {
      const capacity = int(raw.capacity, "capacity");
      if (capacity < 0 || capacity > 100) throw invalidError("capacity must be 0..100");
      const authorizing = isRecord(raw.authorizing_outpoint) ? raw.authorizing_outpoint : {};
      return {
        type: "deploy",
        capacity,
        constants: constants(raw.constants),
        organizer: owner(raw.organizer, "organizer"),
        authorizing_outpoint: {
          ...outpoint(authorizing, "authorizing_outpoint"),
          value: uint(authorizing.value, "authorizing_outpoint.value"),
        },
        organizer_utxos: utxos(raw.organizer_utxos, "organizer_utxos"),
        change_spk: scriptSpk(raw.change_spk, "change_spk"),
      };
    }
    case "buy":
      return {
        type: "buy",
        event_outpoint: outpoint(raw.event_outpoint, "event_outpoint"),
        event_covenant_id: hex64(raw.event_covenant_id, "event_covenant_id"),
        event_owner: owner(raw.event_owner, "event_owner"),
        remaining: uint(raw.remaining, "remaining"),
        constants: constants(raw.constants),
        buyer: owner(raw.buyer, "buyer"),
        buyer_utxos: utxos(raw.buyer_utxos, "buyer_utxos"),
        change_spk: scriptSpk(raw.change_spk, "change_spk"),
      };
    case "transfer":
      return {
        type: "transfer",
        ticket_outpoint: outpoint(raw.ticket_outpoint, "ticket_outpoint"),
        event_covenant_id: hex64(raw.event_covenant_id, "event_covenant_id"),
        constants: constants(raw.constants),
        new_owner: owner(raw.new_owner, "new_owner"),
        holder_utxos: utxos(raw.holder_utxos, "holder_utxos"),
        change_spk: scriptSpk(raw.change_spk, "change_spk"),
      };
    case "handover":
      return {
        type: "handover",
        ticket_outpoint: outpoint(raw.ticket_outpoint, "ticket_outpoint"),
        event_covenant_id: hex64(raw.event_covenant_id, "event_covenant_id"),
        constants: constants(raw.constants),
        attendee_utxos: utxos(raw.attendee_utxos, "attendee_utxos"),
        change_spk: scriptSpk(raw.change_spk, "change_spk"),
      };
    default:
      throw invalidError(`type must be deploy|buy|transfer|handover, got ${type}`);
  }
}

// --- builders --------------------------------------------------------------

function toOutpoint(o: WireOutpoint): { txId: Uint8Array; index: number } {
  return { txId: hexToBytes(o.transaction_id), index: o.index };
}

/** Artifact `code` is a hex string; the kit builders want bytes. */
function codeBytes(hexCode: string): Uint8Array {
  return hexToBytes(hexCode);
}

function toSpk(spk: WireScriptPublicKey): ScriptPublicKey {
  return { version: spk.version, script: spk.script };
}

function toDecodedConstants(c: TicketConstantsJson): DecodedConstants {
  return {
    eventId: hexToBytes(c.event_id),
    price: c.price,
    orgSpk: hexToBytes(c.org_spk),
    burnTemplateHash: hexToBytes(c.burn_template_hash),
  };
}

/** The `org_spk` constant is the organizer payout script (HLD §2.1). */
function orgPayoutSpk(orgSpkHex: string): ScriptPublicKey {
  return { version: 0, script: orgSpkHex };
}

function toWireTx(tx: UnsignedTransaction): WireTransaction {
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
  };
}

/** Kit template → upstream `SubmitTxModel` (mass / broadcast relay). */
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

type PreparedBuild = {
  build: (fee: number) => UnsignedTransaction;
  inputTotal: number;
  payouts: readonly number[];
};

function deployBuild(req: BuildRequest & { type: "deploy" }): PreparedBuild {
  const constants = toDecodedConstants(req.constants);
  const values = [req.authorizing_outpoint.value, ...req.organizer_utxos.map((u) => u.value)];
  return {
    inputTotal: values.reduce((a, b) => a + b, 0),
    payouts: [],
    build: (fee) =>
      buildDeploy({
        authorizingOutpoint: toOutpoint(req.authorizing_outpoint),
        organizerUtxos: req.organizer_utxos.map((u) => toOutpoint(u)),
        organizerUtxoValues: values,
        organizer: hexToBytes(req.organizer),
        capacity: req.capacity,
        constants,
        covenantCode: codeBytes(EVENT_ARTIFACT.code),
        changeScript: toSpk(req.change_spk),
        fee,
        network: "testnet10",
      }).tx,
  };
}

function buyBuild(req: BuildRequest & { type: "buy" }): PreparedBuild {
  const constants = toDecodedConstants(req.constants);
  return {
    inputTotal: req.buyer_utxos.reduce((a, u) => a + u.value, 0),
    payouts: req.constants.price > 0 ? [req.constants.price] : [],
    build: (fee) =>
      buildBuy({
        eventOutpoint: toOutpoint(req.event_outpoint),
        eventCovenantId: req.event_covenant_id,
        eventOwner: hexToBytes(req.event_owner),
        constants,
        buyer: hexToBytes(req.buyer),
        buyerUtxos: req.buyer_utxos.map((u) => toOutpoint(u)),
        buyerUtxoValues: req.buyer_utxos.map((u) => u.value),
        orgScript: orgPayoutSpk(req.constants.org_spk),
        changeScript: toSpk(req.change_spk),
        covenantCode: codeBytes(EVENT_ARTIFACT.code),
        remaining: req.remaining,
        network: "testnet10",
        fee,
      }),
  };
}

function transferBuild(req: BuildRequest & { type: "transfer" }): PreparedBuild {
  const constants = toDecodedConstants(req.constants);
  return {
    inputTotal: req.holder_utxos.reduce((a, u) => a + u.value, 0),
    payouts: [],
    build: (fee) =>
      buildTransfer({
        ticketOutpoint: toOutpoint(req.ticket_outpoint),
        eventCovenantId: req.event_covenant_id,
        constants,
        newOwner: hexToBytes(req.new_owner),
        holderUtxos: req.holder_utxos.map((u) => toOutpoint(u)),
        holderUtxoValues: req.holder_utxos.map((u) => u.value),
        changeScript: toSpk(req.change_spk),
        covenantCode: codeBytes(EVENT_ARTIFACT.code),
        network: "testnet10",
        fee,
      }),
  };
}

function handoverBuild(req: BuildRequest & { type: "handover" }): PreparedBuild {
  const constants = toDecodedConstants(req.constants);
  return {
    inputTotal: req.attendee_utxos.reduce((a, u) => a + u.value, 0),
    payouts: [],
    build: (fee) =>
      buildHandover({
        ticketOutpoint: toOutpoint(req.ticket_outpoint),
        eventCovenantId: req.event_covenant_id,
        constants,
        burnCode: codeBytes(BURN_ARTIFACT.code),
        attendeeUtxos: req.attendee_utxos.map((u) => toOutpoint(u)),
        attendeeUtxoValues: req.attendee_utxos.map((u) => u.value),
        changeScript: toSpk(req.change_spk),
        network: "testnet10",
        fee,
      }),
  };
}

// --- build flow ------------------------------------------------------------

async function buildFeeAware(prepared: PreparedBuild, kaspa: KaspaClientLike) {
  let provisional: UnsignedTransaction;
  try {
    provisional = prepared.build(0);
  } catch (err) {
    throw policyError(err instanceof Error ? err.message : "inputs cannot cover the payouts");
  }

  const sizeBytes = estimatedSerializedSize(provisional);
  const massResult = computeMassLocal(provisional);
  const feerate = (await kaspa.getFeeEstimate()).priorityBucket.feerate;

  let fee: number;
  let floor: number;
  let change: number;
  try {
    const result = computeFee({
      mass: massResult.mass,
      sizeBytes,
      feerateSompiPerGram: feerate,
      inputTotal: prepared.inputTotal,
      payouts: prepared.payouts,
      computeMass: massResult.compute_mass,
    });
    fee = result.fee;
    floor = result.floor;
    change = result.change;
  } catch (err) {
    throw policyError(err instanceof Error ? err.message : "inputs cannot cover payouts + fee");
  }

  let tx: UnsignedTransaction;
  try {
    tx = prepared.build(fee);
  } catch (err) {
    throw policyError(err instanceof Error ? err.message : "inputs cannot cover payouts + fee");
  }

  return {
    tx,
    mass: massResult.mass,
    computeMass: massResult.compute_mass,
    sizeBytes,
    feerate,
    floor,
    fee,
    change,
  };
}

export async function buildTransaction(raw: unknown, ctx: TxContext): Promise<BuildResult> {
  const request = parseBuildRequest(raw);
  const prepared =
    request.type === "deploy"
      ? deployBuild(request)
      : request.type === "buy"
        ? buyBuild(request)
        : request.type === "transfer"
          ? transferBuild(request)
          : handoverBuild(request);

  const computed = await buildFeeAware(prepared, ctx.kaspa);

  const result: BuildResult = {
    template: toWireTx(computed.tx),
    fee: {
      fee: computed.fee,
      mass: computed.mass,
      compute_mass: computed.computeMass,
      size_bytes: computed.sizeBytes,
      feerate: computed.feerate,
      floor: computed.floor,
      change: computed.change,
    },
  };

  if (request.type === "deploy") {
    const deploy = buildDeploy({
      authorizingOutpoint: toOutpoint(request.authorizing_outpoint),
      organizerUtxos: request.organizer_utxos.map((u) => toOutpoint(u)),
      organizerUtxoValues: [
        request.authorizing_outpoint.value,
        ...request.organizer_utxos.map((u) => u.value),
      ],
      organizer: hexToBytes(request.organizer),
      capacity: request.capacity,
      constants: toDecodedConstants(request.constants),
      covenantCode: codeBytes(EVENT_ARTIFACT.code),
      changeScript: toSpk(request.change_spk),
      fee: computed.fee,
      network: "testnet10",
    });
    result.event_covenant_id = deploy.eventCovenantId;
  }

  return result;
}

// --- broadcast -------------------------------------------------------------

function parseBroadcastRequest(raw: unknown): WireTransaction {
  if (!isRecord(raw)) throw invalidError("request body must be an object");
  const tx = raw.transaction;
  if (!isRecord(tx)) throw invalidError("transaction must be an object");
  const version = int(tx.version, "transaction.version");
  if (version < 1) throw invalidError("transaction.version must be >= 1 (v1 template)");
  return {
    version,
    inputs: parseInputs(tx.inputs),
    outputs: parseOutputs(tx.outputs),
    lock_time: uint(tx.lock_time ?? 0, "transaction.lock_time"),
  };
}

function parseInputs(value: unknown): WireInput[] {
  if (!Array.isArray(value)) throw invalidError("transaction.inputs must be an array");
  return value.map((entry, i) => {
    if (!isRecord(entry)) throw invalidError(`transaction.inputs[${i}] must be an object`);
    const previous = isRecord(entry.previous_outpoint) ? entry.previous_outpoint : {};
    return {
      previous_outpoint: {
        transaction_id: hex64(
          previous.transaction_id,
          `transaction.inputs[${i}].previous_outpoint.transaction_id`,
        ),
        index: uint(previous.index, `transaction.inputs[${i}].previous_outpoint.index`),
      },
      signature_script: str(
        entry.signature_script ?? "",
        `transaction.inputs[${i}].signature_script`,
      ),
      sequence: uint(entry.sequence ?? 0, `transaction.inputs[${i}].sequence`),
      sig_op_count: uint(entry.sig_op_count ?? 1, `transaction.inputs[${i}].sig_op_count`),
    };
  });
}

function parseOutputs(value: unknown): WireOutput[] {
  if (!Array.isArray(value)) throw invalidError("transaction.outputs must be an array");
  return value.map((entry, i) => {
    if (!isRecord(entry)) throw invalidError(`transaction.outputs[${i}] must be an object`);
    const spk = isRecord(entry.script_public_key) ? entry.script_public_key : {};
    const covenant = entry.covenant;
    if (covenant !== null && covenant !== undefined && !isRecord(covenant)) {
      throw invalidError(`transaction.outputs[${i}].covenant must be an object or null`);
    }
    return {
      value: uint(entry.value, `transaction.outputs[${i}].value`),
      script_public_key: {
        version: int(spk.version, `transaction.outputs[${i}].script_public_key.version`),
        script: hex(spk.script, `transaction.outputs[${i}].script_public_key.script`),
      },
      covenant:
        covenant === null || covenant === undefined
          ? null
          : {
              authorizing_input: uint(
                covenant.authorizing_input,
                `transaction.outputs[${i}].covenant.authorizing_input`,
              ),
              covenant_id: hex64(
                covenant.covenant_id,
                `transaction.outputs[${i}].covenant.covenant_id`,
              ),
            },
    };
  });
}

/** Classify an upstream rejection message into the taxonomy (invalid / conflict / policy). */
export function mapRejection(message: string): never {
  const m = message.toLowerCase();
  if (m.includes("double spend") || m.includes("already") || m.includes("orphan")) {
    throw conflictError("transaction rejected: double spend or already known", { detail: message });
  }
  if (m.includes("fee") || m.includes("mass")) {
    throw policyError("transaction rejected: fee policy", { detail: message });
  }
  throw invalidError("transaction rejected", { detail: message });
}

export async function broadcastTransaction(raw: unknown, ctx: TxContext): Promise<BroadcastResult> {
  const tx = parseBroadcastRequest(raw);
  try {
    const txid = await submitTransactionOverWrpc(ctx.networkId, tx);
    return { txid: txid.toLowerCase() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw mapRejection(message);
  }
}
