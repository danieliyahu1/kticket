// Transaction builders (HLD v0.21 §2.1 "Transactions (v1)").
//
// Each builder returns an *unsigned* v1 transaction template with covenant
// bindings set. Fee handling: the fee payer's UTXOs are inputs and a change
// output is derived so `sum(inputs) − sum(outputs) = fee`. The concrete
// kaspa-wasm v1 serialization is applied at the network boundary.
//
// covenant_id pin (KIP-20, spike d): per-family. The genesis fanout binds all
// ticket outputs to one `event_cov_id`; buy/transfer/handover continuation
// outputs carry the same covenant_id as the ticket UTXO they spend.

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

export { FEE_PAYER } from "./tx.js";

/** P2SH script public key for a redeem script (blake3-32 script hash). */
export function p2shScript(redeemScript: Uint8Array): ScriptPublicKey {
  return { version: 0, script: bytesToHex(scriptHash(redeemScript)) };
}

function ticketScript(
  state: DecodedState,
  constants: DecodedConstants,
  code: Uint8Array,
): ScriptPublicKey {
  return p2shScript(buildRedeemScript(state, constants, code));
}

function asInput(outpoint: Outpoint): TxInput {
  return {
    previousOutpoint: { txId: bytesToHex(outpoint.txId), index: outpoint.index },
    signatureScript: "",
    sequence: 0,
    sigOpCount: 1,
  };
}

function txInputs(ticketOutpoint: Outpoint | null, utxos: Outpoint[]): TxInput[] {
  const payer = utxos.map(asInput);
  return ticketOutpoint ? [asInput(ticketOutpoint), ...payer] : payer;
}

function changeOutput(script: ScriptPublicKey, change: number): TxOutput {
  return { value: change, scriptPublicKey: script, covenant: null };
}

