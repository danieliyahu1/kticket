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

/** The vendored kaspa-wasm module surface used by the relay. */
export interface KaspaWasm {
  Transaction: new (init: unknown) => { [key: string]: unknown };
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

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  return 0n;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return 0;
}

/**
 * Submit a signed v1 transaction over wRPC, preserving covenant bindings.
 * Returns the transaction id, or throws with the node's rejection message.
 */
export async function submitTransactionOverWrpc(
  networkId: string,
  tx: WireTransaction,
): Promise<string> {
  const mod = await loadWasm();
  const wasmTx = new mod.Transaction({
    version: tx.version,
    inputs: tx.inputs.map((input) => ({
      previousOutpoint: {
        transactionId: input.previous_outpoint.transaction_id,
        index: input.previous_outpoint.index,
      },
      signatureScript: input.signature_script,
      sequence: toBigInt(input.sequence),
      sigOpCount: tx.version >= 1 ? 0 : input.sig_op_count,
      computeBudget: tx.version >= 1 ? input.sig_op_count : 0,
    })),
    outputs: tx.outputs.map((output) => ({
      value: toBigInt(output.value),
      scriptPublicKey: {
        version: toNumber(output.script_public_key.version),
        script: output.script_public_key.script,
      },
      ...(tx.version >= 1 && output.covenant
        ? {
            covenant: {
              authorizingInput: toNumber(output.covenant.authorizing_input),
              covenantId: output.covenant.covenant_id,
            },
          }
        : {}),
    })),
    lockTime: toBigInt(tx.lock_time),
    subnetworkId: "0000000000000000000000000000000000000000",
    gas: 0n,
    payload: "",
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
