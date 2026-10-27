// Transaction builders (KTK-88 A5).
//
// Each builder returns an *unsigned* v1 transaction template with covenant
// bindings set. Fee handling: the fee payer's UTXOs are inputs and a change
// output is derived so `sum(inputs) − sum(outputs) = fee`.
//
//   prep     — the KCC-23 preparation tx: spends the organizer's KAS into one
//              P2PK output and declares the event metadata in its payload.
//   deploy   — one event covenant (remaining = capacity, ~0.5 KAS dust,
//              price baked in the compiled bytecode). Its authorizing input is
//              the prep tx output, so the covenant id commits to the metadata.
//              No per-ticket pre-creation.
//   buy      — the event covenant splits: ticket (amount=1, buyer) + event
//              covenant (remaining−1) + org payout (price) + change. Buyer pays
//              price + ticket dust + fee.
//   handover — consume the ticket into this event's burn-owner covenant
//              (unspendable) — the ticket, dust included, is gone.
//
// covenant_id pin (KIP-20, spike d): per-family. The deploy binds the event
// covenant output to the event_cov_id; buy / handover continuation outputs
// carry the same covenant_id as the covenant UTXO they spend.

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { CompiledContractArtifact } from "../contracts/artifact.js";
import type { AddressNetwork } from "./address.js";
import { injectState, scriptHash } from "./address.js";
import type { AuthorizedOutput, Outpoint } from "./covenant.js";
import { covenantId } from "./covenant.js";
import type { DecodedState } from "./preimage.js";
import type {
  CovenantBinding,
  ScriptPublicKey,
  TxInput,
  TxOutput,
  UnsignedTransaction,
} from "./tx.js";
import { TX_VERSION_V1 } from "./tx.js";

const TEXT_ENCODER = new TextEncoder();
/** Strict UTF-8: an invalid byte makes the payload invalid (KCC-23 §3.1). */
const STRICT_TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

// --- KCC-23 metadata declaration (bound to the covenant id) -----------------
//
// KCC-23 binds display metadata to a covenant id. A version 1 *preparation*
// transaction carries `0x00 || UTF-8 JSON` in its payload and creates an output
// the genesis transaction spends; the covenant id commits to that spent
// outpoint, whose txid commits to the payload. Declaring metadata on the
// genesis tx payload instead would not be committed to the token.
//
// kticket's event fields (name/date/time/priceKAS/orgSpk) live next to the
// ecosystem token keys (ticker/decimals/image/image_hash) in the same JSON
// object. KCC-23 leaves field names to ecosystem conventions and unknown keys
// are ignored on read.

/** KCC-23 codec prefix: `0x00` declares the rest of the payload is one JSON object. */
export const KCC23_JSON_CODEC = "00";

/** JSON nesting KCC-23 allows, counting the root object as depth 1. */
const KCC23_MAX_DEPTH = 64;

/**
 * The metadata declaration written into a preparation transaction's payload.
 *
 * The burn template hash is deliberately absent: it is derived from the
 * preparation txid at compile time, so declaring it would make the payload
 * depend on its own transaction id.
 */
export interface MetadataDeclaration {
  name: string;
  date: string;
  /** Local wall-clock start time (HH:MM) — optional for legacy events. */
  time?: string;
  priceKAS: number;
  orgSpk: string;
  /** Short ticker (<= 12 code points). `symbol` is read as an alias. */
  ticker?: string;
  /** Display decimals (0..255, default 0). */
  decimals?: number;
  /** Poster art URI — https:// or ipfs://. */
  image?: string;
  /** sha256 of the image bytes, 64 lowercase hex. */
  image_hash?: string;
}

/** A decoded declaration, plus the advisory fields legacy deploys carried. */
export interface EventMetadata extends MetadataDeclaration {
  /**
   * Advisory burn-template hash, decoded only from legacy payloads. Current
   * deploys derive it from the preparation txid instead.
   */
  burnTemplateHash?: string;
}

/** KCC-23 I-JSON rules: finite numbers, at most 64 levels of nesting. */
function assertJsonDeclaration(value: unknown, depth = 1): void {
  if (depth > KCC23_MAX_DEPTH) {
    throw new Error(`KCC-23 metadata must nest at most ${KCC23_MAX_DEPTH} levels`);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("KCC-23 metadata numbers must be finite");
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonDeclaration(item, depth + 1);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) assertJsonDeclaration(item, depth + 1);
  }
}

