// Preimage layout — the on-chain ticket bytes the covenant VM (and the reader)
// decode to reconstruct ticket state (HLD v0.21 §2.1 "Preimage layout").
//
//   state_bytes    = u8 phase | byte[32] owner
//   constants_bytes= byte[32] event_id | u32 index (LE) | u64 price (LE)
//                    | varbytes org_spk | byte[32] burn_template_hash
//
// `varbytes` is a LEB128 length prefix followed by the raw bytes. All integers
// are little-endian, matching Kaspa consensus serialization.
//
// The redeem script embeds both pushes (`OP_PUSH(state_bytes)
// OP_PUSH(constants_bytes) <silverc code>`, see address.ts); `decode` is what
// the kit exposes so a script public key can be parsed back into ticket state
// without trusting the chain for anything but the bytes themselves.

import type { TicketPhase } from "../contracts/types.js";

/** Maximum safe size for a `price` value in sompi (u64 must fit in a JS safe int). */
export const MAX_SAFE_PRICE = Number.MAX_SAFE_INTEGER;

export interface DecodedState {
  phase: TicketPhase;
  owner: Uint8Array;
}

export interface DecodedConstants {
  eventId: Uint8Array;
  index: number;
  price: number;
  orgSpk: Uint8Array;
  burnTemplateHash: Uint8Array;
}

export class PreimageError extends Error {
  override readonly name = "PreimageError";
}

function assertSafePrice(price: number): void {
  if (!Number.isSafeInteger(price) || price < 0) {
    throw new PreimageError(`price ${price} is not a non-negative safe integer`);
  }
}

// --- state_bytes -----------------------------------------------------------

export const PHASE_AVAILABLE = 0;
export const PHASE_OWNED = 1;
export const PHASE_GONE = 2;

const STATE_BYTES_LEN = 1 + 32;

export function encodeState(phase: TicketPhase, owner: Uint8Array): Uint8Array {
  if (owner.length !== 32) {
    throw new PreimageError(`owner must be 32 bytes, got ${owner.length}`);
  }
  const out = new Uint8Array(STATE_BYTES_LEN);
  out[0] = phase;
  out.set(owner, 1);
  return out;
}

export function decodeState(bytes: Uint8Array): DecodedState {
  if (bytes.length !== STATE_BYTES_LEN) {
    throw new PreimageError(`state_bytes must be ${STATE_BYTES_LEN} bytes, got ${bytes.length}`);
  }
  return { phase: bytes[0] as TicketPhase, owner: bytes.slice(1) };
}

// --- constants_bytes -------------------------------------------------------

const CONSTANTS_FIXED_LEN = 32 + 4 + 8 + 32; // event_id + index + price + burn_template_hash

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
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
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
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 53) {
      throw new PreimageError("varint exceeds safe integer range");
    }
  }
  return { value, bytesRead: i - offset };
}

export function encodeConstants(constants: DecodedConstants): Uint8Array {
  if (constants.eventId.length !== 32) {
    throw new PreimageError(`eventId must be 32 bytes, got ${constants.eventId.length}`);
  }
  if (constants.burnTemplateHash.length !== 32) {
    throw new PreimageError(
      `burnTemplateHash must be 32 bytes, got ${constants.burnTemplateHash.length}`,
    );
  }
  if (
    !Number.isSafeInteger(constants.index) ||
    constants.index < 0 ||
    constants.index > 0xffffffff
  ) {
    throw new PreimageError(`index ${constants.index} is not a u32`);
  }
  assertSafePrice(constants.price);

  const orgLen = constants.orgSpk.length;
  const total = CONSTANTS_FIXED_LEN + encodeVarint(orgLen).length + orgLen;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  out.set(constants.eventId, 0);
  view.setUint32(32, constants.index, true);
  view.setBigUint64(36, BigInt(constants.price), true);
  let offset = 44;
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

  const eventId = bytes.slice(0, 32);
  const index = view.getUint32(32, true);
  const price = Number(view.getBigUint64(36, true));
  let offset = 44;
  const len = decodeVarint(bytes, offset);
  offset += len.bytesRead;
  if (offset + len.value > bytes.length) {
    throw new PreimageError(`org_spk varbytes length ${len.value} exceeds available bytes`);
  }
  const orgSpk = bytes.slice(offset, offset + len.value);
  offset += len.value;
  if (offset + 32 > bytes.length) {
    throw new PreimageError("constants_bytes missing burn_template_hash");
  }
  const burnTemplateHash = bytes.slice(offset, offset + 32);

  return { eventId, index, price, orgSpk, burnTemplateHash };
}

// --- combined preimage -----------------------------------------------------

export interface Preimage {
  state: Uint8Array;
  constants: Uint8Array;
}

export function encodePreimage(state: DecodedState, constants: DecodedConstants): Preimage {
  return { state: encodeState(state.phase, state.owner), constants: encodeConstants(constants) };
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
