import { BURN_ARTIFACT, burnTemplateHash } from "@kticket/kit";
import { broadcastTx, buildDeployTx } from "./client";
import { organizerPkh, orgSpkFromPublicKey } from "./crypto";
import type { KaspaUtxoEntry } from "./kaspa";
import { changeScriptFromPublicKey, fetchUtxos, toWireUtxo, toWireUtxoMeta } from "./kaspa";
import type { BuildResult, WireTransaction } from "./types";

const SOMPI_PER_KAS = 100_000_000;
const LOG_SAMPLE_LEN = 400;

export type DeployState =
  | { phase: "idle" }
  | { phase: "building" }
  | { phase: "broadcasting" }
  | { phase: "success"; txid: string }
  | { phase: "error"; message: string };

export interface DeployParams {
  capacity: number;
  priceKas: number;
  publicKey: string;
  address: string;
  eventId: string;
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
  eventId: string,
  selection: {
    authorizing: ReturnType<typeof toWireUtxo>;
    rest: ReturnType<typeof toWireUtxo>[];
    metas: ReturnType<typeof toWireUtxoMeta>[];
  },
): Promise<BuildResult> {
  return buildDeployTx({
    capacity: params.capacity,
    eventId,
    price: Math.round(params.priceKas * SOMPI_PER_KAS),
    orgSpk: orgSpkFromPublicKey(params.publicKey),
    burnTemplateHash: burnTemplateHash(eventId, BURN_ARTIFACT.code),
    organizer: organizerPkh(params.publicKey),
    authorizingOutpoint: selection.authorizing,
    organizerUtxos: selection.rest,
    changeSpk: changeScriptFromPublicKey(params.publicKey),
    inputUtxoMetas: selection.metas,
  });
}

export async function executeDeploy(
  setState: (s: DeployState) => void,
  params: DeployParams,
): Promise<void> {
  setState({ phase: "building" });
  logStep("start", params);

  const eventId = params.eventId;
  logStep("event-id", eventId);

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

  let buildResult: BuildResult;
  try {
    buildResult = await buildDeployTemplate(params, eventId, selection);
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
  await signAndBroadcast(buildResult, setState);
}

async function signAndBroadcast(
  buildResult: BuildResult,
  setState: (s: DeployState) => void,
): Promise<void> {
  let signedTx: WireTransaction;
  try {
    const signed = await signTemplate(buildResult);
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
    setState({ phase: "success", txid: result.txid });
  } catch (err) {
    logError("broadcast", err);
    setState({ phase: "error", message: errorMsg(err) });
  }
}

async function signTemplate(buildResult: BuildResult): Promise<unknown> {
  const kasware = window.kasware;
  if (!(kasware && "signPskt" in kasware)) return buildResult.template;

  const signingJson = buildResult.signing_template;
  if (!signingJson) {
    throw new Error("No signing template from build");
  }
  logStep("safe-json", signingJson.slice(0, LOG_SAMPLE_LEN));
  return kasware.signPskt({ txJsonString: signingJson });
}

function mergeSignatures(template: WireTransaction, signed: unknown): WireTransaction {
  const json = typeof signed === "string" ? signed : String(signed);
  const parsed = JSON.parse(json) as {
    inputs?: Array<{ transactionId: string; index: number; signatureScript?: string }>;
  };
  const byInput = new Map(
    (parsed.inputs ?? []).map((input) => [`${input.transactionId}:${input.index}`, input]),
  );
  return {
    ...template,
    inputs: template.inputs.map((input) => {
      const key = `${input.previous_outpoint.transaction_id}:${input.previous_outpoint.index}`;
      const signedInput = byInput.get(key);
      return {
        ...input,
        signature_script: signedInput?.signatureScript ?? input.signature_script,
      };
    }),
  };
}
