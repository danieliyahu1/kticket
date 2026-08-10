import { BURN_ARTIFACT } from "@kticket/kit";
import { broadcastTx, buildDeployTx } from "./client";
import { organizerPkh, orgSpkFromPublicKey } from "./crypto";
import type { KaspaUtxoEntry } from "./kaspa";
import { changeScriptFromPublicKey, fetchUtxos, toWireUtxo, toWireUtxoMeta } from "./kaspa";
import type { BuildResult } from "./types";
import { mergeSignatures, signTemplate, SOMPI_PER_KAS } from "../lib/signing";
const LOG_SAMPLE_LEN = 400;

/**
 * The wire requires a `burn_template_hash` constant, but the authoritative
 * value is derived server-side at compile time (authorizing_txid baked into the
 * burn bytecode). The client sends the reference artifact's template hash as a
 * placeholder; the API overrides it with the per-event value.
 */
function referenceBurnTemplateHash(): string {
  return BURN_ARTIFACT.template_hash
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export type DeployState =
  | { phase: "idle" }
  | { phase: "building" }
  | { phase: "broadcasting" }
  | { phase: "success"; txid: string; authorizingTxId: string; covenantId: string }
  | { phase: "error"; message: string };

export interface DeployParams {
  capacity: number;
  priceKas: number;
  publicKey: string;
  address: string;
  name?: string;
  date?: string;
}

function errorMsg(err: unknown): string {
  if (!(err instanceof Error)) return "Deploy failed.";
  const msg = err.message;
  if (msg === "No connection") return "No connection - deploy can't complete.";
  if (msg.includes("funds")) return "Not enough funds - deploy didn't go through.";
  return "Deploy failed.";
}

function logError(context: string, err: unknown): void {
  console.error(`[deploy:${context}]`, err);
}

function logStep(step: string, detail?: unknown): void {
  console.log(`[deploy:${step}]`, detail ?? "");
}

function pickUtxos(utxos: KaspaUtxoEntry[]):
  | {
      ok: true;
      authorizing: ReturnType<typeof toWireUtxo>;
      rest: ReturnType<typeof toWireUtxo>[];
      metas: ReturnType<typeof toWireUtxoMeta>[];
    }
  | { ok: false; message: string } {
  if (utxos.length === 0 || !utxos[0]) {
    return { ok: false, message: "Not enough funds - deploy didn't go through." };
  }
  return {
    ok: true,
    authorizing: toWireUtxo(utxos[0]),
    rest: utxos.slice(1).map(toWireUtxo),
    metas: utxos.map(toWireUtxoMeta),
  };
}

async function buildDeployTemplate(
  params: DeployParams,
  authorizingTxId: string,
  selection: {
    authorizing: ReturnType<typeof toWireUtxo>;
    rest: ReturnType<typeof toWireUtxo>[];
    metas: ReturnType<typeof toWireUtxoMeta>[];
  },
): Promise<BuildResult> {
  return buildDeployTx({
    capacity: params.capacity,
    authorizingTxId,
    price: Math.round(params.priceKas * SOMPI_PER_KAS),
    orgSpk: orgSpkFromPublicKey(params.publicKey),
    burnTemplateHash: referenceBurnTemplateHash(),
    organizer: organizerPkh(params.publicKey),
    authorizingOutpoint: selection.authorizing,
    organizerUtxos: selection.rest,
    changeSpk: changeScriptFromPublicKey(params.publicKey),
    inputUtxoMetas: selection.metas,
    ...(params.name !== undefined ? { name: params.name } : {}),
    ...(params.date !== undefined ? { date: params.date } : {}),
  });
}

export async function executeDeploy(
  setState: (s: DeployState) => void,
  params: DeployParams,
): Promise<void> {
  setState({ phase: "building" });
  logStep("start", params);

  let utxos: KaspaUtxoEntry[];
  try {
    utxos = await fetchUtxos(params.address);
    logStep("utxos", { count: utxos.length, first: utxos[0] });
  } catch (err) {
    logError("utxos", err);
    setState({ phase: "error", message: "No connection - deploy can't complete." });
    return;
  }

  const selection = pickUtxos(utxos);
  if (!selection.ok) {
    logError("pick-utxos", selection.message);
    setState({ phase: "error", message: selection.message });
    return;
  }

  const authorizingTxId = selection.authorizing.transaction_id.toLowerCase();
  logStep("authorizing-txid", authorizingTxId);

  let buildResult: BuildResult;
  try {
    buildResult = await buildDeployTemplate(params, authorizingTxId, selection);
    logStep("built", {
      covenantId: buildResult.event_covenant_id,
      signingTemplate: buildResult.signing_template?.slice(0, LOG_SAMPLE_LEN),
    });
  } catch (err) {
    logError("build", err);
    setState({ phase: "error", message: errorMsg(err) });
    return;
  }

  setState({ phase: "broadcasting" });
  await signAndBroadcast(buildResult, authorizingTxId, buildResult.event_covenant_id!, setState);
}

async function signAndBroadcast(
  buildResult: BuildResult,
  authorizingTxId: string,
  covenantId: string,
  setState: (s: DeployState) => void,
): Promise<void> {
  let signedTx;
  try {
    const signed = await signTemplate(buildResult.signing_template!);
    logStep("signed", {
      type: typeof signed,
      sample: JSON.stringify(signed).slice(0, LOG_SAMPLE_LEN),
    });
    signedTx = mergeSignatures(buildResult.template, signed);
    logStep("merged", JSON.stringify(signedTx));
  } catch (err) {
    logError("sign", err);
    setState({ phase: "error", message: errorMsg(err) });
    return;
  }

  try {
    const result = await broadcastTx(signedTx);
    logStep("broadcast-ok", result);
    setState({ phase: "success", txid: result.txid, authorizingTxId, covenantId });
  } catch (err) {
    logError("broadcast", err);
    setState({ phase: "error", message: errorMsg(err) });
  }
}


