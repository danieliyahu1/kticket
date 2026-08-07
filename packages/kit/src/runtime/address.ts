// Address derivation for kticket covenant outputs (HLD v0.21 §2.1).
//
//   redeem_script = OP_PUSH(state_bytes) OP_PUSH(constants_bytes) <silverc code>
//   address(k, phase) = P2SH(blake3(redeem_script(k, phase)))
//
// The address scheme is Kaspa's native P2SH (`AddressVersion.ScriptHash` = 8),
// encoded with the bech32-style base32check scheme (`prefix:payload`). The
// script hash is BLAKE3-32 of the redeem script — matching rusty-kaspa's
// `pay_to_script_hash_script`. The HLD formula mentions `hash160(blake3(...))`;
// see `packages/kit/docs/decisions/spike-covenant-runtime.md` — the kit pins
// the consensus-aligned blake3-32 hash (32-byte ScriptHash payload).

import { blake3 } from "@noble/hashes/blake3.js";
import type { DecodedConstants, DecodedState } from "./preimage.js";
import { encodeConstants, encodeState, PreimageError } from "./preimage.js";

export const SCRIPT_VERSION = 0;
export const P2SH_ADDRESS_VERSION = 8; // AddressVersion.ScriptHash

export const NETWORK_PREFIXES = {
  mainnet: "kaspa",
  testnet10: "kaspatest",
} as const;

export type AddressNetwork = keyof typeof NETWORK_PREFIXES;

export interface RedeemScript {
  state: DecodedState;
  constants: DecodedConstants;
  code: Uint8Array;
}

// --- script assembly -------------------------------------------------------

/** Bitcoin/Kaspa pushdata opcode encoding: `<0x01..0x4b> len byte | 0x4c len8 | 0x4d len16`. */
export function pushData(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 0x4c) {
    const out = new Uint8Array(1 + bytes.length);
    out[0] = bytes.length;
    out.set(bytes, 1);
    return out;
  }
  if (bytes.length <= 0xff) {
    const out = new Uint8Array(2 + bytes.length);
    out[0] = 0x4c;
    out[1] = bytes.length;
    out.set(bytes, 2);
    return out;
  }
  if (bytes.length <= 0xffff) {
    const out = new Uint8Array(3 + bytes.length);
    out[0] = 0x4d;
    new DataView(out.buffer).setUint16(1, bytes.length, true);
    out.set(bytes, 3);
    return out;
  }
  throw new PreimageError(`push data too large: ${bytes.length} bytes`);
}

/** Assemble a redeem script from pre-encoded state + constants pushes + code. */
export function assembleRedeemScript(
  stateBytes: Uint8Array,
  constantsBytes: Uint8Array,
  code: Uint8Array,
): Uint8Array {
  const statePush = pushData(stateBytes);
  const constantsPush = pushData(constantsBytes);
  const out = new Uint8Array(statePush.length + constantsPush.length + code.length);
  out.set(statePush, 0);
  out.set(constantsPush, statePush.length);
  out.set(code, statePush.length + constantsPush.length);
  return out;
}

/** Assemble the redeem script for a ticket covenant output. */
export function buildRedeemScript(
  state: DecodedState,
  constants: DecodedConstants,
  code: Uint8Array,
): Uint8Array {
  return assembleRedeemScript(
    encodeState(state.phase, state.owner),
    encodeConstants(constants),
    code,
  );
}

/**
 * Assemble the redeem script for the event burn covenant. The burn's own
 * layout is `count = 1` (state) + `event_id` (constants) — it has no owner,
 * price, org_spk, or template hash (see burn.silverscript).
 */
export function buildBurnRedeemScript(eventId: Uint8Array, code: Uint8Array): Uint8Array {
  if (eventId.length !== 32) {
    throw new PreimageError(`eventId must be 32 bytes, got ${eventId.length}`);
  }
  const countBytes = new Uint8Array([1]);
  const constantsBytes = new Uint8Array(32);
  constantsBytes.set(eventId);
  return assembleRedeemScript(countBytes, constantsBytes, code);
}

