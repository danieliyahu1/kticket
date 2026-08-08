// Broadcast boundary: parse the signed v1 template a client wants relayed and
// classify an upstream rejection message into the error taxonomy (HLD §2.2).

import { conflictError, invalidError, policyError } from "./errors.js";
import { hex, hex64, int, isRecord, str, uint } from "./validate.js";
import type { WireInput, WireOutput, WireTransaction } from "./wire.js";

/** Parse + validate the broadcast request body into a signed `WireTransaction`. */
export function parseBroadcastRequest(raw: unknown): WireTransaction {
  if (!isRecord(raw)) throw invalidError("request body must be an object");
  const tx = raw.transaction;
  if (!isRecord(tx)) throw invalidError("transaction must be an object");
  const version = int(tx.version, "transaction.version");
  if (version < 1) throw invalidError("transaction.version must be >= 1 (v1 template)");
  return {
    version,
    inputs: parseInputs(tx.inputs),
    outputs: parseOutputs(tx.outputs),
    lock_time: uint(tx.lock_time ?? 0, "transaction.lock_time"),
  };
}

function parseInputs(value: unknown): WireInput[] {
  if (!Array.isArray(value)) throw invalidError("transaction.inputs must be an array");
  return value.map((entry, i) => {
    if (!isRecord(entry)) throw invalidError(`transaction.inputs[${i}] must be an object`);
    const previous = isRecord(entry.previous_outpoint) ? entry.previous_outpoint : {};
    return {
      previous_outpoint: {
        transaction_id: hex64(
          previous.transaction_id,
          `transaction.inputs[${i}].previous_outpoint.transaction_id`,
        ),
        index: uint(previous.index, `transaction.inputs[${i}].previous_outpoint.index`),
      },
      signature_script: str(
        entry.signature_script ?? "",
        `transaction.inputs[${i}].signature_script`,
      ),
      sequence: uint(entry.sequence ?? 0, `transaction.inputs[${i}].sequence`),
      sig_op_count: uint(entry.sig_op_count ?? 1, `transaction.inputs[${i}].sig_op_count`),
    };
  });
}

function parseOutputs(value: unknown): WireOutput[] {
  if (!Array.isArray(value)) throw invalidError("transaction.outputs must be an array");
  return value.map((entry, i) => {
    if (!isRecord(entry)) throw invalidError(`transaction.outputs[${i}] must be an object`);
    const spk = isRecord(entry.script_public_key) ? entry.script_public_key : {};
    const covenant = entry.covenant;
    if (covenant !== null && covenant !== undefined && !isRecord(covenant)) {
      throw invalidError(`transaction.outputs[${i}].covenant must be an object or null`);
    }
    return {
      value: uint(entry.value, `transaction.outputs[${i}].value`),
      script_public_key: {
        version: int(spk.version, `transaction.outputs[${i}].script_public_key.version`),
        script: hex(spk.script, `transaction.outputs[${i}].script_public_key.script`),
      },
      covenant:
        covenant === null || covenant === undefined
          ? null
          : {
              authorizing_input: uint(
                covenant.authorizing_input,
                `transaction.outputs[${i}].covenant.authorizing_input`,
              ),
              covenant_id: hex64(
                covenant.covenant_id,
                `transaction.outputs[${i}].covenant.covenant_id`,
              ),
            },
    };
  });
}

/**
 * Classify an upstream rejection message into the taxonomy
 * (invalid / conflict / policy). Always throws — it never returns.
 */
export function throwRejectionError(message: string): never {
  const m = message.toLowerCase();
  if (m.includes("double spend") || m.includes("already") || m.includes("orphan")) {
    throw conflictError("transaction rejected: double spend or already known", { detail: message });
  }
  if (m.includes("fee") || m.includes("mass")) {
    throw policyError("transaction rejected: fee policy", { detail: message });
  }
  throw invalidError("transaction rejected", { detail: message });
}
