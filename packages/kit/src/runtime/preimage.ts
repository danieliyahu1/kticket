// Preimage layout — the on-chain covenant bytes (KTK-88 A4).
//
// The real compiler bakes the per-event constants into the contract bytecode
// at compile time (they are constructor args). What remains mutable is the
// state slot, at `state_layout` inside the artifact bytecode:
//
//   bytecode = template_prefix | state_slot | template_suffix
//   state_slot = push(byte[32] owner) push(u8 identifier_type)
//                push(u64 amount LE) push(u8 is_minter) push(u8 used)
//
// The push encoding is Bitcoin/Kaspa pushdata (direct length byte). The event
// slot is 48 bytes: `0x20`+32, `0x01`+1, `0x08`+8, `0x01`+1, `0x01`+1. The burn
// slot is 9 bytes: `0x08`+8 (its single `int count` field).
//
// `injectState` replaces the slot bytes with a freshly-encoded state so each
// covenant instance (event at capacity, ticket at amount=1) gets its own
// redeem script. The reader slices the slot out of an on-chain redeem script
// and decodes it — the constants never leave the compiled artifact.

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
  /** Whether the door marked this ticket used (FR-3/5/23, KTK-118). */
  used: boolean;
}

export interface DecodedConstants {
  authorizingTxId: Uint8Array;
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
const STATE_BYTES_LEN = HASH_LENGTH + 1 + U64_LENGTH + 1 + 1; // 43 raw bytes

const IDENTIFIER_TYPE_OFFSET = HASH_LENGTH;
const AMOUNT_OFFSET = IDENTIFIER_TYPE_OFFSET + 1;
const IS_MINTER_OFFSET = AMOUNT_OFFSET + U64_LENGTH;
const USED_OFFSET = IS_MINTER_OFFSET + 1;

function assertSafeAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new PreimageError(`amount ${amount} is not a non-negative safe integer`);
  }
}

// --- pushdata (state slot uses direct push opcodes) -------------------------

const OP_PUSHDATA1 = 0x4c;
const MAX_PUSHDATA1_LENGTH = 0xff;
const PUSHDATA1_OFFSET = 2;
const PUSHDATA2_OFFSET = 3;
const MAX_PUSHDATA2_LENGTH = 0xffff;

function pushBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length < OP_PUSHDATA1) {
    const out = new Uint8Array(1 + bytes.length);
    out[0] = bytes.length;
    out.set(bytes, 1);
    return out;
  }
  if (bytes.length <= MAX_PUSHDATA1_LENGTH) {
    const out = new Uint8Array(PUSHDATA1_OFFSET + bytes.length);
    out[0] = OP_PUSHDATA1;
    out[1] = bytes.length;
    out.set(bytes, PUSHDATA1_OFFSET);
    return out;
  }
  if (bytes.length <= MAX_PUSHDATA2_LENGTH) {
    const out = new Uint8Array(PUSHDATA2_OFFSET + bytes.length);
    out[0] = 0x4d;
    new DataView(out.buffer).setUint16(1, bytes.length, true);
    out.set(bytes, PUSHDATA2_OFFSET);
    return out;
  }
  throw new PreimageError(`push data too large: ${bytes.length} bytes`);
}

function le64(value: number): Uint8Array {
  const out = new Uint8Array(U64_LENGTH);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
  return out;
}

/**
 * Encode the state slot bytes for the event/ticket covenant: one push per
 * field in declaration order — owner, identifier_type, amount, is_minter, used.
 * Matches the compiler's field-prolog encoding (KTK-88 A4).
 */
