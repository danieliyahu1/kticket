// Address derivation for kticket covenant outputs (KTK-88 A4).
//
//   artifact.bytecode = template_prefix | state_slot | template_suffix
//   redeem_script(k, state) = bytecode with the state slot replaced
//   address(k, state) = P2SH(blake3(redeem_script))
//
// The address scheme is Kaspa's native P2SH (`AddressVersion.ScriptHash` = 8),
// encoded with the bech32-style base32check scheme (`prefix:payload`). The
// script hash is BLAKE3-32 of the redeem script — matching rusty-kaspa's
// `pay_to_script_hash_script`. The per-event constants are baked into the
// bytecode at compile time (constructor args), so only the mutable state slot
// is injected at runtime.

import { blake3 } from "@noble/hashes/blake3.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import type { CompiledContractArtifact } from "../contracts/artifact.js";
import type { DecodedConstants, DecodedState } from "./preimage.js";
import { decodeState, encodeState, PreimageError, rawStateBytes } from "./preimage.js";

export const P2SH_ADDRESS_VERSION = 8; // AddressVersion.ScriptHash

const HASH_LENGTH = 32;

const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const MAX_PUSHDATA1_LENGTH = 0xff;
const MAX_PUSHDATA2_LENGTH = 0xffff;
const PUSHDATA2_OFFSET = 3;
const U64_LENGTH = 8;

const CHUNK_BITS = 5;
const CHUNK_MASK = 31;
const BYTE_BITS = 8;
const BYTE_MASK = 0xffff;

const POLYMOD_SHIFT = 35;
const POLYMOD_MASK = 0x07ffffffffn;
const POLYMOD_XOR_CONST = 1n;
const POLYMOD_GEN0 = 0x98f2bc8e61n;
const POLYMOD_GEN1 = 0x79b76d99e2n;
const POLYMOD_GEN2 = 0xf33e5fb3c4n;
const POLYMOD_GEN3 = 0xae2eabe2a8n;
const POLYMOD_GEN4 = 0x1e4f43e470n;
const POLYMOD_GENERATORS = [POLYMOD_GEN0, POLYMOD_GEN1, POLYMOD_GEN2, POLYMOD_GEN3, POLYMOD_GEN4];

const CHECKSUM_OFFSET = 3;

export const NETWORK_PREFIXES = {
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
  if (bytes.length < OP_PUSHDATA1) {
    const out = new Uint8Array(1 + bytes.length);
    out[0] = bytes.length;
    out.set(bytes, 1);
    return out;
  }
  if (bytes.length <= MAX_PUSHDATA1_LENGTH) {
    const out = new Uint8Array(2 + bytes.length);
    out[0] = OP_PUSHDATA1;
    out[1] = bytes.length;
    out.set(bytes, 2);
    return out;
  }
  if (bytes.length <= MAX_PUSHDATA2_LENGTH) {
    const out = new Uint8Array(PUSHDATA2_OFFSET + bytes.length);
    out[0] = OP_PUSHDATA2;
    new DataView(out.buffer).setUint16(1, bytes.length, true);
    out.set(bytes, PUSHDATA2_OFFSET);
    return out;
  }
  throw new PreimageError(`push data too large: ${bytes.length} bytes`);
}

/**
 * Inject the mutable state into the artifact's bytecode state slot, producing
 * the full redeem script for one covenant instance. `state_layout` marks where
 * the compiler placed the (push-encoded) state within the bytecode.
 */
export function injectState(artifact: CompiledContractArtifact, state: DecodedState): Uint8Array {
  const bytecode = Uint8Array.from(artifact.bytecode);
  const { start, len } = artifact.state_layout;
  const slot = encodeState(state.owner, state.identifierType, state.amount, state.isMinter);
  if (slot.length !== len) {
    throw new PreimageError(
      `state slot length ${slot.length} does not match artifact layout length ${len} for ${artifact.contract_name}`,
    );
  }
  const out = new Uint8Array(bytecode.length);
  out.set(bytecode.subarray(0, start), 0);
  out.set(slot, start);
  out.set(bytecode.subarray(start + len), start + slot.length);
  return out;
}

/**
 * Read the mutable state out of an on-chain redeem script by slicing the
 * artifact's state slot. The constants stay in the compiled bytecode; only the
 * slot is decoded (HLD §2.2).
 */
