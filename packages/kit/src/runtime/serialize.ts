// v1 transaction serialization helpers (HLD v0.21 §2.1 / §2.2 — "2 × tx bytes").
//
// The kit produces plain-data `UnsignedTransaction` templates; the concrete
// binary encoding lives at the network boundary. This module provides the two
// deterministic pieces the API needs without kaspa-wasm:
//
//   - `estimatedSerializedSize(tx)` — the consensus `transaction_estimated_serialized_size`
//     (KIP-9), used for the relay floor `100 sompi × max(compute grams, 2 × tx bytes)`.
//   - `txIdV1(tx)` — the KIP-20 v1 transaction id: `TransactionV1Id(payload_digest ||
//     rest_digest)`, each a keyed BLAKE3 with the domain tag as 32-byte key. The
//     broadcast relay uses it for idempotency (re-broadcasting a known tx
//     succeeds even when the node rejects it as a duplicate).
//
// The layout mirrors `consensus/core/src/hashing/tx.rs` + `crypto/hashes`:
//   - u16 version LE
//   - u64 input count, then per input: txid (32) + index u32 LE, varbytes
//     signature_script, u64 sequence, (v1: u16 compute_budget)
//   - u64 output count, then per output: u64 value, u16 spk version, varbytes
//     script, (v1: u8 covenant flag, u16 authorizing_input, covenant_id 32)
//   - u64 lock_time, subnetwork_id (20), u64 gas, varbytes payload

import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { UnsignedTransaction } from "./tx.js";

const HASH_SIZE = 32;
const SUBNETWORK_ID_SIZE = 20;
const NATIVE_SUBNETWORK_ID = new Uint8Array(SUBNETWORK_ID_SIZE);

function keyOf(tag: string): Uint8Array {
  const key = new Uint8Array(HASH_SIZE);
  for (let i = 0; i < tag.length; i++) key[i] = tag.charCodeAt(i);
  return key;
}

function blake3Keyed(tag: string, data: Uint8Array): Uint8Array {
  return blake3(data, { key: keyOf(tag) });
}

function le16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

function le32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

function le64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function inputScriptSize(input: UnsignedTransaction["inputs"][number]): number {
  return input.signatureScript.length / 2;
}

function scriptBytes(scriptHex: string): Uint8Array {
  return hexToBytes(scriptHex);
}

function outpointSize(): number {
  return HASH_SIZE + 4;
}

/**
 * Estimated serialized transaction size in bytes, matching rusty-kaspa's
 * `transaction_estimated_serialized_size` (deterministic, KIP-9). The `mass`
 * endpoint of api.kaspa.org computes mass from the same estimate; this is the
 * "tx bytes" term of the relay floor.
 */
export function estimatedSerializedSize(tx: UnsignedTransaction): number {
  let size = 2; // version (u16)
  size += 8; // number of inputs (u64)
  size += tx.inputs.reduce(
    (acc, input) =>
      acc +
      outpointSize() +
      8 + // signature_script length (u64)
      inputScriptSize(input) +
      8 + // sequence (u64)
      (tx.version >= 1 ? 2 : 0), // compute_budget (u16)
    0,
  );

  size += 8; // number of outputs (u64)
  size += tx.outputs.reduce((acc, output) => {
    const script = scriptBytes(output.scriptPublicKey.script);
    let outputSize =
      8 + // value (u64)
      2 + // spk version (u16)
      8 + // script length (u64)
      script.length;
    if (tx.version >= 1 && output.covenant) {
      outputSize += 2 + HASH_SIZE; // authorizing_input (u16) + covenant_id
    }
    return acc + outputSize;
  }, 0);

  size += 8; // lock_time (u64)
  size += SUBNETWORK_ID_SIZE;
  size += 8; // gas (u64)
  size += HASH_SIZE; // payload hash
  size += 8; // payload length (u64)
  return size;
}

/**
 * Encode the v1 transaction *id preimage*: the transaction with payload,
 * signature scripts and the mass commit excluded (rusty-kaspa
 * `write_rest_preimage`).
 */
export function txIdPreimageV1(tx: UnsignedTransaction): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(le16(tx.version));
  parts.push(le64(tx.inputs.length));
  for (const input of tx.inputs) {
    parts.push(hexToBytes(input.previousOutpoint.txId));
    parts.push(le32(input.previousOutpoint.index));
    parts.push(le64(0)); // signature_script excluded -> empty varbytes
    parts.push(le64(input.sequence));
  }
  parts.push(le64(tx.outputs.length));
  for (const output of tx.outputs) {
    parts.push(le64(output.value));
    parts.push(le16(output.scriptPublicKey.version));
    const script = scriptBytes(output.scriptPublicKey.script);
    parts.push(le64(script.length));
    parts.push(script);
    if (tx.version >= 1) {
      const covenant = output.covenant;
      parts.push(Uint8Array.from([covenant ? 1 : 0]));
      if (covenant) {
        parts.push(le16(covenant.authorizingInput));
        parts.push(hexToBytes(covenant.covenantId));
      }
    }
  }
  parts.push(le64(tx.lockTime));
  parts.push(NATIVE_SUBNETWORK_ID);
  parts.push(le64(0)); // gas
  parts.push(le64(0)); // payload excluded -> empty varbytes
  return concat(parts);
}

