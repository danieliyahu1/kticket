// Preimage layout — the on-chain covenant bytes (HLD v0.22 §2.1, forge-style KCC20 fork).
//
//   state_bytes     = byte[32] owner_identifier | u8 identifier_type
//                     | u64 amount (LE) | u8 is_minter
//   constants_bytes = byte[32] event_id | u64 price (LE)
//                     | varbytes org_spk | byte[32] burn_template_hash
//
// `varbytes` is a LEB128 length prefix followed by the raw bytes. All integers
// are little-endian, matching Kaspa consensus serialization.
//
// `amount` is the covenant's unit balance: the event covenant starts with
// `amount = capacity` (remaining tickets) and each mint-on-sale splits off a
// ticket covenant with `amount = 1`. `capacity` itself is not a constant — it
// is the event covenant's initial state, so "sold" is `capacity − remaining`.
//
// The redeem script embeds both pushes (`OP_PUSH(state_bytes)
// OP_PUSH(constants_bytes) <silverc code>`, see address.ts); `decode` is what
// the kit exposes so a script public key can be parsed back into covenant state
// without trusting the chain for anything but the bytes themselves.

import type { IdentifierType } from "../contracts/types.js";

export interface DecodedState {
  /** 32-byte owner identifier (pubkey / script hash / covenant id). */
  owner: Uint8Array;
  /** Identifier kind (0 = pubkey, 1 = script hash, 2 = covenant id). */
  identifierType: IdentifierType;
  /** Token balance: remaining tickets on the event covenant, 1 on a ticket. */
  amount: number;
  /** Whether this covenant may mint (unused — fixed-supply events). */
  isMinter: boolean;
}

export interface DecodedConstants {
  eventId: Uint8Array;
  /** Price per ticket in sompi (0 = free). */
  price: number;
  /** Organizer payout script (the `org_spk` payout output on a buy). */
  orgSpk: Uint8Array;
  /** Script hash of the event's burn-owner covenant template. */
  burnTemplateHash: Uint8Array;
}

export class PreimageError extends Error {
  override readonly name = "PreimageError";
}

const HASH_LENGTH = 32;
const U64_LENGTH = 8;
const IDENTIFIER_TYPE_OFFSET = HASH_LENGTH;
const AMOUNT_OFFSET = IDENTIFIER_TYPE_OFFSET + 1;
const IS_MINTER_OFFSET = AMOUNT_OFFSET + U64_LENGTH;
const PRICE_OFFSET = HASH_LENGTH;
const VARBYTES_START = PRICE_OFFSET + U64_LENGTH;

const VARINT_LOW7_MASK = 0x7f;
const VARINT_CONTINUE_MASK = 0x80;
const VARINT_SHIFT = 7;
const VARINT_MAX_SHIFT = 53;

function assertSafeAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new PreimageError(`amount ${amount} is not a non-negative safe integer`);
  }
}

function assertSafePrice(price: number): void {
  if (!Number.isSafeInteger(price) || price < 0) {
    throw new PreimageError(`price ${price} is not a non-negative safe integer`);
  }
}

// --- state_bytes -----------------------------------------------------------

const STATE_BYTES_LEN = HASH_LENGTH + 1 + U64_LENGTH + 1;

export function encodeState(
  owner: Uint8Array,
  identifierType: IdentifierType,
  amount: number,
  isMinter = false,
): Uint8Array {
  if (owner.length !== HASH_LENGTH) {
    throw new PreimageError(`owner must be 32 bytes, got ${owner.length}`);
  }
  assertSafeAmount(amount);
  const out = new Uint8Array(STATE_BYTES_LEN);
  out.set(owner, 0);
  out[IDENTIFIER_TYPE_OFFSET] = identifierType;
  new DataView(out.buffer).setBigUint64(AMOUNT_OFFSET, BigInt(amount), true);
  out[IS_MINTER_OFFSET] = isMinter ? 1 : 0;
  return out;
}