/**
 * Encode a KCC-23 declaration: the `0x00` codec byte followed by the UTF-8 JSON
 * object, hex-encoded as the transaction payload.
 */
export function encodeMetadataPayload(meta: MetadataDeclaration): string {
  const declaration = {
    name: meta.name,
    ...(meta.ticker !== undefined ? { ticker: meta.ticker } : {}),
    ...(meta.decimals !== undefined ? { decimals: meta.decimals } : {}),
    ...(meta.image !== undefined ? { image: meta.image } : {}),
    ...(meta.image_hash !== undefined ? { image_hash: meta.image_hash } : {}),
    date: meta.date,
    ...(meta.time !== undefined ? { time: meta.time } : {}),
    priceKAS: meta.priceKAS,
    orgSpk: meta.orgSpk,
  };
  assertJsonDeclaration(declaration);
  return KCC23_JSON_CODEC + bytesToHex(TEXT_ENCODER.encode(JSON.stringify(declaration)));
}

/** True when the payload starts with the KCC-23 JSON codec byte. */
export function isKcc23Payload(payloadHex: string | null | undefined): boolean {
  if (!payloadHex) return false;
  return payloadHex.toLowerCase().startsWith(KCC23_JSON_CODEC);
}

/** KCC-23 string hygiene: trimmed, no control chars, at most `max` code points. */
function cleanLabel(value: unknown, maxCodePoints: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || [...trimmed].length > maxCodePoints) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

/** Token decimals: integer or base-10 string, 0..255. */
function decodeDecimals(value: unknown): number | undefined {
  let n: number | undefined;
  if (typeof value === "number" && Number.isInteger(value)) {
    n = value;
  } else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    n = Number(value.trim());
  }
  if (n === undefined || n < 0 || n > 255) return undefined;
  return n;
}

/** Poster art: https:// or ipfs:// URI, at most 256 code points. */
function decodeImage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if ([...trimmed].length > 256) return undefined;
  if (!/^(https|ipfs):\/\//i.test(trimmed)) return undefined;
  return trimmed;
}

/** Image sha256: 64 hex chars, normalized to lowercase. */
function decodeImageHash(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) return undefined;
  return trimmed.toLowerCase();
}

/** Read the optional ecosystem token keys, dropping values that violate their constraints. */
function kccKeysFrom(parsed: Record<string, unknown>): Pick<
  EventMetadata,
  "ticker" | "decimals" | "image" | "image_hash"
> {
  const ticker = cleanLabel(parsed.ticker, 12) ?? cleanLabel(parsed.symbol, 12);
  const decimals = decodeDecimals(parsed.decimals);
  const image = decodeImage(parsed.image);
  const image_hash = decodeImageHash(parsed.image_hash);
  return {
    ...(ticker !== undefined ? { ticker } : {}),
    ...(decimals !== undefined ? { decimals } : {}),
    ...(image !== undefined ? { image } : {}),
    ...(image_hash !== undefined ? { image_hash } : {}),
  };
}

/**
 * Decode a kticket metadata declaration.
 *
 * Accepts the KCC-23 form (`0x00` codec byte + UTF-8 JSON object) and the
 * legacy form (bare hex-encoded JSON, where metadata was attached to the
 * genesis tx payload), so already-deployed events still verify. Returns `null`
 * when the payload is not a valid kticket declaration — unknown codec bytes,
 * a BOM, invalid UTF-8, non-object JSON, non-finite numbers, or nesting beyond
 * KCC-23's 64 levels.
 *
 * New deploys read the readable field names; the oldest events used `{n, d, p}`.
 */
