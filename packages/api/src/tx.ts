// kticket tx endpoints (HLD v0.22 §2.2 — POST /v1/tx/build, POST /v1/tx/broadcast).
//
// build: turns a client description of the transaction (type + inputs) into an
// unsigned v1 template, fee-aware:
//
//   1. build a provisional template (fee = 0) to learn the structure;
//   2. compute mass + compute_mass locally (the consensus formula — the public
//      `/transactions/mass` divides by output amount and 500s on the covenant
//      outputs every kticket tx carries);
//   3. `GET /info/fee-estimate` → priority bucket feerate (sompi/gram);
//   4. fee = max(feerate × mass, 100 × max(compute_mass, 2 × sizeBytes));
//   5. rebuild with the real fee so the change output sets `inputs − outputs = fee`.
//
// The wallet supplies its own UTXOs (it knows its balance — the API never holds
// keys); the API validates they cover the payouts + fee, then returns the
// unsigned template for the wallet to sign.
//
// broadcast: relay a signed tx → `{ txid }` over wRPC (kaspa-wasm RpcClient),
// preserving covenant bindings — the public REST submit model has no covenant
// field. Idempotent: re-broadcasting an already-known tx succeeds.

import { computeFee, computeMassLocal, estimatedSerializedSize } from "@kticket/kit";
import { parseBroadcastRequest, throwRejectionError } from "./broadcast.js";
import { type BuiltTransaction, type PreparedBuild, preparedBuildFor } from "./builders.js";
import { policyError } from "./errors.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import { signingTemplate } from "./signing.js";
import {
  type BroadcastResult,
  type BuildResult,
  parseBuildRequest,
  type TxContext,
  toWireTx,
  type WireTransaction,
} from "./wire.js";
import { submitTransactionOverWrpc } from "./wrpc-client.js";

export { throwRejectionError } from "./broadcast.js";
export {
  type BroadcastResult,
  type BuildRequest,
  type BuildResult,
  parseBuildRequest,
  type TicketConstantsJson,
  type TxContext,
  toSubmitModel,
  toWireTx,
  type WireCovenant,
  type WireInput,
  type WireOutpoint,
  type WireOutput,
  type WireScriptPublicKey,
  type WireTransaction,
  type WireUtxo,
} from "./wire.js";

/** Map any build/relay failure to a `policy` error (inputs cannot cover). */
function throwPolicy(err: unknown, fallback: string): never {
  throw policyError(err instanceof Error ? err.message : fallback);
}

async function buildFeeAware(
  prepared: PreparedBuild,
  kaspa: KaspaClientLike,
): Promise<BuiltTransaction> {
  let provisional: BuiltTransaction;
  try {
    provisional = prepared.build(0);
  } catch (err) {
    throwPolicy(err, "inputs cannot cover the payouts");
  }

  const sizeBytes = estimatedSerializedSize(provisional.tx);
  const massResult = computeMassLocal(provisional.tx);
  const feerate = (await kaspa.getFeeEstimate()).priorityBucket.feerate;

  let fee: number;
  try {
    fee = computeFee({
      mass: massResult.mass,
      sizeBytes,
      feerateSompiPerGram: feerate,
      inputTotal: prepared.inputTotal,
      payouts: prepared.payouts,
      computeMass: massResult.compute_mass,
    }).fee;
  } catch (err) {
    throwPolicy(err, "inputs cannot cover payouts + fee");
  }

  let built: BuiltTransaction;
  try {
    built = prepared.build(fee);
  } catch (err) {
    throwPolicy(err, "inputs cannot cover payouts + fee");
  }

  return built;
}

export async function buildTransaction(raw: unknown, ctx: TxContext): Promise<BuildResult> {
  const request = parseBuildRequest(raw);
  const prepared = await preparedBuildFor(request, ctx.kaspa);

  const built = await buildFeeAware(prepared, ctx.kaspa);

  const wire = toWireTx(built.tx);

  if (built.covenantRedeemScript && wire.inputs.length > 0 && wire.inputs[0]) {
    wire.inputs[0].signature_script = built.covenantRedeemScript;
  }

  const result: BuildResult = { template: wire };

  if (built.eventCovenantId) {
    result.event_covenant_id = built.eventCovenantId;
  }

  if (hasCompleteUtxoMetas(prepared.inputUtxoMetas)) {
    const { signingJson, covenantIds } = await signingTemplate(
      wire,
      prepared.inputUtxoMetas,
    );
    const patched = patchContinuationCovenantIds(signingJson, wire, request.type);
    result.signing_template = patched ?? signingJson;
    applyWasmCovenantIds(
      result,
      patched ? readSigningCovenantIds(patched) : covenantIds,
    );
  }

  if (request.type !== "deploy" && "event_covenant_id" in request) {
    result.event_covenant_id = request.event_covenant_id;
  }

  return result;
}

/**
 * `populateGenesisCovenants` recomputes covenant ids for every transaction as
 * if it were a new genesis. For continuation txs (buy / transfer / handover),
 * the outputs must carry the genesis family id from the wire template. Patch
 * the signing JSON so Kasware signs the correct ids, and returns the patched
 * JSON (or null if no patch was needed).
 */
function patchContinuationCovenantIds(
  signingJson: string,
  wire: WireTransaction,
  type: string,
): string | null {
  if (type === "deploy") return null;

  const parsed = JSON.parse(signingJson) as { outputs?: Array<Record<string, unknown>> };
  let changed = false;
  (parsed.outputs ?? []).forEach((output, i) => {
    const wireCov = wire.outputs[i]?.covenant;
    const signingCov = output?.covenant as { covenantId?: string } | undefined;
    if (wireCov && signingCov && signingCov.covenantId !== wireCov.covenant_id) {
      signingCov.covenantId = wireCov.covenant_id;
      changed = true;
    }
  });

  return changed ? JSON.stringify(parsed) : null;
}

function readSigningCovenantIds(signingJson: string): Record<number, string> {
  const parsed = JSON.parse(signingJson) as {
    outputs?: Array<{ covenant?: { covenantId: string } | null }>;
  };
  const ids: Record<number, string> = {};
  (parsed.outputs ?? []).forEach((output, i) => {
    if (output?.covenant) ids[i] = output.covenant.covenantId;
  });
  return ids;
}

/** Patch the template's covenant ids to the consensus (wasm) values. */
function applyWasmCovenantIds(result: BuildResult, ids: Record<number, string>): void {
  for (const [index, id] of Object.entries(ids)) {
    const output = result.template.outputs[Number(index)];
    if (output?.covenant) {
      output.covenant.covenant_id = id;
    }
  }
  if (result.event_covenant_id) {
    result.event_covenant_id = ids[0] ?? result.event_covenant_id;
  }
}

/** Only signable when every input has a real previous-output script (empty = wallet didn't supply). */
function hasCompleteUtxoMetas(
  metas: readonly { script_public_key: { script: string } }[],
): boolean {
  return metas.length > 0 && metas.every((m) => m.script_public_key.script.length > 0);
}

export async function broadcastTransaction(raw: unknown, ctx: TxContext): Promise<BroadcastResult> {
  const tx: WireTransaction = parseBroadcastRequest(raw);
  try {
    const txid = await submitTransactionOverWrpc(ctx.networkId, tx);
    return { txid: txid.toLowerCase() };
  } catch (err) {
    throwRejectionError(err instanceof Error ? err.message : String(err));
  }
}
