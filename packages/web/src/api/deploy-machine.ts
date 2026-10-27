import { deployFinalize, deployGenesis, deployPrepare } from "./client";
import type { DeployPrepareRequest } from "./types";
import { signTemplate } from "../lib/signing";
import { devError, devLog } from "../lib/log";
import { notifyCanceled } from "../lib/notify";
import { presentError } from "../lib/present-error";
import { isWalletCanceled } from "../wallet/cancel";

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
  ticker?: string;
  decimals?: number;
  image?: string;
  imageHash?: string;
  /** False when the wallet changed after prepare — never finalize a stale flow. */
  isCurrent?: () => boolean;
}

function deployErrorMessage(err: unknown): string {
  return presentError(err, "Couldn't create the event. Try again.");
}

function logError(context: string, err: unknown): void {
  devError(`[deploy:${context}]`, err);
}

function logStep(step: string, detail?: unknown): void {
  devLog(`[deploy:${step}]`, detail ?? "");
}

function stillCurrent(params: DeployParams): boolean {
  return params.isCurrent === undefined || params.isCurrent();
}

/** One signing round: hand the template to the wallet, or take the flow to idle. */
type SignResult = { signed: unknown } | { canceled: true } | { error: string };

async function sign(
  setState: (s: DeployState) => void,
  signingTemplate: string,
): Promise<SignResult> {
  setState({ phase: "signing" });
  try {
    const signed = await signTemplate(signingTemplate);
    logStep("signed", { type: typeof signed });
    return { signed };
  } catch (err) {
    if (isWalletCanceled(err)) {
      logStep("canceled");
      setState({ phase: "idle" });
      notifyCanceled(err);
      return { canceled: true };
    }
    logError("sign", err);
    return { error: deployErrorMessage(err) };
  }
}

/**
 * The whole deploy flow is owned by the backend (KCC-23 takes two transactions,
 * so signing takes two rounds):
 *   prepare  → backend builds the unsigned preparation template (metadata in
 *              its payload)
 *   wallet   → signs it
 *   genesis  → backend relays the prep tx, then builds the genesis template
 *              spending its output
 *   wallet   → signs it
 *   finalize → backend merges the signature, broadcasts, waits for
 *              confirmation, and registers the event locally
 *
 * The frontend only relays: it sends the deploy inputs, hands each template to
 * the wallet, and sends back the template + the wallet's output. It never
 * merges, retries, or persists pipeline state. "Success" is set only after the
 * backend confirms the event is registered. A canceled wallet prompt returns
 * the flow to idle (KTK-175).
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
    ...(params.ticker !== undefined ? { ticker: params.ticker } : {}),
    ...(params.decimals !== undefined ? { decimals: params.decimals } : {}),
    ...(params.image !== undefined ? { image: params.image } : {}),
    ...(params.imageHash !== undefined ? { image_hash: params.imageHash } : {}),
  };

  let prepared;
  try {
    prepared = await deployPrepare(prepareReq);
    logStep("prepared", {
      deployId: prepared.deploy_id,
      signingTemplateLen: prepared.preparation.signing_template.length,
    });
  } catch (err) {
    logError("prepare", err);
    setState({ phase: "error", message: deployErrorMessage(err) });
    return;
  }
  if (!stillCurrent(params)) {
    setState({ phase: "idle" });
    return;
  }

  const preparationSignature = await sign(setState, prepared.preparation.signing_template);
  if ("canceled" in preparationSignature) return;
  if ("error" in preparationSignature) {
    setState({ phase: "error", message: preparationSignature.error });
    return;
  }
  if (!stillCurrent(params)) {
    setState({ phase: "idle" });
    return;
  }

  let genesis;
  setState({ phase: "building" });
  try {
    genesis = await deployGenesis({
      ...prepareReq,
      deploy_id: prepared.deploy_id,
      preparation: {
        template: prepared.preparation.template,
        signed: preparationSignature.signed,
      },
    });
    logStep("genesis", {
      preparationTxid: genesis.preparation_txid,
      eventCovenantId: genesis.event_covenant_id,
    });
  } catch (err) {
    logError("genesis", err);
    setState({ phase: "error", message: deployErrorMessage(err) });
    return;
  }
  if (!stillCurrent(params)) {
    setState({ phase: "idle" });
    return;
  }

  const genesisSignature = await sign(setState, genesis.genesis.signing_template);
  if ("canceled" in genesisSignature) return;
  if ("error" in genesisSignature) {
    setState({ phase: "error", message: genesisSignature.error });
    return;
  }
  if (!stillCurrent(params)) {
    setState({ phase: "idle" });
    return;
  }

  setState({ phase: "broadcasting" });
  try {
    const result = await deployFinalize({
      deploy_id: prepared.deploy_id,
      template: genesis.genesis.template,
      signed: genesisSignature.signed,
    });
    logStep("finalized", result);
    setState({ phase: "success", txid: result.deploy_txid, covenantId: result.covenant_id });
  } catch (err) {
    logError("finalize", err);
    setState({ phase: "error", message: deployErrorMessage(err) });
  }
}