export function decodeMetadataFromPayload(payloadHex: string | null | undefined): EventMetadata | null {
  if (!payloadHex) return null;
  try {
    const bytes = hexToBytes(payloadHex);
    if (bytes.length === 0) return null;
    // KCC-23 prefixes the JSON with the `0x00` codec byte; legacy payloads are
    // the bare JSON bytes (they start with `{`).
    const body = bytes[0] === 0x00 ? bytes.subarray(1) : bytes;
    // A BOM is forbidden by KCC-23 and never valid legacy JSON either.
    if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
      return null;
    }
    const json = STRICT_TEXT_DECODER.decode(body);
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    assertJsonDeclaration(parsed);
    const record = parsed as Record<string, unknown>;

    // Current format — readable names, self-describing. (Legacy payloads may
    // also carry the ecosystem token keys; unknown keys are ignored.)
    if (
      typeof record.name === "string" &&
      typeof record.date === "string" &&
      typeof record.priceKAS === "number" &&
      typeof record.orgSpk === "string"
    ) {
      return {
        name: record.name,
        date: record.date,
        ...(typeof record.time === "string" ? { time: record.time } : {}),
        priceKAS: record.priceKAS,
        orgSpk: record.orgSpk,
        ...(typeof record.burnTemplateHash === "string"
          ? { burnTemplateHash: record.burnTemplateHash }
          : {}),
        ...kccKeysFrom(record),
      };
    }

    // Legacy format — {n, d, p} (no orgSpk/burnTemplateHash)
    if (
      typeof record.n === "string" &&
      typeof record.d === "string" &&
      typeof record.p === "number"
    ) {
      return {
        name: record.n,
        date: record.d,
        priceKAS: record.p / 100_000_000,
        orgSpk: "",
      };
    }

    return null;
  } catch {
    return null;
  }
}

export { FEE_PAYER } from "./tx.js";

/** OP_HASH256 (Kaspa P2SH) — the standard script form the node accepts. */
const OP_HASH256 = 0xaa;
/** OP_EQUAL — closes the P2SH script. */
const OP_EQUAL = 0x87;
/** P2SH push length opcode for a 32-byte script hash. */
const PUSH32 = 0x20;

/**
 * P2SH script public key for a redeem script (blake3-32 script hash) in the
 * standard Kaspa form `aa20 <hash> 87` — the shape `payToScriptHashScript`
 * produces on-chain (forge reference). A bare 32-byte hash is not a standard
 * script and the node rejects it.
 */
export function p2shScript(redeemScript: Uint8Array): ScriptPublicKey {
  const hash = scriptHash(redeemScript);
  const script = new Uint8Array(1 + 1 + hash.length + 1);
  script[0] = OP_HASH256;
  script[1] = PUSH32;
  script.set(hash, 2);
  script[2 + hash.length] = OP_EQUAL;
  return { version: 0, script: bytesToHex(script) };
}

function covenantScript(artifact: CompiledContractArtifact, state: DecodedState): ScriptPublicKey {
  return p2shScript(injectState(artifact, state));
}

/**
 * The event's burn-owner output script public key — the successor every
 * handover must create (FR-9). The burn contract is compiled per event with its
 * `authorizing_txid` baked; its bytecode is unspendable and fixed.
 */
export function burnScript(burnArtifact: CompiledContractArtifact): ScriptPublicKey {
  return p2shScript(Uint8Array.from(burnArtifact.bytecode));
}

/**
 * Hex script hash of an event's burn-owner covenant output — the "burn
 * template" a handover must create (HLD §2.1). The reader (HLD §2.2) compares a
 * handover successor's on-chain `aa20 <hash> 87` script against this to report
 * GONE. This is the blake3-32 P2SH script hash of the burn redeem script (the
 * burn artifact's full bytecode) — not the silverscript `template_hash`.
 */
export function burnTemplateHash(burnArtifact: CompiledContractArtifact): string {
  return bytesToHex(scriptHash(Uint8Array.from(burnArtifact.bytecode)));
}

function asInput(outpoint: Outpoint): TxInput {
  return {
    previousOutpoint: { txId: bytesToHex(outpoint.txId), index: outpoint.index },
    signatureScript: "",
    sequence: 0,
    sigOpCount: COMPUTE_BUDGET,
  };
}

function changeOutput(script: ScriptPublicKey, change: number): TxOutput {
  return { value: change, scriptPublicKey: script, covenant: null };
}