function totalOf(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

// --- genesis ---------------------------------------------------------------

export interface GenesisInput {
  /** Organizer KAS UTXO (input index 0) authorizing the fanout. */
  authorizingOutpoint: Outpoint;
  /** Additional organizer KAS UTXOs funding the fee. */
  organizerUtxos: Outpoint[];
  /** Values (sompi) of every organizer input, incl. the authorizing one. */
  organizerUtxoValues: readonly number[];
  /** Ticket constants shared by every ticket in the event. */
  constants: DecodedConstants;
  /** `capacity` ≤ 100 — one phase-0 output per ticket (index = k). */
  capacity: number;
  /** Ticket contract code segment (from the Ticket artifact). */
  ticketCode: Uint8Array;
  /** Change address for the organizer. */
  changeScript: ScriptPublicKey;
  /** Network fee in sompi (paid by the organizer). */
  fee: number;
  network: AddressNetwork;
}

export interface GenesisResult {
  tx: UnsignedTransaction;
  /** Per-family covenant_id of the event (all ticket outputs share it). */
  eventCovenantId: string;
}

export function buildGenesis(input: GenesisInput): GenesisResult {
  const { capacity } = input;
  if (!Number.isInteger(capacity) || capacity < 0 || capacity > 100) {
    throw new Error(`capacity must be 0..100, got ${capacity}`);
  }
  if (!Number.isSafeInteger(input.fee) || input.fee < 0) {
    throw new Error(`fee ${input.fee} is invalid`);
  }

  const allUtxos = [input.authorizingOutpoint, ...input.organizerUtxos];
  if (input.organizerUtxoValues.length !== allUtxos.length) {
    throw new Error("organizerUtxoValues must match the organizer input count");
  }
  const inputTotal = totalOf(input.organizerUtxoValues);
  const change = inputTotal - input.fee;
  if (change < 0) {
    throw new Error(`organizer inputs ${inputTotal} cannot cover fee ${input.fee}`);
  }

  const inputs = txInputs(null, allUtxos);

  const ticketScripts: ScriptPublicKey[] = [];
  for (let k = 0; k < capacity; k++) {
    ticketScripts.push(
      ticketScript(
        { phase: 0, owner: new Uint8Array(32) },
        { ...input.constants, index: k },
        input.ticketCode,
      ),
    );
  }

  const authOutputs: AuthorizedOutput[] = ticketScripts.map((script, k) => ({
    index: k,
    value: 0,
    version: script.version,
    script: hexToBytes(script.script),
  }));
  const eventCovenantId = bytesToHex(covenantId(input.authorizingOutpoint, authOutputs));

  const binding: CovenantBinding = { authorizingInput: 0, covenantId: eventCovenantId };
  const ticketOutputs: TxOutput[] = ticketScripts.map((scriptPublicKey) => ({
    value: 0,
    scriptPublicKey,
    covenant: binding,
  }));

  return {
    tx: {
      version: TX_VERSION_V1,
      inputs,
      outputs: [...ticketOutputs, changeOutput(input.changeScript, change)],
      lockTime: 0,
    },
    eventCovenantId,
  };
}

// --- buy -------------------------------------------------------------------

export interface BuyInput {
  /** The available ticket input (input index 0). */
  ticketOutpoint: Outpoint;
  /** The spent ticket UTXO's covenant_id (= event_cov_id). */
  eventCovenantId: string;
  constants: DecodedConstants;
  /** Buyer's key hash (owner of the owned ticket). */
  buyerPkh: Uint8Array;
  /** Buyer KAS UTXOs covering price + fee (fee payer = buyer). */
  buyerUtxos: Outpoint[];
  /** Buyer input values (sompi). */
  buyerUtxoValues: readonly number[];
  /** Organizer payout script public key (`org_spk`). */
  orgScript: ScriptPublicKey;
  /** Buyer change script public key. */
  changeScript: ScriptPublicKey;
  ticketCode: Uint8Array;
  network: AddressNetwork;
  /** Network fee in sompi (paid by the buyer). */
  fee: number;
}

export function buildBuy(input: BuyInput): UnsignedTransaction {
  const price = input.constants.price;
  if (input.buyerUtxoValues.length !== input.buyerUtxos.length) {
    throw new Error("buyerUtxoValues must match the buyer input count");
  }
  const buyerTotal = totalOf(input.buyerUtxoValues);
  const change = buyerTotal - price - input.fee;
  if (change < 0) {
    throw new Error(`buyer inputs ${buyerTotal} cannot cover price ${price} + fee ${input.fee}`);
  }

  const binding: CovenantBinding = { authorizingInput: 0, covenantId: input.eventCovenantId };
  const outputs: TxOutput[] = [
    {
      value: 0,
      scriptPublicKey: ticketScript(
        { phase: 1, owner: input.buyerPkh },
        input.constants,
        input.ticketCode,
      ),
      covenant: binding,
    },
  ];
  if (price > 0) {
    outputs.push({ value: price, scriptPublicKey: input.orgScript, covenant: null });
  }
  outputs.push(changeOutput(input.changeScript, change));

  return {
    version: TX_VERSION_V1,
    inputs: txInputs(input.ticketOutpoint, input.buyerUtxos),
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
  newOwnerPkh: Uint8Array;
  /** Holder KAS UTXOs covering the fee (fee payer = holder). */
  holderUtxos: Outpoint[];
  holderUtxoValues: readonly number[];
  changeScript: ScriptPublicKey;
  ticketCode: Uint8Array;
  network: AddressNetwork;
  fee: number;
}

export function buildTransfer(input: TransferInput): UnsignedTransaction {
  if (input.holderUtxoValues.length !== input.holderUtxos.length) {
    throw new Error("holderUtxoValues must match the holder input count");
  }
  const change = totalOf(input.holderUtxoValues) - input.fee;
  if (change < 0) {
    throw new Error(`holder inputs cannot cover fee ${input.fee}`);
  }

  const binding: CovenantBinding = { authorizingInput: 0, covenantId: input.eventCovenantId };
  return {
    version: TX_VERSION_V1,
    inputs: txInputs(input.ticketOutpoint, input.holderUtxos),
    outputs: [
      {
        value: 0,
        scriptPublicKey: ticketScript(
          { phase: 1, owner: input.newOwnerPkh },
          input.constants,
          input.ticketCode,
        ),
        covenant: binding,
      },
      changeOutput(input.changeScript, change),
    ],
    lockTime: 0,
  };
}

// --- handover --------------------------------------------------------------

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
}

/**
 * The event's burn output script public key — the successor every handover
 * must create (FR-9). The burn redeem script is `OP_PUSH(count=1)
 * OP_PUSH(event_id) <burn code>`, fixed per event.
 */
export function burnScript(constants: DecodedConstants, burnCode: Uint8Array): ScriptPublicKey {
  return p2shScript(buildBurnRedeemScript(constants.eventId, burnCode));
}

export function buildHandover(input: HandoverInput): UnsignedTransaction {
  if (input.attendeeUtxoValues.length !== input.attendeeUtxos.length) {
    throw new Error("attendeeUtxoValues must match the attendee input count");
  }
  const change = totalOf(input.attendeeUtxoValues) - input.fee;
  if (change < 0) {
    throw new Error(`attendee inputs cannot cover fee ${input.fee}`);
  }

  const binding: CovenantBinding = { authorizingInput: 0, covenantId: input.eventCovenantId };
  return {
    version: TX_VERSION_V1,
    inputs: txInputs(input.ticketOutpoint, input.attendeeUtxos),
    outputs: [
      { value: 0, scriptPublicKey: burnScript(input.constants, input.burnCode), covenant: binding },
      changeOutput(input.changeScript, change),
    ],
    lockTime: 0,
  };
}
