import {
  delistFinalize,
  delistPrepare,
  listFinalize,
  listPrepare,
  purchaseFinalize,
  purchasePrepare,
} from "./client";
import { signTemplate } from "../lib/signing";
import { devError } from "../lib/log";
import { notifyCanceled, notifyFailure } from "../lib/notify";
import { isWalletCanceled } from "../wallet/cancel";

/** One shared lifecycle for every resale flow: sell / cancel sale / buy resale. */
export type ResaleState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "building" }
  | { phase: "broadcasting" }
  | { phase: "success"; txid: string };

export interface HolderParams {
  ticketId: string;
  publicKey: string;
  address: string;
  /** False when the wallet changed after prepare — never finalize a stale flow. */
  isCurrent?: () => boolean;
}

function logError(context: string, err: unknown): void {
  devError(`[resale:${context}]`, err);
}

function reportError(
  setState: (s: ResaleState) => void,
  context: string,
  err: unknown,
  fallback: string,
): void {
  logError(context, err);
  setState({ phase: "idle" });
  notifyFailure(err, fallback);
}

function reportCanceled(setState: (s: ResaleState) => void, err: unknown): void {
  setState({ phase: "idle" });
  notifyCanceled(err);
}

function stillCurrent(params: HolderParams): boolean {
  return params.isCurrent === undefined || params.isCurrent();
}

/**
 * Sign the prepared template. Returns `undefined` when the flow stopped — a
 * canceled wallet prompt returns to idle with one notice, and a wallet that
 * changed underneath discards the result instead of finalizing it
 * (KTK-173 / KTK-175).
 */
async function signPrepared(
  setState: (s: ResaleState) => void,
  params: HolderParams,
  prepared: { signing_template: string; sign_inputs: { index: number }[] },
  logContext: string,
): Promise<unknown | undefined> {
  setState({ phase: "building" });
  try {
    const signed = await signTemplate(prepared.signing_template, prepared.sign_inputs);
    if (!stillCurrent(params)) {
      setState({ phase: "idle" });
      return undefined;
    }
    return signed;
  } catch (err) {
    if (isWalletCanceled(err)) {
      reportCanceled(setState, err);
      return undefined;
    }
    reportError(setState, logContext, err, "That didn't go through. Try again.");
    return undefined;
  }
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
    reportError(setState, "list/prepare", err, "Couldn't list the ticket. Try again.");
    return;
  }
  if (!stillCurrent(params)) {
    setState({ phase: "idle" });
    return;
  }

  const signed = await signPrepared(setState, params, prepared, "list/sign");
  if (signed === undefined) return;

  setState({ phase: "broadcasting" });
  try {
    const result = await listFinalize(params.ticketId, {
      template: prepared.template,
      signed,
      price: prepared.price,
    });
    setState({ phase: "success", txid: result.txid });
  } catch (err) {
    reportError(setState, "list/finalize", err, "Couldn't list the ticket. Try again.");
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
    reportError(setState, "delist/prepare", err, "Couldn't cancel the sale. Try again.");
    return;
  }
  if (!stillCurrent(params)) {
    setState({ phase: "idle" });
    return;
  }

  const signed = await signPrepared(setState, params, prepared, "delist/sign");
  if (signed === undefined) return;

  setState({ phase: "broadcasting" });
  try {
    const result = await delistFinalize(params.ticketId, {
      template: prepared.template,
      signed,
    });
    setState({ phase: "success", txid: result.txid });
  } catch (err) {
    reportError(setState, "delist/finalize", err, "Couldn't cancel the sale. Try again.");
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
    reportError(setState, "purchase/prepare", err, "Couldn't buy the ticket. Try again.");
    return;
  }
  if (!stillCurrent(params)) {
    setState({ phase: "idle" });
    return;
  }

  const signed = await signPrepared(setState, params, prepared, "purchase/sign");
  if (signed === undefined) return;

  setState({ phase: "broadcasting" });
  try {
    const result = await purchaseFinalize(params.ticketId, {
      template: prepared.template,
      signed,
    });
    setState({ phase: "success", txid: result.txid });
  } catch (err) {
    reportError(setState, "purchase/finalize", err, "Couldn't buy the ticket. Try again.");
  }
}