export function readStateFromRedeem(artifact: CompiledContractArtifact, redeemScript: Uint8Array): DecodedState {
  const { start, len } = artifact.state_layout;
  const expected = Uint8Array.from(artifact.bytecode);
  const prefix = expected.subarray(0, start);
  const suffix = expected.subarray(start + len);
  const prefixLen = prefix.length;
  const suffixLen = suffix.length;

  if (redeemScript.length !== prefixLen + len + suffixLen) {
    throw new PreimageError(
      `redeem script length ${redeemScript.length} does not match artifact layout`,
    );
  }
  for (let i = 0; i < prefixLen; i++) {
    if (redeemScript[i] !== prefix[i]) {
      throw new PreimageError("redeem script prefix does not match artifact bytecode");
    }
  }
  for (let i = 0; i < suffixLen; i++) {
    if (redeemScript[prefixLen + len + i] !== suffix[i]) {
      throw new PreimageError("redeem script suffix does not match artifact bytecode");
    }
  }
  return decodeState(redeemScript.subarray(prefixLen, prefixLen + len));
}

/** Assemble a redeem script for an event/ticket covenant output from its artifact + state. */
export function buildRedeemScript(artifact: CompiledContractArtifact, state: DecodedState): Uint8Array {
  return injectState(artifact, state);
}

/**
 * Assemble the redeem script for the event burn-owner covenant. The burn's own
 * bytecode has `authorizing_txid` baked at compile time and a single `int
 * count = 1` state field — it is per-event and unspendable. The artifact must
 * be that event's compiled burn contract.
 */
export function buildBurnRedeemScript(artifact: CompiledContractArtifact): Uint8Array {
  return Uint8Array.from(artifact.bytecode);
}

// --- hashing ---------------------------------------------------------------

/** BLAKE3-32 script hash, matching rusty-kaspa P2SH script-hash computation. */
export function scriptHash(redeemScript: Uint8Array): Uint8Array {
  return blake3(redeemScript);
}

// --- base32check (bech32 address encoding) ---------------------------------

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function polymod(values: number[]): bigint {
  let c = 1n;
  for (const d of values) {
    const c0 = c >> BigInt(POLYMOD_SHIFT);
    c = ((c & POLYMOD_MASK) << 5n) ^ BigInt(d);
    for (let g = 0; g < POLYMOD_GENERATORS.length; g++) {
      if ((c0 & (1n << BigInt(g))) !== 0n) {
        c ^= POLYMOD_GENERATORS[g] ?? 0n;
      }
    }
  }
  return c ^ POLYMOD_XOR_CONST;
}

function checksum(payload: number[], prefixChars: number[]): bigint {
  return polymod([...prefixChars, 0, ...payload, 0, 0, 0, 0, 0, 0, 0, 0]);
}

function conv8to5(payload: Uint8Array): number[] {
  const pad = payload.length % CHUNK_BITS === 0 ? 0 : 1;
  const fiveBit: number[] = new Array<number>(
    Math.floor((payload.length * BYTE_BITS) / CHUNK_BITS) + pad,
  );
  let current = 0;
  let buffer = 0;
  let bits = 0;
  for (const byte of payload) {
    buffer = ((buffer << BYTE_BITS) | byte) & BYTE_MASK;
    bits += BYTE_BITS;
    while (bits >= CHUNK_BITS) {
      bits -= CHUNK_BITS;
      fiveBit[current] = (buffer >> bits) & CHUNK_MASK;
      buffer &= (1 << bits) - 1;
      current += 1;
    }
  }
  if (bits > 0) {
    fiveBit[current] = (buffer << (CHUNK_BITS - bits)) & CHUNK_MASK;
  }
  return fiveBit;
}

/**
 * Encode a payload (version byte + script hash) as a Kaspa bech32 address.
 * Byte-for-byte compatible with `crypto/addresses/src/bech32.rs`.
 */
