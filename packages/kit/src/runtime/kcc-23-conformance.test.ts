// KCC-23 conformance: the kit's hashing must reproduce the values published in
// kaspanet/kccs `kcc-0023/vectors/conformance.json`.
//
// This is the only *external* oracle for the KCC-23 path. Every other test in
// the suite derives its expectation from our own code, so a misreading of the
// spec would agree with itself. The fixture is vendored unchanged; its source,
// commit and refresh rule live in `kcc-23-conformance.pin.md`.

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { decodeMetadataFromPayload, isKcc23Payload } from "./builder";
import { covenantId, type AuthorizedOutput, type Outpoint } from "./covenant";
import conformance from "./kcc-23-conformance.json";
import { payloadDigest, txIdPreimageV1, txIdV1 } from "./serialize";
import type { UnsignedTransaction } from "./tx";

const binding = conformance.binding;
const preparation = binding.preparation_transaction;
const genesis = binding.genesis_transaction;
const expected = binding.expected;

/**
 * The vector's preparation transaction as the kit's template.
 *
 * The wire field `sig_op_count` carries the v1 compute budget (the shim in
 * `packages/api/src/wrpc-client.ts` maps it to wasm's `computeBudget`), so the
 * vector's `compute_budget` is passed through it.
 */
function preparationTransaction(payloadHex: string = preparation.payload_hex): UnsignedTransaction {
  return {
    version: preparation.version,
    inputs: preparation.inputs.map((input) => ({
      previousOutpoint: {
        txId: input.previous_outpoint.transaction_id,
        index: input.previous_outpoint.index,
      },
      signatureScript: input.signature_script_hex,
      sequence: input.sequence,
      sigOpCount: input.compute_budget,
    })),
    outputs: preparation.outputs.map((output) => ({
      value: output.value,
      scriptPublicKey: {
        version: output.script_public_key.version,
        script: output.script_public_key.script_hex,
      },
      // The vector's preparation output is not a covenant output.
      covenant: null,
    })),
    lockTime: preparation.lock_time,
    payload: payloadHex,
  };
}

/** The outpoint the genesis transaction's authorizing input spends. */
function genesisAuthorizingOutpoint(): Outpoint {
  const input = genesis.inputs[0];
  if (!input) throw new Error("the vector's genesis transaction has no authorizing input");
  return {
    txId: hexToBytes(input.previous_outpoint.transaction_id),
    index: input.previous_outpoint.index,
  };
}

/** The genesis output group the covenant id commits to, in vector order. */
function genesisAuthorizedOutputs(): AuthorizedOutput[] {
  return binding.genesis_output_indices.map((index) => {
    const output = genesis.outputs[index];
    if (!output) throw new Error(`the vector lists a genesis output ${index} it does not define`);
    return {
      index,
      value: output.value,
      version: output.script_public_key.version,
      script: hexToBytes(output.script_public_key.script_hex),
    };
  });
}

/** The payload the `changed_metadata` mutation substitutes. */
function changedMetadataPayload(): string {
  const mutation = conformance.binding_mutations.find((m) => m.name === "changed_metadata");
  if (!mutation) throw new Error("the vector no longer defines the changed_metadata mutation");
  const payload = mutation.replace["/preparation_transaction/payload_hex"];
  if (!payload) throw new Error("changed_metadata no longer replaces the preparation payload");
  return payload;
}

describe("KCC-23 conformance: the binding vector", () => {
  it("builds the preparation id preimage the spec publishes", () => {
    expect(bytesToHex(txIdPreimageV1(preparationTransaction()))).toBe(expected.rest_preimage_hex);
  });

  it("derives the payload digest the spec publishes", () => {
    expect(bytesToHex(payloadDigest(hexToBytes(preparation.payload_hex)))).toBe(
      expected.payload_digest,
    );
  });

  it("derives the preparation transaction id the spec publishes", () => {
    expect(txIdV1(preparationTransaction())).toBe(expected.preparation_transaction_id);
  });

  it("derives the covenant id the spec publishes", () => {
    const id = covenantId(genesisAuthorizingOutpoint(), genesisAuthorizedOutputs());
    expect(bytesToHex(id)).toBe(expected.covenant_id);
  });
});

describe("KCC-23 conformance: the commitment is load-bearing", () => {
  it("declares the vector's expected covenant id on the genesis output it commits to", () => {
    const covenant = genesis.outputs[0]?.covenant;
    if (!covenant) throw new Error("the vector's genesis output declares no covenant");
    expect(covenant.covenant_id).toBe(expected.covenant_id);
  });

  it("changes the preparation tx id when one payload byte changes, breaking the binding", () => {
    const id = txIdV1(preparationTransaction(changedMetadataPayload()));
    expect(id).toBe(
      conformance.binding_mutations.find((m) => m.name === "changed_metadata")
        ?.expected_preparation_transaction_id,
    );
    expect(id).not.toBe(expected.preparation_transaction_id);
  });
});

describe("KCC-23 conformance: the declaration vectors", () => {
  // `isKcc23Payload` answers the codec-prefix question only; the kticket decoder
  // is deliberately stricter than KCC-23 (an `{}` declaration is valid KCC-23 but
  // carries no event metadata), so the two valid vectors are not asserted here.
  it("classifies every declaration by its codec prefix", () => {
    for (const declaration of conformance.declarations) {
      expect(isKcc23Payload(declaration.payload_hex), declaration.name).toBe(
        declaration.payload_hex.startsWith(conformance.codec_prefix_hex),
      );
    }
  });

  it("rejects every declaration the vector marks invalid", () => {
    const invalid = conformance.declarations.filter((declaration) => !declaration.valid);
    expect(invalid.length).toBeGreaterThan(0);
    for (const declaration of invalid) {
      expect(decodeMetadataFromPayload(declaration.payload_hex), declaration.name).toBeNull();
    }
  });
});
