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
 * Build the wasm `Transaction` for a signed v1 wire template — the object the
 * RPC relay serializes. `populateGenesisCovenants` is intentionally NOT called:
 * the outputs already carry the covenant bindings the client committed to.
 */
export async function buildWasmTransaction(tx: WireTransaction): Promise<unknown> {
  const mod = await loadWasm();

  return new mod.Transaction({
    version: tx.version,
    inputs: tx.inputs.map((input) => toWasmInput(input, tx.version)),
    outputs: tx.outputs.map((output) => toWasmOutput(output)),
    lockTime: BigInt(tx.lock_time),
    subnetworkId: NATIVE_SUBNETWORK_ID,
    gas: 0n,
    payload: tx.payload ?? "",
  });
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
  const wasmTx = await buildWasmTransaction(tx);

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
