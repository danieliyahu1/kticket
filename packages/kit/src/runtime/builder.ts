// Transaction builders (HLD v0.22 §2.1 "Transactions (v1)" — forge-style KCC20).
//
// Each builder returns an *unsigned* v1 transaction template with covenant
// bindings set. Fee handling: the fee payer's UTXOs are inputs and a change
// output is derived so `sum(inputs) − sum(outputs) = fee`.
//
//   deploy   — one event covenant (remaining = capacity, ~0.5 KAS dust,
//              price in constants). No per-ticket pre-creation.
//   buy      — the event covenant splits: ticket (amount=1, buyer) + event
//              covenant (remaining−1) + org payout (price) + change. Buyer pays
//              price + ticket dust + fee.
//   transfer — re-bind a ticket (amount=1) to a new owner; dust rides along.
//   handover — consume the ticket into this event's burn-owner covenant
//              (unspendable) — the ticket, dust included, is gone.
//
// covenant_id pin (KIP-20, spike d): per-family. The deploy binds the event
// covenant output to the event_cov_id; mint/transfer/handover continuation
// outputs carry the same covenant_id as the covenant UTXO they spend.

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { AddressNetwork } from "./address.js";
import { buildBurnRedeemScript, buildRedeemScript, scriptHash } from "./address.js";
import type { AuthorizedOutput, Outpoint } from "./covenant.js";
import { covenantId } from "./covenant.js";
import type { DecodedConstants, DecodedState } from "./preimage.js";
import type {
  CovenantBinding,
  ScriptPublicKey,
  TxInput,
  TxOutput,
  UnsignedTransaction,
} from "./tx.js";
import { TX_VERSION_V1 } from "./tx.js";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/** KCC-0021 covenant metadata attached to the genesis transaction payload. */
export interface EventMetadata {
  name: string;
  date: string;
  price: number;
}

/**
 * Encode event metadata as a hex-encoded JSON string for the genesis tx payload
 * (KCC-0021 convention: metadata lives in the tx payload, not a separate output).
 */
export function encodeMetadataPayload(meta: EventMetadata): string {
  const json = JSON.stringify({ n: meta.name, d: meta.date, p: meta.price });
  return bytesToHex(TEXT_ENCODER.encode(json));
}

/**
 * Decode event metadata from a hex-encoded genesis tx payload.
 * Returns `null` if the payload does not carry valid kticket metadata.
 */
