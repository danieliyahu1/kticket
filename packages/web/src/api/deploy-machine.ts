import { deployFinalize, deployPrepare, ServerError } from "./client";
import type { DeployPrepareRequest } from "./types";
import { signTemplate } from "../lib/signing";
import { devError, devLog } from "../lib/log";

export type DeployState =
  | { phase: "idle" }
  | { phase: "building" }
  | { phase: "signing" }
  | { phase: "broadcasting" }
  | { phase: "success"; txid: string; covenantId: string }
  | { phase: "error"; message: string };

export interface DeployParams {
  capacity: number;
  priceKas: number;
  publicKey: string;
  address: string;
  name?: string;
  date?: string;
  time?: string;
}

function errorMsg(err: unknown): string {
  if (!(err instanceof Error)) return "Deploy failed.";
  if (err instanceof ServerError) return "The server isn't responding — deploy can't complete.";
  // The backend owns the message; the frontend relays it.
  return err.message;
}

function logError(context: string, err: unknown): void {
  devError(`[deploy:${context}]`, err);
}

function logStep(step: string, detail?: unknown): void {
  devLog(`[deploy:${step}]`, detail ?? "");
}

/**
 * The whole deploy flow is owned by the backend (`POST /v1/events/deploy/prepare`
 * and `/deploy/finalize`):
 *   prepare  → backend fetches UTXOs + builds the unsigned template
 *   wallet   → signs the template (the one thing only it can do)
 *   finalize → backend merges the signature, broadcasts, waits for
 *              confirmation, and registers the event locally
 *
 * The frontend only relays: it sends the deploy inputs, hands the template to
 * the wallet, and sends back the template + the wallet's output. It never
 * merges, retries, or persists pipeline state. "Success" is set only after the
 * backend confirms the event is registered.
 */
export async function executeDeploy(
  setState: (s: DeployState) => void,
  params: DeployParams,
): Promise<void> {
  setState({ phase: "building" });
  logStep("start", params);

  const prepareReq: DeployPrepareRequest = {
    capacity: params.capacity,
    price_kas: params.priceKas,
    publicKey: params.publicKey,
    address: params.address,
    ...(params.name !== undefined ? { name: params.name } : {}),
    ...(params.date !== undefined ? { date: params.date } : {}),
    ...(params.time !== undefined ? { time: params.time } : {}),
  };

  let prepared;
  try {
    prepared = await deployPrepare(prepareReq);
    logStep("prepared", {
      deployId: prepared.deploy_id,
      eventCovenantId: prepared.event_covenant_id,
      signingTemplateLen: prepared.signing_template.length,
    });
  } catch (err) {
    logError("prepare", err);
    setState({ phase: "error", message: errorMsg(err) });
    return;
  }

  setState({ phase: "signing" });
  let signed;
  try {
    signed = await signTemplate(prepared.signing_template);
    logStep("signed", { type: typeof signed });
  } catch (err) {
    logError("sign", err);
    setState({ phase: "error", message: errorMsg(err) });
    return;
  }

  setState({ phase: "broadcasting" });
  try {
    const result = await deployFinalize({
      deploy_id: prepared.deploy_id,
      template: prepared.template,
      signed,
    });
    logStep("finalized", result);
    setState({ phase: "success", txid: result.deploy_txid, covenantId: result.covenant_id });
  } catch (err) {
    logError("finalize", err);
    setState({ phase: "error", message: errorMsg(err) });
  }
}
