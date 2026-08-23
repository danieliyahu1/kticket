import { encodeUsePayload } from "@kticket/kit";
import type { WireTransaction } from "./types";
import { ServerError, usePrepare, type UsePrepareResult } from "./client";
import { signTemplate } from "../lib/signing";
import { devError, devLog } from "../lib/log";

export type CheckInState =
  | { phase: "idle" }
  | { phase: "preparing" }
  | { phase: "signing" }
  | { phase: "ready"; qr: string }
  | { phase: "error"; message: string };

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

function errorMsg(err: unknown): string {
  if (!(err instanceof Error)) return "Handover can't complete.";
  if (err instanceof ServerError) return "No connection — handover can't complete.";
  return err.message;
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
 * (FR-24); only an approval proceeds to `signCheckIn`. A failure surfaces the
 * owner error ("No ticket" / no-connection) — no QR is produced.
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
    setState({ phase: "error", message: errorMsg(err) });
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
): Promise<PendingUse | undefined> {
  setState({ phase: "signing" });
  try {
    const owner_signed = await signTemplate(prepared.signing_template, [{ inputIndex: 0 }]);
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
    logError("sign", err);
    setState({ phase: "error", message: errorMsg(err) });
    return undefined;
  }
}