export function encodeAddress(prefix: string, payload: Uint8Array): string {
  const prefixChars = [...prefix].map((c) => c.charCodeAt(0) & CHUNK_MASK);
  const fiveBit = conv8to5(payload);
  const checksumValue = checksum(fiveBit, prefixChars);
  // Rust takes `checksum.to_be_bytes()[3..]` — the low 5 bytes of the u64.
  const be = new Uint8Array(U64_LENGTH);
  new DataView(be.buffer).setBigUint64(0, checksumValue, false);
  const cs5 = conv8to5(be.subarray(CHECKSUM_OFFSET));
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
 * P2SH address payload: the ScriptHash version byte followed by the hash
 * bytes (`kaspatest:<base32check(version || hash)>`).
 */
function p2shPayload(hash: Uint8Array): Uint8Array {
  const payload = new Uint8Array(1 + hash.length);
  payload[0] = P2SH_ADDRESS_VERSION;
  payload.set(hash, 1);
  return payload;
}

/**
 * Derive the P2SH address for a covenant output. By default the payload is
 * `blake3(redeem_script)` (32 bytes) under the given network prefix.
 */
export function addressFor(
  artifact: CompiledContractArtifact,
  state: DecodedState,
  network: AddressNetwork,
  options: AddressOptions = {},
): string {
  const redeem = injectState(artifact, state);
  const hash = (options.hash ?? scriptHash)(redeem);
  return encodeAddress(options.prefix ?? NETWORK_PREFIXES[network], p2shPayload(hash));
}

/**
 * Convenience: address of the event covenant output at `capacity` — used by the
 * deploy builder and the reader's availability walk. The event covenant carries
 * `amount = capacity` as its initial `remaining`.
 */
export function availableTicketAddress(
  artifact: CompiledContractArtifact,
  capacity: number,
  network: AddressNetwork,
  options: AddressOptions = {},
): string {
  return addressFor(
    artifact,
    { owner: new Uint8Array(HASH_LENGTH), identifierType: 0, amount: capacity, isMinter: false },
    network,
    options,
  );
}

/** OP_HASH256 (Kaspa P2SH) — the standard script form the node accepts. */
const OP_HASH256 = 0xaa;
/** OP_EQUAL — closes the P2SH script. */
const OP_EQUAL = 0x87;
/** P2SH push length opcode for a 32-byte script hash. */
const PUSH32 = 0x20;

/** AddressVersion.PubKey — P2PK (schnorr) x-only addresses derived from an x-coordinate. */
export const P2PK_ADDRESS_VERSION = 0;

/**
 * Derive the P2PK bech32 address for a 32-byte schnorr pubkey x-coordinate
 * (`kaspatest:q...`), the address an organizer's funding UTXO locks to. This is
 * the "organizer address" trust anchor: the covenant owner pubkey recovered from
 * the deploy input-0 funding UTXO maps to this address on chain.
 */
export function p2pkAddress(pubkey: Uint8Array, network: AddressNetwork): string {
  if (pubkey.length !== HASH_LENGTH) {
    throw new PreimageError(`pubkey must be 32 bytes, got ${pubkey.length}`);
  }
  const payload = new Uint8Array(1 + HASH_LENGTH);
  payload[0] = P2PK_ADDRESS_VERSION;
  payload.set(pubkey, 1);
  return encodeAddress(NETWORK_PREFIXES[network], payload);
}

/**
 * Parse a P2PK output script (`20 <32-byte x> ac`) back into the 32-byte pubkey.
 * Returns `null` when the script is not the standard P2PK form.
 */
export function pubkeyFromP2pkScript(scriptHex: string): Uint8Array | null {
  const script = hexToBytes(scriptHex);
  const expectedLength = 1 + HASH_LENGTH + 1;
  if (script.length !== expectedLength || script[0] !== 0x20 || script[expectedLength - 1] !== 0xac) {
    return null;
  }
  return script.slice(1, 1 + HASH_LENGTH);
}

/** P2PK address for a P2PK output script, or `null` if the script is not P2PK. */
export function p2pkAddressFromScript(scriptHex: string, network: AddressNetwork): string | null {
  const pubkey = pubkeyFromP2pkScript(scriptHex);
  return pubkey ? p2pkAddress(pubkey, network) : null;
}

/**
 * P2SH address for an on-chain covenant output script. The chain stores the
 * standard `aa20 <hash> 87` script form (`p2shScript`), so the address is the
 * embedded 32-byte hash under the ScriptHash version byte — the reader (HLD
 * §2.2) derives addresses this way without needing the redeem script. A bare
 * 32-byte hash is also accepted for callers holding only the digest.
 */
export function addressFromScriptHash(scriptHashHex: string, network: AddressNetwork): string {
  const bytes = hexToBytes(scriptHashHex);
  const hash = unwrapP2sh(bytes);
  if (hash.length !== HASH_LENGTH) {
    throw new PreimageError(`script hash must be 32 bytes, got ${hash.length}`);
  }
  return encodeAddress(NETWORK_PREFIXES[network], p2shPayload(hash));
}

/** P2SH script length: `aa` + `20` + 32-byte hash + `87`. */
const P2SH_SCRIPT_LENGTH = 35;

function unwrapP2sh(bytes: Uint8Array): Uint8Array {
  const len = bytes.length;
  if (
    len === P2SH_SCRIPT_LENGTH &&
    bytes[0] === OP_HASH256 &&
    bytes[1] === PUSH32 &&
    bytes[len - 1] === OP_EQUAL
  ) {
    return bytes.slice(2, len - 1);
  }
  return bytes;
}
