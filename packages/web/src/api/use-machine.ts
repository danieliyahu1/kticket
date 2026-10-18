import { encodeUsePayload } from "@kticket/kit";
import type { WireTransaction } from "./types";
import { usePrepare, type UsePrepareResult } from "./client";
import { signTemplate } from "../lib/signing";
import { devError, devLog } from "../lib/log";
import { notifyCanceled, notifyFailure } from "../lib/notify";
import { isWalletCanceled } from "../wallet/cancel";

export type CheckInState =
  | { phase: "idle" }
  | { phase: "preparing" }
  | { phase: "signing" }
  | { phase: "ready"; qr: string };

export interface CheckInParams {
  ticketId: string;
  publicKey: string;
  address: string;
}

/** The pending pre-sign payload kept after signing (KTK-118, Option B). */
export interface PendingUse {
  use_id: string;
  template: WireTransaction;
  owner_signed: unknown;
}

function logError(context: string, err: unknown): void {
  devError(`[check-in:${context}]`, err);
}

function logStep(step: string, detail?: unknown): void {
  devLog(`[check-in:${step}]`, detail ?? "");
}

/**
 * Step 1 — prepare (KTK-123): the backend verifies the ticket is owned and
 * builds the mark_used template. On success the caller shows the wallet dialog
 * (FR-24); only an approval proceeds to `signCheckIn`. A failure is one toast
 * and the page returns to idle — no QR is produced and no inline error repeats
 * the message.
 */
export async function prepareCheckIn(
  setState: (s: CheckInState) => void,
  params: CheckInParams,
): Promise<UsePrepareResult | undefined> {
  setState({ phase: "preparing" });
  try {
    const prepared = await usePrepare(params.ticketId, {
      publicKey: params.publicKey,
      address: params.address,
    });
    logStep("prepared", {
      useId: prepared.use_id,
      event: prepared.event.name,
      signInputs: prepared.sign_inputs_owner,
    });
    return prepared;
  } catch (err) {
    logError("prepare", err);
    setState({ phase: "idle" });
    notifyFailure(err, "Couldn't prepare the check-in. Try again.");
    return undefined;
  }
}

/**
 * Step 2 — sign + encode: the owner approves, the wallet pre-signs the template
 * offline, and the compressed `{use_id, template, owner_signed}` payload becomes
 * a scan-ready QR (Option B, FR-4). Nothing is spent.
 */
export async function signCheckIn(
  setState: (s: CheckInState) => void,
  prepared: UsePrepareResult,
  options: { isCurrent?: () => boolean } = {},
): Promise<PendingUse | undefined> {
  setState({ phase: "signing" });
  try {
    const owner_signed = await signTemplate(prepared.signing_template, prepared.sign_inputs_owner);
    // A wallet change mid-flow discards the pre-signature; nothing is spent.
    if (options.isCurrent && !options.isCurrent()) return undefined;
    const pending: PendingUse = {
      use_id: prepared.use_id,
      template: prepared.template,
      owner_signed,
    };
    const qr = await encodeUsePayload(pending);
    logStep("encoded", { bytes: qr.length });
    setState({ phase: "ready", qr });
    return pending;
  } catch (err) {
    if (isWalletCanceled(err)) {
      setState({ phase: "idle" });
      notifyCanceled(err);
      return undefined;
    }
    logError("sign", err);
    setState({ phase: "idle" });
    notifyFailure(err, "Couldn't finish the check-in. Try again.");
    return undefined;
  }
}
