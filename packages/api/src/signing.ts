// wasm-built signing template (forge reference — `serializeToSafeJSON()`).
//
// Kasware's `signPskt` expects the kaspa-wasm safe-JSON shape: camelCase
// fields, bigints as strings, and a full `utxo` (amount / script / daa /
// coinbase / covenantId) on every input. Hand-rolling that shape is error-prone
// (the earlier E2E caught the divergence), so we build the same
// `Transaction.serializeToSafeJSON()` output forge produces — byte-for-byte
// what the wallet signs.
//
// The covenant id is computed by the wasm (`populateGenesisCovenants`), the
// consensus reference — the kit's pure-TS `covenantId` hashing diverged from it
// and the node rejected the deploy. Forge does the same: build the tx, let the
// wasm populate the genesis covenant group, then serialize.

import type { WireTransaction, WireUtxoMeta } from "./wire.js";

const NATIVE_SUBNETWORK_ID = "0000000000000000000000000000000000000000";

interface KaspaWasm {
  Transaction: new (init: unknown) => unknown;
  GenesisCovenantGroup: new (authorizingInput: number, outputs: number[]) => unknown;
}

let wasm: KaspaWasm | null = null;

async function loadWasm(): Promise<KaspaWasm> {
  if (wasm) return wasm;
  const mod = (await import("../vendor/kaspa-wasm/kaspa.js")) as unknown as KaspaWasm;
  wasm = mod;
  return mod;
}

function toWasmUtxo(meta: WireUtxoMeta) {
  return {
    address: meta.address,
    outpoint: {
      transactionId: meta.transaction_id,
      index: meta.index,
    },
    amount: BigInt(meta.value),
    scriptPublicKey: {
      version: meta.script_public_key.version,
      script: meta.script_public_key.script,
    },
    blockDaaScore: BigInt(meta.block_daa_score),
    isCoinbase: meta.is_coinbase,
  };
}

function emptyMeta(input: WireTransaction["inputs"][number]): WireUtxoMeta {
  return {
    transaction_id: input.previous_outpoint.transaction_id,
    index: input.previous_outpoint.index,
    value: 0,
    script_public_key: { version: 0, script: "" },
    block_daa_score: 0,
    is_coinbase: false,
  };
}

function wasmInputs(tx: WireTransaction, metas: WireUtxoMeta[]) {
  return tx.inputs.map((input, i) => ({
    previousOutpoint: {
      transactionId: input.previous_outpoint.transaction_id,
      index: input.previous_outpoint.index,
    },
    signatureScript: input.signature_script,
    sequence: BigInt(input.sequence),
    sigOpCount: tx.version >= 1 ? 0 : input.sig_op_count,
    computeBudget: tx.version >= 1 ? input.sig_op_count : 0,
    utxo: toWasmUtxo(metas[i] ?? emptyMeta(input)),
  }));
}

function wasmOutputs(tx: WireTransaction) {
  return tx.outputs.map((output) => ({
    value: BigInt(output.value),
    scriptPublicKey: {
      version: output.script_public_key.version,
      script: output.script_public_key.script,
    },
  }));
}

/** Output indices the wasm must bind into a genesis covenant group (per input). */
function covenantGroups(tx: WireTransaction): { authorizingInput: number; outputs: number[] }[] {
  const groups = new Map<number, number[]>();
  for (let i = 0; i < tx.outputs.length; i++) {
    const covenant = tx.outputs[i]?.covenant;
    if (!covenant) continue;
    const list = groups.get(covenant.authorizing_input) ?? [];
    list.push(i);
    groups.set(covenant.authorizing_input, list);
  }
  return [...groups.entries()].map(([authorizingInput, outputs]) => ({
    authorizingInput,
    outputs,
  }));
}

function serializeSafe(wasmTx: unknown): string {
  const serialize = (wasmTx as { serializeToSafeJSON: () => string }).serializeToSafeJSON;
  return serialize.call(wasmTx);
}

/**
 * Build the unsigned transaction in the kaspa-wasm safe-JSON format the wallet
 * signs — `Transaction.serializeToSafeJSON()`, with a full `utxo` on each input
 * and the covenant ids computed by the wasm (the consensus reference).
 *
 * Also returns the wasm-computed covenant ids per output so the caller can fix
 * up the kit template (its pure-TS `covenantId` diverges from consensus).
 */
export async function signingTemplate(
  tx: WireTransaction,
  inputUtxoMetas: WireUtxoMeta[],
): Promise<{ signingJson: string; covenantIds: Record<number, string> }> {
  const mod = await loadWasm();
  const wasmTx = new mod.Transaction({
    version: tx.version,
    inputs: wasmInputs(tx, inputUtxoMetas),
    outputs: wasmOutputs(tx),
    lockTime: BigInt(tx.lock_time),
    subnetworkId: NATIVE_SUBNETWORK_ID,
    gas: 0n,
    payload: "",
  });

  const groups = covenantGroups(tx);
  if (groups.length > 0) {
    const populate = (wasmTx as { populateGenesisCovenants: (g: unknown[]) => void })
      .populateGenesisCovenants;
    populate.call(
      wasmTx,
      groups.map((g) => new mod.GenesisCovenantGroup(g.authorizingInput, g.outputs)),
    );
  }

  const signingJson = serializeSafe(wasmTx);
  return { signingJson, covenantIds: readCovenantIds(signingJson) };
}

function readCovenantIds(signingJson: string): Record<number, string> {
  const parsed = JSON.parse(signingJson) as {
    outputs?: Array<{ covenant?: { authorizingInput: number; covenantId: string } | null }>;
  };
  const ids: Record<number, string> = {};
  (parsed.outputs ?? []).forEach((output, index) => {
    const covenant = output.covenant;
    if (covenant) ids[index] = covenant.covenantId;
  });
  return ids;
}
