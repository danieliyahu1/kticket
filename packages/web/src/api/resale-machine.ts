import {
  delistFinalize,
  delistPrepare,
  listFinalize,
  listPrepare,
  purchaseFinalize,
  purchasePrepare,
  ServerError,
} from "./client";
import { signTemplate } from "../lib/signing";
import { devError } from "../lib/log";

/** One shared lifecycle for every resale flow: sell / cancel sale / buy resale. */
export type ResaleState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "building" }
  | { phase: "broadcasting" }
  | { phase: "success"; txid: string }
  | { phase: "error"; message: string };

export interface HolderParams {
  ticketId: string;
  publicKey: string;
  address: string;
}

function errorMsg(err: unknown): string {
  if (!(err instanceof Error)) return "The resale flow failed.";
  if (err instanceof ServerError) return "The server isn't responding — try again later.";
  // The backend owns the message; the frontend relays it.
  return err.message;
}

function logError(context: string, err: unknown): void {
  devError(`[resale:${context}]`, err);
}

/**
 * Sell a ticket: prepare → wallet signs → finalize. The backend proves the
 * caller owns an unlisted ticket and builds the template; the wallet only
 * signs; the backend merges, broadcasts, confirms, and indexes the listing.
 */
export async function executeList(
  setState: (s: ResaleState) => void,
  params: HolderParams & { priceSompi: number },
): Promise<void> {
  setState({ phase: "loading" });

  let prepared;
  try {
    prepared = await listPrepare(params.ticketId, {
      publicKey: params.publicKey,
      address: params.address,
      price: params.priceSompi,
    });
  } catch (err) {
    logError("list/prepare", err);
    setState({ phase: "error", message: errorMsg(err) });
    return;
  }

  try {
    setState({ phase: "building" });
    const signed = await signTemplate(prepared.signing_template);
    setState({ phase: "broadcasting" });
    const result = await listFinalize(params.ticketId, {
      template: prepared.template,
      signed,
      price: prepared.price,
    });
    setState({ phase: "success", txid: result.txid });
  } catch (err) {
    logError("list/finalize", err);
    setState({ phase: "error", message: errorMsg(err) });
  }
}

/** Cancel a sale: the ticket returns to the plain unlisted address. */
export async function executeDelist(
  setState: (s: ResaleState) => void,
  params: HolderParams,
): Promise<void> {
  setState({ phase: "loading" });

  let prepared;
  try {
    prepared = await delistPrepare(params.ticketId, {
      publicKey: params.publicKey,
      address: params.address,
    });
  } catch (err) {
    logError("delist/prepare", err);
    setState({ phase: "error", message: errorMsg(err) });
    return;
  }

  try {
    setState({ phase: "building" });
    const signed = await signTemplate(prepared.signing_template);
    setState({ phase: "broadcasting" });
    const result = await delistFinalize(params.ticketId, {
      template: prepared.template,
      signed,
    });
    setState({ phase: "success", txid: result.txid });
  } catch (err) {
    logError("delist/finalize", err);
    setState({ phase: "error", message: errorMsg(err) });
  }
}

/**
 * Buy a listed ticket trustlessly: input 0 is signatureless covenant escrow —
 * only the buyer's fee inputs are signed. The contract pays the seller exactly
 * the asking price; nobody has to be online or trusted.
 */
export async function executePurchase(
  setState: (s: ResaleState) => void,
  params: HolderParams,
): Promise<void> {
  setState({ phase: "loading" });

  let prepared;
  try {
    prepared = await purchasePrepare(params.ticketId, {
      publicKey: params.publicKey,
      address: params.address,
    });
  } catch (err) {
    logError("purchase/prepare", err);
    setState({ phase: "error", message: errorMsg(err) });
    return;
  }

  try {
    setState({ phase: "building" });
    const signed = await signTemplate(prepared.signing_template);
    setState({ phase: "broadcasting" });
    const result = await purchaseFinalize(params.ticketId, {
      template: prepared.template,
      signed,
    });
    setState({ phase: "success", txid: result.txid });
  } catch (err) {
    logError("purchase/finalize", err);
    setState({ phase: "error", message: errorMsg(err) });
  }
}