// --- hashing ---------------------------------------------------------------

/** BLAKE3-32 script hash, matching rusty-kaspa P2SH script-hash computation. */
export function scriptHash(redeemScript: Uint8Array): Uint8Array {
  return blake3(redeemScript);
}

// --- base32check (bech32 address encoding) ---------------------------------

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function polymod(values: number[]): bigint {
  const GENERATORS = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let g = 0; g < GENERATORS.length; g++) {
      if ((c0 & (1n << BigInt(g))) !== 0n) {
        c ^= GENERATORS[g] ?? 0n;
      }
    }
  }
  return c ^ 1n;
}

function checksum(payload: number[], prefixChars: number[]): bigint {
  return polymod([...prefixChars, 0, ...payload, 0, 0, 0, 0, 0, 0, 0, 0]);
}

function conv8to5(payload: Uint8Array): number[] {
  const pad = payload.length % 5 === 0 ? 0 : 1;
  const fiveBit: number[] = new Array<number>(Math.floor((payload.length * 8) / 5) + pad);
  let current = 0;
  let buffer = 0;
  let bits = 0;
  for (const byte of payload) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      fiveBit[current] = (buffer >> bits) & 31;
      buffer &= (1 << bits) - 1;
      current += 1;
    }
  }
  if (bits > 0) {
    fiveBit[current] = (buffer << (5 - bits)) & 31;
  }
  return fiveBit;
}

/**
 * Encode a payload (version byte + script hash) as a Kaspa bech32 address.
 * Byte-for-byte compatible with `crypto/addresses/src/bech32.rs`.
 */
export function encodeAddress(prefix: string, payload: Uint8Array): string {
  const prefixChars = [...prefix].map((c) => c.charCodeAt(0) & 0x1f);
  const fiveBit = conv8to5(payload);
  const checksumValue = checksum(fiveBit, prefixChars);
  // Rust takes `checksum.to_be_bytes()[3..]` — the low 5 bytes of the u64.
  const be = new Uint8Array(8);
  new DataView(be.buffer).setBigUint64(0, checksumValue, false);
  const cs5 = conv8to5(be.subarray(3));
  const out: number[] = [];
  for (const b of [...fiveBit, ...cs5]) {
    const ch = CHARSET[b];
    if (ch === undefined) {
      throw new Error(`invalid bech32 value ${b}`);
    }
    out.push(ch.charCodeAt(0));
  }
  return `${prefix}:${String.fromCharCode(...out)}`;
}

export interface AddressOptions {
  prefix?: string;
  /** Override the hash used as the P2SH payload (defaults to `scriptHash` = blake3-32). */
  hash?: (redeemScript: Uint8Array) => Uint8Array;
}

/**
 * Derive the P2SH address for a covenant output. By default the payload is
 * `blake3(redeem_script)` (32 bytes) under the given network prefix.
 */
export function addressFor(
  state: DecodedState,
  constants: DecodedConstants,
  code: Uint8Array,
  network: AddressNetwork,
  options: AddressOptions = {},
): string {
  const redeem = buildRedeemScript(state, constants, code);
  const hash = (options.hash ?? scriptHash)(redeem);
  const payload = new Uint8Array(1 + hash.length);
  payload[0] = P2SH_ADDRESS_VERSION;
  payload.set(hash, 1);
  return encodeAddress(options.prefix ?? NETWORK_PREFIXES[network], payload);
}

/**
 * Convenience: address of the phase-0 (available) ticket `index` — used by the
 * genesis builder and the reader's availability walk.
 */
export function availableTicketAddress(
  index: number,
  constants: DecodedConstants,
  code: Uint8Array,
  network: AddressNetwork,
  options: AddressOptions = {},
): string {
  return addressFor(
    { phase: 0, owner: new Uint8Array(32) },
    { ...constants, index },
    code,
    network,
    options,
  );
}
