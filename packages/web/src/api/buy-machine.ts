import { buyFinalize, buyPrepare, fetchEvent, type EventDetail } from "./client";
import type { BuyPrepareResult } from "./client";
import { signTemplate } from "../lib/signing";

export type BuyState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; event: EventDetail }
  | { phase: "building" }
  | { phase: "broadcasting" }
  | { phase: "success"; txid: string }
  | { phase: "error"; message: string };

export interface BuyParams {
  covenantId: string;
  publicKey: string;
  address: string;
}

function errorMsg(err: unknown): string {
  if (!(err instanceof Error)) return "Purchase failed.";
  if (err.message === "No connection") return "No connection - purchase can't complete.";
  // The backend owns the message; the frontend relays it.
  return err.message;
}

function logError(context: string, err: unknown): void {
  console.error(`[buy:${context}]`, err);
}

function logStep(step: string, detail?: unknown): void {
  console.log(`[buy:${step}]`, detail ?? "");
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
 * broadcasts. "Success" is set only after the backend confirms the tx.
 */
export async function executeBuy(
  setState: (s: BuyState) => void,
  params: BuyParams,
): Promise<void> {
  setState({ phase: "loading" });

  let event: EventDetail;
  try {
    event = await fetchEvent(params.covenantId);
    logStep("event", event);
  } catch (err) {
    logError("fetch", err);
    setState({ phase: "error", message: errorMsg(err) });
    return;
  }

  if (event.availability.left === 0) {
    setState({ phase: "error", message: "Sold out - no tickets left." });
    return;
  }

  setState({ phase: "ready", event });
  setState({ phase: "building" });

  let prepared: BuyPrepareResult;
  try {
    prepared = await buyPrepare(params.covenantId, {
      publicKey: params.publicKey,
      address: params.address,
    });
    logStep("prepared", { buyId: prepared.buy_id, price: prepared.price, signInputs: prepared.sign_inputs });
  } catch (err) {
    logError("prepare", err);
    setState({ phase: "error", message: errorMsg(err) });
    return;
  }

  setState({ phase: "broadcasting" });

  try {
    const signed = await signTemplate(prepared.signing_template, prepared.sign_inputs);
    const result = await buyFinalize(params.covenantId, {
      buy_id: prepared.buy_id,
      template: prepared.template,
      signed,
    });
    logStep("finalized", result);
    setState({ phase: "success", txid: result.txid });
  } catch (err) {
    logError("finalize", err);
    setState({ phase: "error", message: errorMsg(err) });
  }
}
