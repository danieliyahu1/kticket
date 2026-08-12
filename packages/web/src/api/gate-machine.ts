// Gate scan state machine (KTK-130/131/132, parent KTK-119) — the organizer's
// device at the door. It owns the whole scan → co-sign → verdict loop:
//
//   scanning  — camera loop decodes payload QRs (jsQR + getUserMedia)
//   waiting   — sign-template rebuild + the "Authorize entry?" dialog
//   co-signing— the organizer's wallet signs the ticket input (index 0)
//   green     — DAG-confirmed mark_used: "You're in."
//   red       — rejected / unparseable / no-connection: the node's message verbatim
//
// The gate never holds authority over the ticket: it relays the owner's
// pre-signed template, re-derives the signing template, co-signs input 0 with
// the organizer wallet, and broadcasts via finalize. The green light is only
// ever the DAG-confirmed mark_used verdict.

import { decodeUsePayload, type UsePayload } from "@kticket/kit";
import { ServerError, useSignTemplate } from "./client";
import type { WireTransaction } from "./types";

export type GateState =
  | { phase: "scanning" }
  | { phase: "waiting"; ticket: string; event: string; payload: UsePayload }
  | { phase: "co-signing"; ticket: string; event: string; payload: UsePayload }
  | { phase: "green"; txid: string }
  | { phase: "red"; message: string };

export interface GateParams {
  /** The event this gate is bound to (the /gate/:covenantId). */
  covenantId: string;
  /** The event's display name for the "Authorize entry for [event]?" dialog. */
  eventName: string;
}

/** Map a decode failure to the door's red copy (FR-23). */
export function decodeError(): string {
  return "Not a valid ticket code.";
}

/** A codec failure (garbage payload), as opposed to a server outage. */
export function isDecodeFailure(err: unknown): boolean {
  return !(err instanceof ServerError);
}

/**
 * Map any gate failure to the door's red copy. Unparseable payloads, foreign
 * tickets and server outages each get the operator-facing message; a server
 * outage (5xx) is "No connection…" (FR-23 / SC-9).
 */
function errorMsg(err: unknown): string {
  if (!(err instanceof Error)) return "Handover can't complete.";
  if (err instanceof ServerError) return "No connection — handover can't complete.";
  return err.message;
}

function logError(context: string, err: unknown): void {
  console.error(`[gate:${context}]`, err);
}

function logStep(step: string, detail?: unknown): void {
  console.log(`[gate:${step}]`, detail ?? "");
}

/**
 * The ticket identity from the template: input 0 is the covenant spend being
 * marked used, so its prev outpoint is the ticket id (`<txid>:<index>`).
 */
function ticketIdOf(template: WireTransaction): string {
  const input = template.inputs[0]?.previous_outpoint;
  if (!input) throw new Error("template has no ticket input");
  return `${input.transaction_id}:${input.index}`;
}

/**
 * Decode a scanned QR payload. The raw camera string is the compressed
 * base64url payload; decode throws on garbage → red "Not a valid ticket code."
 */
export async function decodeGatePayload(raw: string): Promise<UsePayload> {
  return decodeUsePayload(raw);
}

/**
 * Step 1 — rebuild the signing template (KTK-128/130). The gate POSTs the
 * owner's template; the backend re-fetches each input's chain facts and returns
 * the byte-exact safe-JSON the gate's wallet co-signs. A failure here surfaces
 * as red "No connection…" (the API maps upstream outages to a 5xx).
 */
export async function prepareGateCheck(
  payload: UsePayload,
  params: GateParams,
): Promise<{ ticket: string; event: string }> {
  const ticket = ticketIdOf(payload.template as WireTransaction);
  await useSignTemplate(ticket, payload.template as WireTransaction);
  return { ticket, event: params.eventName };
}

export { errorMsg, logError, logStep };