/**
 * The payload digest of the transaction payload. The kit never sets a payload
 * (always empty), so this is the `ZERO_PAYLOAD_DIGEST` constant.
 */
export function payloadDigest(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  return blake3Keyed("PayloadDigest", payload);
}

/**
 * The KIP-20 v1 transaction id:
 *
 *   id = TransactionV1Id(payload_digest || rest_digest)
 *
 * where `rest_digest` is the `TransactionRest` hash of the id preimage. Returns
 * the 64-hex id. Validated against rusty-kaspa's `hashing/tx.rs` test vectors.
 */
export function txIdV1(tx: UnsignedTransaction): string {
  const restDigest = blake3Keyed("TransactionRest", txIdPreimageV1(tx));
  const id = blake3Keyed("TransactionV1Id", concat([payloadDigest(), restDigest]));
  return bytesToHex(id);
}

// --- mass (KIP-9 / HLD §2.2) -------------------------------------------------

/** Consensus mass constants (mass.rs / kaspa-rest-server mass_calculation). */
const MASS_PER_TX_BYTE = 1;
const MASS_PER_SCRIPT_PUB_KEY_BYTE = 10;
const MASS_PER_SIG_OP = 1_000;

/**
 * Decode a compressed signature-op count. For v0 txs the value is used
 * directly; for v1+ values 0..100 are direct and 101..255 expand to
 * `100 + (n - 100) * 10` (max 1650).
 */
export function decodeSigOpCount(txVersion: number, encoded: number): number {
  if (txVersion === 0 || encoded <= 100) return encoded;
  return 100 + (encoded - 100) * 10;
}

export interface LocalMass {
  mass: number;
  storage_mass: number;
  compute_mass: number;
}

/**
 * The serialized-size term of the endpoint's compute-mass formula. This mirrors
 * `tx_serialized_size` from kaspa-rest-server's `mass_calculation_compute.py`
 * exactly — note it does NOT add the 2-byte compute_budget per v1 input (the
 * endpoint's quirk), so local results match what `/transactions/mass` returns.
 */
function endpointTxSize(tx: UnsignedTransaction): number {
  let size = 2; // version (u16)
  size += 8; // number of inputs (u64)
  for (const input of tx.inputs) {
    size += 32 + 4; // outpoint (txid + index)
    size += 8; // signature_script length (u64)
    size += input.signatureScript.length / 2;
    size += 8; // sequence (u64)
  }
  size += 8; // number of outputs (u64)
  for (const output of tx.outputs) {
    size += 8; // value (u64)
    size += 2; // spk version (u16)
    size += 8; // script length (u64)
    size += output.scriptPublicKey.script.length / 2;
  }
  size += 8; // lock_time (u64)
  size += 20; // subnetwork id
  size += 8; // gas (u64)
  size += 32; // payload hash
  size += 8; // payload length (u64)
  return size;
}

/**
 * Compute the transaction's mass locally, replicating the consensus
 * `calc_compute_mass` that api.kaspa.org's `/transactions/mass` implements.
 *
 * The public endpoint is unusable for kticket templates: its storage-mass
 * formula divides by output amount (`P = Σ C//o`) and raises ZeroDivisionError
 * → HTTP 500 on the 0-value covenant outputs every ticket transaction carries
 * (verified on both api.kaspa.org and api-tn10.kaspa.org). The compute mass is
 * purely structural and deterministic, so the build endpoint derives it here.
 */
export function computeMassLocal(tx: UnsignedTransaction): LocalMass {
  const size = endpointTxSize(tx);
  const sizeMass = size * MASS_PER_TX_BYTE;
  const scriptPublicKeyMass =
    MASS_PER_SCRIPT_PUB_KEY_BYTE *
    tx.outputs.reduce((acc, output) => acc + 2 + output.scriptPublicKey.script.length / 2, 0);
  const sigOpsMass =
    MASS_PER_SIG_OP *
    tx.inputs.reduce((acc, input) => acc + decodeSigOpCount(tx.version, input.sigOpCount), 0);
  const computeMass = Math.round(sizeMass + scriptPublicKeyMass + sigOpsMass);
  return { mass: computeMass, storage_mass: 0, compute_mass: computeMass };
}