function totalOf(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/** Maximum event capacity (the event covenant's `remaining` cannot exceed it). */
export const MAX_EVENT_CAPACITY = 100;

/**
 * Compute budget committed on each v1 input (v1 wire `sig_op_count` shim). Each
 * unit grants 10,000 script units; a covenant transition check needs ~100,000
 * units, so 10 is the floor — forge uses 50 for headroom.
 */
export const COMPUTE_BUDGET = 50;

/** Default covenant dust locked in an output (~0.5 KAS). */
export const DUST = 50_000_000;

/** Default covenant dust for a ticket output (~0.5 KAS). */
export const TICKET_DUST = DUST;

/** Default covenant dust for the event covenant (~0.5 KAS). */
export const EVENT_DUST = DUST;

function validatePairedValues(
  values: readonly number[],
  outpoints: readonly Outpoint[],
  label: string,
): void {
  if (values.length !== outpoints.length) {
    throw new Error(`${label} values must match the ${label} input count`);
  }
}

/** Covenant binding every continuation output carries (input 0, pinned family id). */
function covenantBinding(id: string): CovenantBinding {
  return { authorizingInput: 0, covenantId: id };
}

/** Dust carried by a ticket-style output (defaults to the standard ticket dust). */
function ticketDustOf(ticketDust: number | undefined): number {
  return ticketDust ?? TICKET_DUST;
}

function payerInputs(utxos: readonly Outpoint[]): TxInput[] {
  return utxos.map(asInput);
}

function inputsWithTicket(ticketOutpoint: Outpoint, payers: readonly Outpoint[]): TxInput[] {
  return [asInput(ticketOutpoint), ...payerInputs(payers)];
}

// --- deploy (preparation tx + one event covenant) ---------------------------
//
// KCC-23 deploys are two transactions:
//
//   prep    — spends the organizer's KAS, creates one P2PK output, and carries
//             the `0x00 || UTF-8 JSON` metadata declaration in its payload.
//   genesis — spends that prep output (input 0, the authorizing input) and
//             creates the event covenant, so the covenant id commits to the
//             metadata through the prep txid.

export interface MetadataPrepInput {
  /** Funding UTXOs the preparation tx spends (the organizer's KAS). */
  payerUtxos: readonly Outpoint[];
  /** Values (sompi) of those inputs, in input order. */
  payerUtxoValues: readonly number[];
  /** The organizer's P2PK output script — the output the genesis tx spends. */
  ownerScript: ScriptPublicKey;
  /** Network fee in sompi (paid by the organizer). */
  fee: number;
  /** The KCC-23 declaration bound to the event's covenant id (absent for a
   *  nameless deploy — the prep tx then simply has no payload). */
  metadata?: MetadataDeclaration;
}

/**
 * Build the KCC-23 preparation transaction: it spends the organizer's UTXOs
 * into one P2PK output and commits the metadata declaration in its payload.
 *
 * The output the event covenant's genesis transaction spends must be output 0,
 * so a single output (all inputs minus the fee) keeps the binding unambiguous —
 * there is no change output to confuse the reading.
 */
export function buildMetadataPrep(input: MetadataPrepInput): UnsignedTransaction {
  if (!Number.isSafeInteger(input.fee) || input.fee < 0) {
    throw new Error(`fee ${input.fee} is invalid`);
  }
  validatePairedValues(input.payerUtxoValues, input.payerUtxos, "payer");
  if (input.payerUtxos.length === 0) {
    throw new Error("a preparation transaction needs at least one input");
  }
  const total = totalOf(input.payerUtxoValues);
  const value = total - input.fee;
  if (value <= 0) {
    throw new Error(`payer inputs ${total} cannot cover the preparation fee ${input.fee}`);
  }
  return {
    version: TX_VERSION_V1,
    inputs: payerInputs(input.payerUtxos),
    outputs: [{ value, scriptPublicKey: input.ownerScript, covenant: null }],
    lockTime: 0,
    ...(input.metadata ? { payload: encodeMetadataPayload(input.metadata) } : {}),
  };
}

export interface DeployInput {
  /**
   * The preparation transaction's output 0 — the authorizing input. The event
   * covenant id commits to this outpoint (and therefore to the KCC-23
   * metadata in the prep tx payload).
   */
  authorizingOutpoint: Outpoint;
  /** Additional organizer KAS UTXOs funding the fee. */
  organizerUtxos: Outpoint[];
  /** Values (sompi) of every organizer input, incl. the authorizing one. */
  organizerUtxoValues: readonly number[];
  /** Organizer's 32-byte owner identifier (pubkey). */
  organizer: Uint8Array;
  /** Event capacity — becomes the event covenant's `remaining`. */
  capacity: number;
  /** The per-event compiled Event contract artifact. */
  eventArtifact: CompiledContractArtifact;
  /** Change address for the organizer. */
  changeScript: ScriptPublicKey;
  /** Network fee in sompi (paid by the organizer). */
  fee: number;
  network: AddressNetwork;
}

export interface DeployResult {
  tx: UnsignedTransaction;
  /** Per-family covenant_id of the event (all minted tickets share it). */
  eventCovenantId: string;
  /** The event covenant output's index (0). */
  eventOutputIndex: number;
}

function validateDeploy(input: DeployInput): number {
  if (
    !Number.isInteger(input.capacity) ||
    input.capacity < 0 ||
    input.capacity > MAX_EVENT_CAPACITY
  ) {
    throw new Error(`capacity must be 0..${MAX_EVENT_CAPACITY}, got ${input.capacity}`);
  }
  if (!Number.isSafeInteger(input.fee) || input.fee < 0) {
    throw new Error(`fee ${input.fee} is invalid`);
  }

  const allUtxos = [input.authorizingOutpoint, ...input.organizerUtxos];
  validatePairedValues(input.organizerUtxoValues, allUtxos, "organizer");
  return totalOf(input.organizerUtxoValues);
}

function eventCovenantIdOf(authorizingOutpoint: Outpoint, eventScript: ScriptPublicKey): string {
  const authOutputs: AuthorizedOutput[] = [
    {
      index: 0,
      value: EVENT_DUST,
      version: eventScript.version,
      script: hexToBytes(eventScript.script),
    },
  ];
  return bytesToHex(covenantId(authorizingOutpoint, authOutputs));
}

export function buildDeploy(input: DeployInput): DeployResult {
  const allUtxos = [input.authorizingOutpoint, ...input.organizerUtxos];
  const inputTotal = validateDeploy(input);
  const change = inputTotal - input.fee - EVENT_DUST;
  if (change < 0) {
    throw new Error(
      `organizer inputs ${inputTotal} cannot cover dust ${EVENT_DUST} + fee ${input.fee}`,
    );
  }

  const eventState: DecodedState = {
    owner: input.organizer,
    identifierType: 0,
    amount: input.capacity,
    isMinter: false,
    used: false,
    salePrice: 0,
  };
  const eventScript = covenantScript(input.eventArtifact, eventState);
  const eventCovenantId = eventCovenantIdOf(input.authorizingOutpoint, eventScript);

  return {
    tx: {
      version: TX_VERSION_V1,
      inputs: payerInputs(allUtxos),
      outputs: [
        {
          value: EVENT_DUST,
          scriptPublicKey: eventScript,
          covenant: covenantBinding(eventCovenantId),
        },
        changeOutput(input.changeScript, change),
      ],
      lockTime: 0,
    },
    eventCovenantId,
    eventOutputIndex: 0,
  };
}

// --- buy (mint on sale) ----------------------------------------------------

export interface BuyInput {
  /** The event covenant UTXO (input index 0). */
  eventOutpoint: Outpoint;
  /** The event covenant's covenant_id (= event_cov_id). */
  eventCovenantId: string;
  /** The event covenant's current owner identifier (preserved). */
  eventOwner: Uint8Array;
  /** The per-event compiled Event contract artifact. */
  eventArtifact: CompiledContractArtifact;
  /** Buyer's 32-byte owner identifier (pubkey). */
  buyer: Uint8Array;
  /** Buyer KAS UTXOs covering price + ticket dust + fee (fee payer = buyer). */
  buyerUtxos: Outpoint[];
  /** Buyer input values (sompi). */
  buyerUtxoValues: readonly number[];
  /** Organizer payout script public key (`org_spk`). */
  orgScript: ScriptPublicKey;
  /** Buyer change script public key. */
  changeScript: ScriptPublicKey;
  /** Current `remaining` on the event covenant (must be > 0). */
  remaining: number;
  /** Price per ticket in sompi (0 = free). */
  price: number;
  network: AddressNetwork;
  /** Network fee in sompi (paid by the buyer). */
  fee: number;
  /** Dust locked in the minted ticket output. */
  ticketDust?: number;
}

export function buildBuy(input: BuyInput): UnsignedTransaction {
  const price = input.price;
  validatePairedValues(input.buyerUtxoValues, input.buyerUtxos, "buyer");
  if (!Number.isInteger(input.remaining) || input.remaining <= 0) {
    throw new Error(`cannot mint from an event with remaining ${input.remaining}`);
  }
  const ticketDust = ticketDustOf(input.ticketDust);
  const buyerTotal = totalOf(input.buyerUtxoValues);
  const change = buyerTotal - price - ticketDust - input.fee;
  if (change < 0) {
    throw new Error(
      `buyer inputs ${buyerTotal} cannot cover price ${price} + ticket dust ${ticketDust} + fee ${input.fee}`,
    );
  }

  const binding = covenantBinding(input.eventCovenantId);
  const ticket = covenantScript(
    input.eventArtifact,
    { owner: input.buyer, identifierType: 0, amount: 1, isMinter: false, used: false, salePrice: 0 },
  );
  const remainingEvent = covenantScript(
    input.eventArtifact,
    { owner: input.eventOwner, identifierType: 0, amount: input.remaining - 1, isMinter: false, used: false, salePrice: 0 },
  );

  const outputs: TxOutput[] = [
    { value: ticketDust, scriptPublicKey: ticket, covenant: binding },
    { value: EVENT_DUST, scriptPublicKey: remainingEvent, covenant: binding },
  ];
  if (price > 0) {
    outputs.push({ value: price, scriptPublicKey: input.orgScript, covenant: null });
  }
  outputs.push(changeOutput(input.changeScript, change));

  return {
    version: TX_VERSION_V1,
    inputs: inputsWithTicket(input.eventOutpoint, input.buyerUtxos),
    outputs,
    lockTime: 0,
  };
}

// --- handover (consume into the burn-owner covenant) -----------------------

export interface HandoverInput {
  ticketOutpoint: Outpoint;
  eventCovenantId: string;
  /** The per-event compiled Burn contract artifact (unspendable). */
  burnArtifact: CompiledContractArtifact;
  /** Attendee KAS UTXOs covering the fee (fee payer = attendee). */
  attendeeUtxos: Outpoint[];
  attendeeUtxoValues: readonly number[];
  changeScript: ScriptPublicKey;
  network: AddressNetwork;
  fee: number;
  /** Dust consumed with the ticket (rides into the burn output). */
  ticketDust?: number;
}

export function buildHandover(input: HandoverInput): UnsignedTransaction {
  validatePairedValues(input.attendeeUtxoValues, input.attendeeUtxos, "attendee");
  const change = totalOf(input.attendeeUtxoValues) - input.fee;
  if (change < 0) {
    throw new Error(`attendee inputs cannot cover fee ${input.fee}`);
  }

  const binding = covenantBinding(input.eventCovenantId);
  return {
    version: TX_VERSION_V1,
    inputs: inputsWithTicket(input.ticketOutpoint, input.attendeeUtxos),
    outputs: [
      {
        value: ticketDustOf(input.ticketDust),
        scriptPublicKey: burnScript(input.burnArtifact),
        covenant: binding,
      },
      changeOutput(input.changeScript, change),
    ],
    lockTime: 0,
  };
}

// --- mark_used (door check-in, FR-3/5/23, KTK-118) -------------------------

export interface MarkUsedInput {
  /** The ticket covenant UTXO being checked in (input index 0). */
  ticketOutpoint: Outpoint;
  /** The event covenant family id (the ticket's covenant_id). */
  eventCovenantId: string;
  /** The per-event compiled Event contract artifact. */
  eventArtifact: CompiledContractArtifact;
  /** The ticket owner's 32-byte owner identifier (preserved). */
  owner: Uint8Array;
  /** Owner KAS UTXOs covering the fee (fee payer = owner). */
  ownerUtxos: Outpoint[];
  /** Owner input values (sompi). */
  ownerUtxoValues: readonly number[];
  /** Owner change script public key. */
  changeScript: ScriptPublicKey;
  network: AddressNetwork;
  /** Network fee in sompi (paid by the owner). */
  fee: number;
  /** Dust preserved on the marked-used ticket output. */
  ticketDust?: number;
}

/**
 * The door check-in template (KTK-118): the ticket covenant is marked
 * `used: true` and stays with the owner — nothing is spent. The owner signs
 * the ticket input and their fee UTXOs; the gate later co-signs the ticket
 * input (KTK-119).
 */
export function buildMarkUsed(input: MarkUsedInput): UnsignedTransaction {
  validatePairedValues(input.ownerUtxoValues, input.ownerUtxos, "owner");
  const change = totalOf(input.ownerUtxoValues) - input.fee;
  if (change < 0) {
    throw new Error(`owner inputs cannot cover fee ${input.fee}`);
  }

  const binding = covenantBinding(input.eventCovenantId);
  const usedTicket = covenantScript(input.eventArtifact, {
    owner: input.owner,
    identifierType: 0,
    amount: 1,
    isMinter: false,
    used: true,
    salePrice: 0,
  });

  return {
    version: TX_VERSION_V1,
    inputs: inputsWithTicket(input.ticketOutpoint, input.ownerUtxos),
    outputs: [
      { value: ticketDustOf(input.ticketDust), scriptPublicKey: usedTicket, covenant: binding },
      changeOutput(input.changeScript, change),
    ],
    lockTime: 0,
  };
}

// --- resale: list / delist / purchase (KTK-151) -----------------------------
//
// The listing lives in the covenant state itself (`sale_price`), so these
// builders only shape the transaction — custody and payment are enforced by
// the contract:
//
//   list     — holder re-writes their own ticket state with `sale_price = p`
//              (holder-signed). The ticket never leaves the holder's control.
//   delist   — holder clears the listing (holder-signed).
//   purchase — trustless escrow: NO seller signature. Anyone may spend a
//              listed ticket through `purchase` as long as one output pays
//              exactly the asking price to the seller's P2PK script; the
//              covenant re-keys the ticket to the buyer atomically.

const OP_CHECKSIG = 0xac;
/** 32-byte pubkey x-coordinate / owner identifier length. */
const HASH_LENGTH = 32;

/** P2PK output script for a 32-byte pubkey x-coordinate (`20 <x> ac`). */
export function p2pkScriptFromPubkey(pubkey: Uint8Array): ScriptPublicKey {
  if (pubkey.length !== HASH_LENGTH) {
    throw new Error(`pubkey must be ${HASH_LENGTH} bytes, got ${pubkey.length}`);
  }
  const script = new Uint8Array(HASH_LENGTH + 2);
  script[0] = PUSH32;
  script.set(pubkey, 1);
  script[HASH_LENGTH + 1] = OP_CHECKSIG;
  return { version: 0, script: bytesToHex(script) };
}

function assertResalePrice(price: number): void {
  if (!Number.isSafeInteger(price) || price <= 0) {
    throw new Error(`resale price ${price} must be a positive safe integer`);
  }
}

export interface ListInput {
  /** The listed ticket covenant UTXO (input index 0). */
  ticketOutpoint: Outpoint;
  /** The event covenant family id (the ticket's covenant_id). */
  eventCovenantId: string;
  /** The per-event compiled Event contract artifact. */
  eventArtifact: CompiledContractArtifact;
  /** The ticket holder's owner identifier (preserved). */
  owner: Uint8Array;
  /** The ticket's current used flag (preserved by the listing). */
  used: boolean;
  /** Asking price in sompi (> 0). */
  price: number;
  /** Holder KAS UTXOs covering the fee (fee payer = holder). */
  holderUtxos: Outpoint[];
  /** Holder input values (sompi). */
  holderUtxoValues: readonly number[];
  /** Holder change script public key. */
  changeScript: ScriptPublicKey;
  /** Network fee in sompi (paid by the holder). */
  fee: number;
  /** Dust preserved on the listed ticket output. */
  ticketDust?: number;
}

/**
 * The listing template: the ticket is spent back to itself with `sale_price =
 * price` embedded in the covenant state. The holder keeps full custody —
 * anyone can read the asking price off the chain, and the sale itself needs no
 * further holder action.
 */
export function buildList(input: ListInput): UnsignedTransaction {
  validatePairedValues(input.holderUtxoValues, input.holderUtxos, "holder");
  assertResalePrice(input.price);
  const change = totalOf(input.holderUtxoValues) - input.fee;
  if (change < 0) {
    throw new Error(`holder inputs cannot cover fee ${input.fee}`);
  }

  const binding = covenantBinding(input.eventCovenantId);
  const listedTicket = covenantScript(input.eventArtifact, {
    owner: input.owner,
    identifierType: 0,
    amount: 1,
    isMinter: false,
    used: input.used,
    salePrice: input.price,
  });

  return {
    version: TX_VERSION_V1,
    inputs: inputsWithTicket(input.ticketOutpoint, input.holderUtxos),
    outputs: [
      { value: ticketDustOf(input.ticketDust), scriptPublicKey: listedTicket, covenant: binding },
      changeOutput(input.changeScript, change),
    ],
    lockTime: 0,
  };
}

export interface DelistInput {
  ticketOutpoint: Outpoint;
  eventCovenantId: string;
  eventArtifact: CompiledContractArtifact;
  /** The ticket holder's owner identifier (preserved). */
  owner: Uint8Array;
  /** The ticket's current used flag (preserved). */
  used: boolean;
  /** Holder KAS UTXOs covering the fee (fee payer = holder). */
  holderUtxos: Outpoint[];
  holderUtxoValues: readonly number[];
  changeScript: ScriptPublicKey;
  fee: number;
  ticketDust?: number;
}

/** Cancel a listing before anyone buys: clear `sale_price` back to 0. */
export function buildDelist(input: DelistInput): UnsignedTransaction {
  validatePairedValues(input.holderUtxoValues, input.holderUtxos, "holder");
  const change = totalOf(input.holderUtxoValues) - input.fee;
  if (change < 0) {
    throw new Error(`holder inputs cannot cover fee ${input.fee}`);
  }

  const binding = covenantBinding(input.eventCovenantId);
  const unlistedTicket = covenantScript(input.eventArtifact, {
    owner: input.owner,
    identifierType: 0,
    amount: 1,
    isMinter: false,
    used: input.used,
    salePrice: 0,
  });

  return {
    version: TX_VERSION_V1,
    inputs: inputsWithTicket(input.ticketOutpoint, input.holderUtxos),
    outputs: [
      { value: ticketDustOf(input.ticketDust), scriptPublicKey: unlistedTicket, covenant: binding },
      changeOutput(input.changeScript, change),
    ],
    lockTime: 0,
  };
}

export interface PurchaseInput {
  /** The listed ticket covenant UTXO being bought (input index 0). */
  ticketOutpoint: Outpoint;
  /** The event covenant family id (the ticket's covenant_id). */
  eventCovenantId: string;
  /** The per-event compiled Event contract artifact. */
  eventArtifact: CompiledContractArtifact;
  /** The seller's 32-byte owner identifier (the listing's `owner`). */
  seller: Uint8Array;
  /** The buyer's 32-byte owner identifier (the ticket's next owner). */
  buyer: Uint8Array;
  /** The ticket's current used flag (preserved across the purchase). */
  used: boolean;
  /** The asking price in sompi (paid to the seller's P2PK script). */
  price: number;
  /** Buyer KAS UTXOs covering price + fresh ticket deposit + fee. */
  buyerUtxos: Outpoint[];
  /** Buyer input values (sompi). */
  buyerUtxoValues: readonly number[];
  /** Buyer change script public key. */
  changeScript: ScriptPublicKey;
  /** Network fee in sompi (paid by the buyer). */
  fee: number;
  /** Dust preserved on the purchased ticket output. */
  ticketDust?: number;
}

/**
 * The trustless purchase template: inputs `[ticket, buyer fee…]`, outputs
 * `[ticket@buyer (covenant-bound), seller payout @asking price + deposit,
 * buyer change]`. The buyer funds a fresh deposit; the old ticket deposit is
 * returned to the seller as part of the proceeds.
 * The seller signature does not exist — the covenant IS the escrow.
 */
export function buildPurchase(input: PurchaseInput): UnsignedTransaction {
  validatePairedValues(input.buyerUtxoValues, input.buyerUtxos, "buyer");
  assertResalePrice(input.price);
  if (input.seller.length !== HASH_LENGTH) {
    throw new Error(`seller must be ${HASH_LENGTH} bytes, got ${input.seller.length}`);
  }
  if (input.buyer.length !== HASH_LENGTH) {
    throw new Error(`buyer must be ${HASH_LENGTH} bytes, got ${input.buyer.length}`);
  }
  const ticketDust = ticketDustOf(input.ticketDust);
  const sellerProceeds = input.price + ticketDust;
  if (!Number.isSafeInteger(sellerProceeds)) {
    throw new Error(`price ${input.price} plus ticket deposit is too large`);
  }
  const buyerTotal = totalOf(input.buyerUtxoValues);
  const change = buyerTotal - input.price - ticketDust - input.fee;
  if (change < 0) {
    throw new Error(
      `buyer inputs ${buyerTotal} cannot cover price ${input.price} + ticket deposit ${ticketDust} + fee ${input.fee}`,
    );
  }

  const binding = covenantBinding(input.eventCovenantId);
  const purchasedTicket = covenantScript(input.eventArtifact, {
    owner: input.buyer,
    identifierType: 0,
    amount: 1,
    isMinter: false,
    used: input.used,
    salePrice: 0,
  });

  return {
    version: TX_VERSION_V1,
    inputs: inputsWithTicket(input.ticketOutpoint, input.buyerUtxos),
    outputs: [
      { value: ticketDust, scriptPublicKey: purchasedTicket, covenant: binding },
      { value: sellerProceeds, scriptPublicKey: p2pkScriptFromPubkey(input.seller), covenant: null },
      changeOutput(input.changeScript, change),
    ],
    lockTime: 0,
  };
}
