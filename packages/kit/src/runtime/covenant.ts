// KIP-20 covenant identifiers ("Covenant IDs") — the consensus-tracked,
// 32-byte `covenant_id` carried by UTXOs and declared by transaction outputs.
//
// Pin (spike question d): covenant ids are **per-family**. All genesis outputs
// of an event's fanout transaction share one `event_cov_id` — outputs are
// grouped by `(authorizing_input, covenant_id)`, and the genesis hash commits
// to the whole authorized output list. Every ticket of an event therefore
// carries the same covenant_id across buy / transfer / handover.
//
// Hashing (KIP-20 §3): BLAKE2b-256 keyed with domain tag "CovenantID".
//
//   covenant_id(O, auth_outputs) = BLAKE2b-256<key="CovenantID">(
//       O.tx_id || le_u32(O.index) || le_u64(len(auth_outputs))
//       || for each (out_idx, out):
//            le_u32(out_idx) || le_u64(out.value)
//            || le_u16(out.script_public_key.version)
//            || le_u64(len(out.script_public_key.script)) || out.script
//   )
//
// Reference: `consensus/core/src/hashing/covenant_id.rs` + `crypto/hashes`.

import { blake2b } from "@noble/hashes/blake2.js";
import { le16, le32, le64 } from "./bytes.js";
import { encodeVarint } from "./preimage.js";

const DOMAIN_TAG = "CovenantID";

export interface Outpoint {
  /** Transaction id bytes (32 bytes, as stored — little-endian hash bytes). */
  txId: Uint8Array;
  index: number;
}

export interface AuthorizedOutput {
  /** Output index within the transaction. */
  index: number;
  /** Output value in sompi. */
  value: number;
  /** `ScriptPublicKey.version` (0 for kticket covenant outputs). */
  version: number;
  script: Uint8Array;
}

export class CovenantIdError extends Error {
  override readonly name = "CovenantIdError";
}

/** Compute the KIP-20 genesis covenant id for an outpoint + ordered auth outputs. */
export function covenantId(
  outpoint: Outpoint,
  authOutputs: readonly AuthorizedOutput[],
): Uint8Array {
  if (outpoint.txId.length !== 32) {
    throw new CovenantIdError(`txId must be 32 bytes, got ${outpoint.txId.length}`);
  }
  if (!Number.isSafeInteger(outpoint.index) || outpoint.index < 0 || outpoint.index > 0xffffffff) {
    throw new CovenantIdError(`outpoint index ${outpoint.index} is not a u32`);
  }
  for (const output of authOutputs) {
    if (!Number.isSafeInteger(output.value) || output.value < 0) {
      throw new CovenantIdError(`output value ${output.value} is not a non-negative safe integer`);
    }
    if (!Number.isSafeInteger(output.version) || output.version < 0 || output.version > 0xffff) {
      throw new CovenantIdError(`output version ${output.version} is not a u16`);
    }
    if (!Number.isSafeInteger(output.index) || output.index < 0 || output.index > 0xffffffff) {
      throw new CovenantIdError(`output index ${output.index} is not a u32`);
    }
  }

  // BLAKE2b-256 keyed with the "CovenantID" domain tag (KIP-20 §3) — matches
  // rusty-kaspa's `blake2b_simd::Params::new().hash_length(32).key("CovenantID")`.
  const hasher = blake2b.create({ dkLen: 32, key: new TextEncoder().encode(DOMAIN_TAG) });

  hasher.update(outpoint.txId);
  hasher.update(le32(outpoint.index));
  hasher.update(le64(authOutputs.length));

  const sorted = [...authOutputs].sort((a, b) => a.index - b.index);
  for (const output of sorted) {
    hasher.update(le32(output.index));
    hasher.update(le64(output.value));
    hasher.update(le16(output.version));
    hasher.update(encodeVarint(output.script.length));
    hasher.update(output.script);
  }

  return hasher.digest();
}
