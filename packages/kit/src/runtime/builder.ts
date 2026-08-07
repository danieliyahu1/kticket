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

export { FEE_PAYER } from "./tx.js";

/** P2SH script public key for a redeem script (blake3-32 script hash). */
export function p2shScript(redeemScript: Uint8Array): ScriptPublicKey {
  return { version: 0, script: bytesToHex(scriptHash(redeemScript)) };
}

function covenantScript(
  state: DecodedState,
  constants: DecodedConstants,
  code: Uint8Array,
): ScriptPublicKey {
  return p2shScript(buildRedeemScript(state, constants, code));
}

function burnScriptFor(eventId: Uint8Array, burnCode: Uint8Array): ScriptPublicKey {
  return p2shScript(buildBurnRedeemScript(eventId, burnCode));
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

/** Default covenant dust for a ticket output (~0.5 KAS). */
export const TICKET_DUST = 50_000_000;

/** Default covenant dust for the event covenant (~0.5 KAS). */
export const EVENT_DUST = 50_000_000;

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
  /** Event constants (event_id, price, org_spk, burn_template_hash). */
  constants: DecodedConstants;
  /** Event covenant code segment (from the Event artifact). */
  covenantCode: Uint8Array;
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

export function buildDeploy(input: DeployInput): DeployResult {
  if (!Number.isInteger(input.capacity) || input.capacity < 0 || input.capacity > 100) {
    throw new Error(`capacity must be 0..100, got ${input.capacity}`);
  }
  if (!Number.isSafeInteger(input.fee) || input.fee < 0) {
    throw new Error(`fee ${input.fee} is invalid`);
  }

  const allUtxos = [input.authorizingOutpoint, ...input.organizerUtxos];
  if (input.organizerUtxoValues.length !== allUtxos.length) {
    throw new Error("organizerUtxoValues must match the organizer input count");
  }
  const inputTotal = totalOf(input.organizerUtxoValues);
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

  const authOutputs: AuthorizedOutput[] = [
    {
      index: 0,
      value: EVENT_DUST,
      version: eventScript.version,
      script: hexToBytes(eventScript.script),
    },
  ];
  const eventCovenantId = bytesToHex(covenantId(input.authorizingOutpoint, authOutputs));
  const binding: CovenantBinding = { authorizingInput: 0, covenantId: eventCovenantId };

  return {
    tx: {
      version: TX_VERSION_V1,
      inputs: txInputs(null, allUtxos),
      outputs: [
        { value: EVENT_DUST, scriptPublicKey: eventScript, covenant: binding },
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
  /** Event constants (event_id, price, org_spk, burn_template_hash). */
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
  if (input.buyerUtxoValues.length !== input.buyerUtxos.length) {
    throw new Error("buyerUtxoValues must match the buyer input count");
  }
  if (!Number.isInteger(input.remaining) || input.remaining <= 0) {
    throw new Error(`cannot mint from an event with remaining ${input.remaining}`);
  }
  const ticketDust = input.ticketDust ?? TICKET_DUST;
  const buyerTotal = totalOf(input.buyerUtxoValues);
  const change = buyerTotal - price - ticketDust - input.fee;
  if (change < 0) {
    throw new Error(
      `buyer inputs ${buyerTotal} cannot cover price ${price} + ticket dust ${ticketDust} + fee ${input.fee}`,
    );
  }

  const binding: CovenantBinding = { authorizingInput: 0, covenantId: input.eventCovenantId };
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
    inputs: txInputs(input.eventOutpoint, input.buyerUtxos),
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
        value: input.ticketDust ?? TICKET_DUST,
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
 * OP_PUSH(event_id) <burn code>`, fixed per event.
 */
export function burnScript(constants: DecodedConstants, burnCode: Uint8Array): ScriptPublicKey {
  return burnScriptFor(constants.eventId, burnCode);
}

/**
 * Hex script hash of an event's burn-owner covenant output — the "burn
 * template" a handover must create (HLD §2.1). The reader (HLD §2.2) compares a
 * handover successor's on-chain script against this to report GONE.
 */
export function burnTemplateHash(eventIdHex: string, burnCodeHex: string): string {
  return bytesToHex(
    scriptHash(buildBurnRedeemScript(hexToBytes(eventIdHex), hexToBytes(burnCodeHex))),
  );
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
      {
        value: input.ticketDust ?? TICKET_DUST,
        scriptPublicKey: burnScript(input.constants, input.burnCode),
        covenant: binding,
      },
      changeOutput(input.changeScript, change),
    ],
    lockTime: 0,
  };
}
