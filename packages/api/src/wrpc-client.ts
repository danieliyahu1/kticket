// wRPC transaction relay (HLD v0.22 §2.2 — POST /v1/tx/broadcast).
//
// The public REST `/transactions` submit model has no covenant field, so a
// signed kticket tx relayed that way would silently drop its covenant bindings.
// Broadcast therefore goes over wRPC (kaspa-wasm `RpcClient`), which serializes
// the full v1 transaction — covenant bindings and compute budget included.
//
// The kaspa-wasm SDK is vendored under `vendor/kaspa-wasm` (v2.0.1, rusty-kaspa
// — not published to npm with covenant support; see the forge reference).

import type { WireTransaction } from "./tx.js";

/** The zero 20-byte subnetwork id (the native subnetwork — all kticket txs use it). */
const NATIVE_SUBNETWORK_ID = "0000000000000000000000000000000000000000";

/** The vendored kaspa-wasm module surface used by the relay. */
export interface KaspaWasm {
  Transaction: new (init: unknown) => {
    [key: string]: unknown;
    populateGenesisCovenants?: (groups: unknown[]) => void;
  };
  GenesisCovenantGroup: new (authorizingInput: number, outputs: number[]) => unknown;
  RpcClient: new (
    init: unknown,
  ) => {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    submitTransaction(request: { transaction: unknown; allowOrphan: boolean }): Promise<{
      transactionId: string;
    }>;
  };
  Resolver: new () => unknown;
  Encoding: { Borsh: number };
}

let wasm: KaspaWasm | null = null;

async function loadWasm(): Promise<KaspaWasm> {
  if (wasm) return wasm;
  const mod = (await import("../vendor/kaspa-wasm/kaspa.js")) as unknown as KaspaWasm;
  wasm = mod;
  return mod;
}

function toWasmInput(
  input: WireTransaction["inputs"][number],
  version: number,
  covenantId?: string,
) {
  return {
    previousOutpoint: {
      transactionId: input.previous_outpoint.transaction_id,
      index: input.previous_outpoint.index,
    },
    signatureScript: input.signature_script,
    sequence: BigInt(input.sequence),
    sigOpCount: version >= 1 ? 0 : input.sig_op_count,
    computeBudget: version >= 1 ? input.sig_op_count : 0,
    ...(covenantId !== undefined ? { utxo: { covenantId } } : {}),
  };
}

function toWasmOutput(output: WireTransaction["outputs"][number]) {
  return {
    value: BigInt(output.value),
    scriptPublicKey: {
      version: output.script_public_key.version,
      script: output.script_public_key.script,
    },
    ...(output.covenant
      ? {
          covenant: {
            authorizingInput: output.covenant.authorizing_input,
            covenantId: output.covenant.covenant_id,
          },
        }
      : {}),
  };
}

/**
 * Submit a signed v1 transaction over wRPC, preserving covenant bindings.
 * Returns the transaction id, or throws with the node's rejection message.
 *
 * v1 shim: the wire field `sig_op_count` means compute-budget in v1 templates,
 * so it is mapped into `computeBudget` (with `sigOpCount` left 0).
 */
export async function submitTransactionOverWrpc(
  networkId: string,
  tx: WireTransaction,
): Promise<string> {
  const mod = await loadWasm();

  // Map authorizing inputs → covenant id from the outputs that reference them.
  const inputCovenant = new Map<number, string>();
  for (const output of tx.outputs) {
    if (output.covenant) {
      inputCovenant.set(output.covenant.authorizing_input, output.covenant.covenant_id);
    }
  }

  const wasmTx = new mod.Transaction({
    version: tx.version,
    inputs: tx.inputs.map((input, i) =>
      toWasmInput(input, tx.version, inputCovenant.get(i)),
    ),
    outputs: tx.outputs.map((output) => toWasmOutput(output)),
    lockTime: BigInt(tx.lock_time),
    subnetworkId: NATIVE_SUBNETWORK_ID,
    gas: 0n,
    payload: tx.payload ?? "",
  });

  const rpc = new mod.RpcClient({
    resolver: new mod.Resolver(),
    networkId,
    encoding: mod.Encoding.Borsh,
  });

  try {
    await rpc.connect();
    const resp = await rpc.submitTransaction({ transaction: wasmTx, allowOrphan: false });
    return resp.transactionId;
  } finally {
    await rpc.disconnect();
  }
}

/** Output indices the wasm must bind into a genesis covenant group (per input). */
function covenantGroupsForSubmit(
  tx: WireTransaction,
): { authorizingInput: number; outputs: number[] }[] {
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
