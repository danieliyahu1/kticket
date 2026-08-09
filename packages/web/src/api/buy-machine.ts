import { broadcastTx, buildBuyTx, fetchEvent, type EventDetail } from "./client";
import { organizerPkh } from "./crypto";
import {
  changeScriptFromPublicKey,
  fetchUtxos,
  toWireUtxo,
  toWireUtxoMeta,
} from "./kaspa";
import type { BuildResult } from "./types";
import { mergeSignatures, signTemplate } from "../lib/signing";
const LOG_SAMPLE_LEN = 400;

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
  const msg = err.message;
  if (msg === "No connection") return "No connection - purchase can't complete.";
  if (msg.includes("funds") || msg.includes("fee")) return "Not enough funds - purchase didn't go through.";
  if (msg.includes("Sold out") || msg.includes("sold out")) return "Sold out - no tickets left.";
  return "Purchase failed.";
}

function logError(context: string, err: unknown): void {
  console.error(`[buy:${context}]`, err);
}

function logStep(step: string, detail?: unknown): void {
  console.log(`[buy:${step}]`, detail ?? "");
}

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

  const buyInfo = event.buy_info;

  let utxos;
  try {
    utxos = await fetchUtxos(params.address);
    logStep("utxos", { count: utxos.length, first: utxos[0] });
  } catch (err) {
    logError("utxos", err);
    setState({ phase: "error", message: "No connection - purchase can't complete." });
    return;
  }

  if (utxos.length === 0) {
    setState({ phase: "error", message: "Not enough funds - purchase didn't go through." });
    return;
  }

  const buyerPkh = organizerPkh(params.publicKey);

  let buildResult: BuildResult;
  try {
    buildResult = await buildBuyTx({
      event_outpoint: {
        transaction_id: buyInfo.event_txid,
        index: buyInfo.event_index,
      },
      event_covenant_id: buyInfo.event_covenant_id,
      event_owner: buyInfo.event_owner,
      remaining: buyInfo.remaining,
      authorizingTxId: event.buy_info.authorizing_txid,
      price: event.event.price,
      orgSpk: buyInfo.org_spk,
      burnTemplateHash: buyInfo.burn_template_hash,
      buyer: buyerPkh,
      buyerUtxos: utxos.map(toWireUtxo),
      changeSpk: changeScriptFromPublicKey(params.publicKey),
      inputUtxoMetas: utxos.map(toWireUtxoMeta),
    });
    logStep("built", {
      signingTemplate: buildResult.signing_template?.slice(0, LOG_SAMPLE_LEN),
    });
  } catch (err) {
    logError("build", err);
    setState({ phase: "error", message: errorMsg(err) });
    return;
  }

  setState({ phase: "broadcasting" });

  let signedTx;
  try {
    const signed = await signTemplate(buildResult.signing_template);
    logStep("signed", {
      type: typeof signed,
      sample: JSON.stringify(signed).slice(0, LOG_SAMPLE_LEN),
    });
    signedTx = mergeSignatures(buildResult.template, signed);
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