export function decodeMetadataFromPayload(payloadHex: string | null | undefined): EventMetadata | null {
  if (!payloadHex) return null;
  try {
    const bytes = hexToBytes(payloadHex);
    const json = TEXT_DECODER.decode(bytes);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (typeof parsed.n !== "string" || typeof parsed.d !== "string" || typeof parsed.p !== "number") {
      return null;
    }
    return { name: parsed.n, date: parsed.d, price: parsed.p };
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

function covenantScript(
  state: DecodedState,
  constants: DecodedConstants,
  code: Uint8Array,
): ScriptPublicKey {
  return p2shScript(buildRedeemScript(state, constants, code));
}

function burnScriptFor(authorizingTxId: Uint8Array, burnCode: Uint8Array): ScriptPublicKey {
  return p2shScript(buildBurnRedeemScript(authorizingTxId, burnCode));
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

// --- deploy (one event covenant) -------------------------------------------

export interface DeployInput {
  /** Organizer KAS UTXO (input index 0) authorizing the deploy. */
  authorizingOutpoint: Outpoint;
  /** Additional organizer KAS UTXOs funding the fee. */
  organizerUtxos: Outpoint[];
  /** Values (sompi) of every organizer input, incl. the authorizing one. */
  organizerUtxoValues: readonly number[];
  /** Organizer's 32-byte owner identifier (pubkey). */
  organizer: Uint8Array;
  /** Event capacity — becomes the event covenant's `remaining`. */
  capacity: number;
  /** Event constants (authorizing_txid, price, org_spk, burn_template_hash). */
  constants: DecodedConstants;
  /** Event covenant code segment (from the Event artifact). */
  covenantCode: Uint8Array;
  /** Change address for the organizer. */
  changeScript: ScriptPublicKey;
  /** Network fee in sompi (paid by the organizer). */
  fee: number;
  network: AddressNetwork;
  /** Optional KCC-20 metadata output (name, date, price). When set, a data
   *  output is inserted between the event covenant and the change output so
   *  anyone can read event info from the chain. */
  metadata?: EventMetadata;
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
  };
  const eventScript = covenantScript(eventState, input.constants, input.covenantCode);
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
      ...(input.metadata ? { payload: encodeMetadataPayload(input.metadata) } : {}),
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
  /** Event constants (authorizing_txid, price, org_spk, burn_template_hash). */
  constants: DecodedConstants;
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
  /** Event/ticket covenant code segment. */
  covenantCode: Uint8Array;
  /** Current `remaining` on the event covenant (must be > 0). */
  remaining: number;
  network: AddressNetwork;
  /** Network fee in sompi (paid by the buyer). */
  fee: number;
  /** Dust locked in the minted ticket output. */
  ticketDust?: number;
}

export function buildBuy(input: BuyInput): UnsignedTransaction {
  const price = input.constants.price;
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
    { owner: input.buyer, identifierType: 0, amount: 1, isMinter: false },
    input.constants,
    input.covenantCode,
  );
  const remainingEvent = covenantScript(
    { owner: input.eventOwner, identifierType: 0, amount: input.remaining - 1, isMinter: false },
    input.constants,
    input.covenantCode,
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

// --- transfer --------------------------------------------------------------

export interface TransferInput {
  ticketOutpoint: Outpoint;
  eventCovenantId: string;
  constants: DecodedConstants;
  /** New owner key hash. */
  newOwner: Uint8Array;
  /** Holder KAS UTXOs covering the fee (fee payer = holder). */
  holderUtxos: Outpoint[];
  holderUtxoValues: readonly number[];
  changeScript: ScriptPublicKey;
  covenantCode: Uint8Array;
  network: AddressNetwork;
  fee: number;
  /** Dust carried by the ticket output (rides along unchanged). */
  ticketDust?: number;
}

export function buildTransfer(input: TransferInput): UnsignedTransaction {
  validatePairedValues(input.holderUtxoValues, input.holderUtxos, "holder");
  const change = totalOf(input.holderUtxoValues) - input.fee;
  if (change < 0) {
    throw new Error(`holder inputs cannot cover fee ${input.fee}`);
  }

  const binding = covenantBinding(input.eventCovenantId);
  return {
    version: TX_VERSION_V1,
    inputs: inputsWithTicket(input.ticketOutpoint, input.holderUtxos),
    outputs: [
      {
        value: ticketDustOf(input.ticketDust),
        scriptPublicKey: covenantScript(
          { owner: input.newOwner, identifierType: 0, amount: 1, isMinter: false },
          input.constants,
          input.covenantCode,
        ),
        covenant: binding,
      },
      changeOutput(input.changeScript, change),
    ],
    lockTime: 0,
  };
}

// --- handover (consume into the burn-owner covenant) -----------------------

export interface HandoverInput {
  ticketOutpoint: Outpoint;
  eventCovenantId: string;
  constants: DecodedConstants;
  /** Burn contract code segment (from the Burn artifact). */
  burnCode: Uint8Array;
  /** Attendee KAS UTXOs covering the fee (fee payer = attendee). */
  attendeeUtxos: Outpoint[];
  attendeeUtxoValues: readonly number[];
  changeScript: ScriptPublicKey;
  network: AddressNetwork;
  fee: number;
  /** Dust consumed with the ticket (rides into the burn output). */
  ticketDust?: number;
}

/**
 * The event's burn-owner output script public key — the successor every
 * handover must create (FR-9). The burn redeem script is `OP_PUSH(count=1)
 * OP_PUSH(authorizing_txid) <burn code>`, fixed per event.
 */
export function burnScript(constants: DecodedConstants, burnCode: Uint8Array): ScriptPublicKey {
  return burnScriptFor(constants.authorizingTxId, burnCode);
}

/**
 * Hex script hash of an event's burn-owner covenant output — the "burn
 * template" a handover must create (HLD §2.1). The reader (HLD §2.2) compares a
 * handover successor's on-chain script against this to report GONE.
 */
export function burnTemplateHash(authorizingTxIdHex: string, burnCodeHex: string): string {
  return bytesToHex(
    scriptHash(buildBurnRedeemScript(hexToBytes(authorizingTxIdHex), hexToBytes(burnCodeHex))),
  );
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
        scriptPublicKey: burnScript(input.constants, input.burnCode),
        covenant: binding,
      },
      changeOutput(input.changeScript, change),
    ],
    lockTime: 0,
  };
}