export function decodeState(bytes: Uint8Array): DecodedState {
  if (bytes.length !== STATE_BYTES_LEN) {
    throw new PreimageError(`state_bytes must be ${STATE_BYTES_LEN} bytes, got ${bytes.length}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    owner: bytes.slice(0, HASH_LENGTH),
    identifierType: bytes[IDENTIFIER_TYPE_OFFSET] as IdentifierType,
    amount: Number(view.getBigUint64(AMOUNT_OFFSET, true)),
    isMinter: bytes[IS_MINTER_OFFSET] === 1,
  };
}

// --- constants_bytes -------------------------------------------------------

const CONSTANTS_FIXED_LEN = HASH_LENGTH + U64_LENGTH + HASH_LENGTH; // event_id + price + burn_template_hash

/**
 * Encode a LEB128 (unsigned, base-128 varint) length prefix. Used for
 * `varbytes` in both the constants_bytes layout and the KIP-20 covenant_id hash.
 */
export function encodeVarint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PreimageError(`varint value ${value} is not a non-negative safe integer`);
  }
  const out: number[] = [];
  let v = value;
  do {
    let byte = v & VARINT_LOW7_MASK;
    v >>>= 7;
    if (v !== 0) byte |= VARINT_CONTINUE_MASK;
    out.push(byte);
  } while (v !== 0);
  return Uint8Array.from(out);
}

/** Decode a LEB128 length prefix. Returns `{ value, bytesRead }`. */
export function decodeVarint(
  bytes: Uint8Array,
  offset: number,
): { value: number; bytesRead: number } {
  let value = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    if (i >= bytes.length) {
      throw new PreimageError("truncated varint");
    }
    const byte = bytes[i];
    if (byte === undefined) {
      throw new PreimageError("truncated varint");
    }
    i += 1;
    value |= (byte & VARINT_LOW7_MASK) << shift;
    if ((byte & VARINT_CONTINUE_MASK) === 0) break;
    shift += VARINT_SHIFT;
    if (shift > VARINT_MAX_SHIFT) {
      throw new PreimageError("varint exceeds safe integer range");
    }
  }
  return { value, bytesRead: i - offset };
}

export function encodeConstants(constants: DecodedConstants): Uint8Array {
  if (constants.eventId.length !== HASH_LENGTH) {
    throw new PreimageError(`eventId must be 32 bytes, got ${constants.eventId.length}`);
  }
  if (constants.burnTemplateHash.length !== HASH_LENGTH) {
    throw new PreimageError(
      `burnTemplateHash must be 32 bytes, got ${constants.burnTemplateHash.length}`,
    );
  }
  assertSafePrice(constants.price);

  const orgLen = constants.orgSpk.length;
  const total = CONSTANTS_FIXED_LEN + encodeVarint(orgLen).length + orgLen;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  out.set(constants.eventId, 0);
  view.setBigUint64(PRICE_OFFSET, BigInt(constants.price), true);
  let offset = VARBYTES_START;
  const prefix = encodeVarint(orgLen);
  out.set(prefix, offset);
  offset += prefix.length;
  out.set(constants.orgSpk, offset);
  offset += orgLen;
  out.set(constants.burnTemplateHash, offset);

  return out;
}

export function decodeConstants(bytes: Uint8Array): DecodedConstants {
  if (bytes.length < CONSTANTS_FIXED_LEN) {
    throw new PreimageError(`constants_bytes too short: ${bytes.length} < ${CONSTANTS_FIXED_LEN}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const eventId = bytes.slice(0, HASH_LENGTH);
  const price = Number(view.getBigUint64(PRICE_OFFSET, true));
  let offset = VARBYTES_START;
  const len = decodeVarint(bytes, offset);
  offset += len.bytesRead;
  if (offset + len.value > bytes.length) {
    throw new PreimageError(`org_spk varbytes length ${len.value} exceeds available bytes`);
  }
  const orgSpk = bytes.slice(offset, offset + len.value);
  offset += len.value;
  if (offset + HASH_LENGTH > bytes.length) {
    throw new PreimageError("constants_bytes missing burn_template_hash");
  }
  const burnTemplateHash = bytes.slice(offset, offset + HASH_LENGTH);

  return { eventId, price, orgSpk, burnTemplateHash };
}

// --- combined preimage -----------------------------------------------------

export interface Preimage {
  state: Uint8Array;
  constants: Uint8Array;
}

export function encodePreimage(state: DecodedState, constants: DecodedConstants): Preimage {
  return {
    state: encodeState(state.owner, state.identifierType, state.amount, state.isMinter),
    constants: encodeConstants(constants),
  };
}

/**
 * Parse the two pushdata segments of a redeem script back into state and
 * constants. `decode(redeem_script)` must throw a `PreimageError` for anything
 * that is not a valid kticket preimage — the reader never guesses (DEC-12).
 */
export function decodePreimage(redeemScript: Uint8Array): {
  state: DecodedState;
  constants: DecodedConstants;
} {
  const state = decodeState(redeemScript.subarray(0, STATE_BYTES_LEN));
  const constants = decodeConstants(redeemScript.subarray(STATE_BYTES_LEN));
  return { state, constants };
}