export function encodeState(
  owner: Uint8Array,
  identifierType: IdentifierType,
  amount: number,
  isMinter = false,
  used = false,
): Uint8Array {
  if (owner.length !== HASH_LENGTH) {
    throw new PreimageError(`owner must be 32 bytes, got ${owner.length}`);
  }
  assertSafeAmount(amount);
  const parts = [
    pushBytes(owner),
    pushBytes(Uint8Array.of(identifierType)),
    pushBytes(le64(amount)),
    pushBytes(Uint8Array.of(isMinter ? 1 : 0)),
    pushBytes(Uint8Array.of(used ? 1 : 0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Raw (unpushed) 43-byte state bytes — `owner | id | amount LE | is_minter | used`. */
function rawStateBytes(state: DecodedState): Uint8Array {
  const out = new Uint8Array(STATE_BYTES_LEN);
  out.set(state.owner, 0);
  out[IDENTIFIER_TYPE_OFFSET] = state.identifierType;
  new DataView(out.buffer).setBigUint64(AMOUNT_OFFSET, BigInt(state.amount), true);
  out[IS_MINTER_OFFSET] = state.isMinter ? 1 : 0;
  out[USED_OFFSET] = state.used ? 1 : 0;
  return out;
}

/**
 * Decode the state slot (push-encoded, e.g. the 46-byte event slot) back into
 * a `DecodedState`. Strips each field's push opcode and parses the value.
 */
export function decodeState(bytes: Uint8Array): DecodedState {
  let offset = 0;

  function nextPush(): Uint8Array {
    if (offset >= bytes.length) {
      throw new PreimageError("truncated state slot");
    }
    const op = bytes[offset];
    if (op === undefined) {
      throw new PreimageError("truncated state slot");
    }
    offset += 1;
    let len: number;
    if (op < OP_PUSHDATA1) {
      len = op;
    } else if (op === OP_PUSHDATA1) {
      if (offset >= bytes.length) throw new PreimageError("truncated pushdata1");
      const lenByte = bytes[offset];
      if (lenByte === undefined) throw new PreimageError("truncated pushdata1");
      len = lenByte;
      offset += 1;
    } else if (op === 0x4d) {
      if (offset + 2 > bytes.length) throw new PreimageError("truncated pushdata2");
      len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
      offset += 2;
    } else {
      throw new PreimageError(`unexpected state slot opcode 0x${op.toString(16)}`);
    }
    if (offset + len > bytes.length) {
      throw new PreimageError("truncated state slot value");
    }
    const value = bytes.slice(offset, offset + len);
    offset += len;
    return value;
  }

  const owner = nextPush();
  const idBytes = nextPush();
  const amountBytes = nextPush();
  const minterBytes = nextPush();
  const usedBytes = nextPush();

  if (owner.length !== HASH_LENGTH) {
    throw new PreimageError(`owner must be 32 bytes, got ${owner.length}`);
  }
  if (
    idBytes.length !== 1 ||
    amountBytes.length !== U64_LENGTH ||
    minterBytes.length !== 1 ||
    usedBytes.length !== 1
  ) {
    throw new PreimageError("state slot field sizes do not match the event layout");
  }

  const identifierType = idBytes[0] as IdentifierType;
  if (identifierType !== 0 && identifierType !== 1 && identifierType !== 2) {
    throw new PreimageError(`invalid identifier type ${identifierType}`);
  }

  return {
    owner,
    identifierType,
    amount: Number(new DataView(amountBytes.buffer).getBigUint64(0, true)),
    isMinter: minterBytes[0] === 1,
    used: usedBytes[0] === 1,
  };
}

export interface Preimage {
  state: Uint8Array;
  constants: Uint8Array;
}

// --- constants are compile-time only ----------------------------------------

/**
 * Encode the event constants the way the compiler bakes them as constructor
 * args: `byte[32] authorizing_txid | u64 price LE | varbytes org_spk |
 * byte[32] burn_template_hash`. Used for tests / reference artifacts, not for
 * assembling on-chain redeem scripts (constants live in the compiled bytecode).
 */
export function encodeConstants(constants: DecodedConstants): Uint8Array {
  if (constants.authorizingTxId.length !== HASH_LENGTH) {
    throw new PreimageError(`authorizingTxId must be 32 bytes, got ${constants.authorizingTxId.length}`);
  }
  if (constants.burnTemplateHash.length !== HASH_LENGTH) {
    throw new PreimageError(
      `burnTemplateHash must be 32 bytes, got ${constants.burnTemplateHash.length}`,
    );
  }
  if (!Number.isSafeInteger(constants.price) || constants.price < 0) {
    throw new PreimageError(`price ${constants.price} is not a non-negative safe integer`);
  }
  const price = le64(constants.price);
  const orgLen = constants.orgSpk.length;
  const orgVarint = encodeVarint(orgLen);
  const total =
    HASH_LENGTH + price.length + orgVarint.length + orgLen + HASH_LENGTH;
  const out = new Uint8Array(total);
  out.set(constants.authorizingTxId, 0);
  let offset = HASH_LENGTH;
  out.set(price, offset);
  offset += price.length;
  out.set(orgVarint, offset);
  offset += orgVarint.length;
  out.set(constants.orgSpk, offset);
  offset += orgLen;
  out.set(constants.burnTemplateHash, offset);
  return out;
}

export function decodeConstants(bytes: Uint8Array): DecodedConstants {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < HASH_LENGTH + U64_LENGTH) {
    throw new PreimageError("constants_bytes too short");
  }
  const authorizingTxId = bytes.slice(0, HASH_LENGTH);
  const price = Number(view.getBigUint64(HASH_LENGTH, true));
  let offset = HASH_LENGTH + U64_LENGTH;
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
  return { authorizingTxId, price, orgSpk, burnTemplateHash };
}

// --- LEB128 varint (kept for constants encoding) ----------------------------

const VARINT_LOW7_MASK = 0x7f;
const VARINT_CONTINUE_MASK = 0x80;
const VARINT_SHIFT = 7;
const VARINT_MAX_SHIFT = 53;

export function encodeVarint(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PreimageError(`varint value ${value} is not a non-negative safe integer`);
  }
  const out: number[] = [];
  let v = value;
  do {
    let byte = v & VARINT_LOW7_MASK;
    v >>>= VARINT_SHIFT;
    if (v !== 0) byte |= VARINT_CONTINUE_MASK;
    out.push(byte);
  } while (v !== 0);
  return Uint8Array.from(out);
}

export function decodeVarint(bytes: Uint8Array, offset: number): { value: number; bytesRead: number } {
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

// --- combined preimage (legacy helper) --------------------------------------

export function encodePreimage(state: DecodedState, constants: DecodedConstants): Preimage {
  return {
    state: encodeState(state.owner, state.identifierType, state.amount, state.isMinter, state.used),
    constants: encodeConstants(constants),
  };
}

/**
 * Parse the two segments of a redeem script (push-encoded state slot +
 * constants bytes) back into state and constants. The state slot is the
 * push-encoded layout (`encodeState`); the constants follow it. Retained for
 * tests / reference; the A4 on-chain model reads the state slot out of the
 * compiled bytecode instead. Throws `PreimageError` for anything invalid
 * (DEC-12).
 */
export function decodePreimage(redeemScript: Uint8Array): {
  state: DecodedState;
  constants: DecodedConstants;
} {
  let offset = 0;

  function nextPush(): Uint8Array {
    if (offset >= redeemScript.length) {
      throw new PreimageError("truncated state slot");
    }
    const op = redeemScript[offset];
    if (op === undefined) {
      throw new PreimageError("truncated state slot");
    }
    offset += 1;
    let len: number;
    if (op < OP_PUSHDATA1) {
      len = op;
    } else if (op === OP_PUSHDATA1) {
      if (offset >= redeemScript.length) throw new PreimageError("truncated pushdata1");
      const lenByte = redeemScript[offset];
      if (lenByte === undefined) throw new PreimageError("truncated pushdata1");
      len = lenByte;
      offset += 1;
    } else {
      throw new PreimageError(`unexpected state slot opcode 0x${op.toString(16)}`);
    }
    if (offset + len > redeemScript.length) {
      throw new PreimageError("truncated state slot value");
    }
    const value = redeemScript.slice(offset, offset + len);
    offset += len;
    return value;
  }

  const owner = nextPush();
  const idBytes = nextPush();
  const amountBytes = nextPush();
  const minterBytes = nextPush();
  const usedBytes = nextPush();

  if (
    owner.length !== HASH_LENGTH ||
    idBytes.length !== 1 ||
    minterBytes.length !== 1 ||
    usedBytes.length !== 1
  ) {
    throw new PreimageError("state slot field sizes do not match the event layout");
  }

  const state: DecodedState = {
    owner,
    identifierType: idBytes[0] as IdentifierType,
    amount: Number(new DataView(amountBytes.buffer, amountBytes.byteOffset).getBigUint64(0, true)),
    isMinter: minterBytes[0] === 1,
    used: usedBytes[0] === 1,
  };
  const constants = decodeConstants(redeemScript.subarray(offset));
  return { state, constants };
}

export { rawStateBytes };
