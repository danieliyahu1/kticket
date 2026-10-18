import { buyFinalize, buyPrepare } from "./client";
import type { BuyPrepareResult } from "./client";
import { signTemplate } from "../lib/signing";
import { devError, devLog } from "../lib/log";
import { notifyCanceled, notifyFailure } from "../lib/notify";
import { isWalletCanceled } from "../wallet/cancel";

export type BuyState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "building" }
  | { phase: "broadcasting" }
  | { phase: "success"; txid: string };

export interface BuyParams {
  covenantId: string;
  publicKey: string;
  address: string;
  /** False when the wallet changed after prepare — never finalize a stale flow. */
  isCurrent?: () => boolean;
}

function logError(context: string, err: unknown): void {
  devError(`[buy:${context}]`, err);
}

function logStep(step: string, detail?: unknown): void {
  devLog(`[buy:${step}]`, detail ?? "");
}

function reportError(
  setState: (s: BuyState) => void,
  context: string,
  err: unknown,
): void {
  logError(context, err);
  setState({ phase: "idle" });
  notifyFailure(err, "Couldn't buy the ticket. Try again.");
}

function reportCanceled(setState: (s: BuyState) => void, err: unknown): void {
  logStep("canceled");
  setState({ phase: "idle" });
  notifyCanceled(err);
}

function stillCurrent(params: BuyParams): boolean {
  return params.isCurrent === undefined || params.isCurrent();
}

/**
 * The buy flow is owned by the backend (`POST /v1/events/{covenantId}/buy/prepare`
 * and `/buy/finalize`):
 *   prepare  → backend verifies the event + fetches the buyer's UTXOs + builds
 *              the unsigned template
 *   wallet   → signs the inputs the backend listed
 *   finalize → backend merges the signature, broadcasts, and waits for
 *              confirmation
 *
 * The frontend only relays. It never fetches UTXOs, merges signatures, or
 * broadcasts. "Success" is set only after the backend confirms the tx. The
 * backend also rejects sold-out buys during prepare. A canceled wallet prompt
 * returns the flow to idle and says so once; a failure is a toast, never an
 * inline panel too (KTK-175).
 */
export async function executeBuy(
  setState: (s: BuyState) => void,
  params: BuyParams,
): Promise<void> {
  setState({ phase: "loading" });

  let prepared: BuyPrepareResult;
  try {
    prepared = await buyPrepare(params.covenantId, {
      publicKey: params.publicKey,
      address: params.address,
    });
    logStep("prepared", { buyId: prepared.buy_id, price: prepared.price, signInputs: prepared.sign_inputs });
  } catch (err) {
    reportError(setState, "prepare", err);
    return;
  }
  if (!stillCurrent(params)) {
    setState({ phase: "idle" });
    return;
  }

  setState({ phase: "building" });

  let signed: unknown;
  try {
    signed = await signTemplate(prepared.signing_template, prepared.sign_inputs);
  } catch (err) {
    if (isWalletCanceled(err)) {
      reportCanceled(setState, err);
      return;
    }
    reportError(setState, "sign", err);
    return;
  }
  // A result for an account that no longer owns this flow is discarded.
  if (!stillCurrent(params)) {
    setState({ phase: "idle" });
    return;
  }

  setState({ phase: "broadcasting" });
  try {
    const result = await buyFinalize(params.covenantId, {
      buy_id: prepared.buy_id,
      template: prepared.template,
      signed,
    });
    logStep("finalized", result);
    setState({ phase: "success", txid: result.txid });
  } catch (err) {
    reportError(setState, "finalize", err);
  }
}
