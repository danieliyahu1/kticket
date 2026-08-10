import {
  fetchEvent,
  transferFinalize,
  transferPrepare,
  type TicketEntry,
  type TransferPrepareResult,
} from "./client";
import { signTemplate } from "../lib/signing";

export type TransferState =
  | { phase: "idle" }
  | { phase: "confirm"; ticket: TicketEntry }
  | { phase: "building" }
  | { phase: "broadcasting" }
  | { phase: "success" }
  | { phase: "error"; message: string };

export interface TransferParams {
  ticket: TicketEntry;
  publicKey: string;
  address: string;
}

function errorMsg(err: unknown): string {
  if (!(err instanceof Error)) return "Transfer failed.";
  const msg = err.message;
  if (msg === "No connection") return "No connection - transfer can't complete.";
  if (msg.includes("funds") || msg.includes("fee")) return "Not enough funds - transfer didn't go through.";
  return "Transfer failed.";
}

function logError(context: string, err: unknown): void {
  console.error(`[transfer:${context}]`, err);
}

function logStep(step: string, detail?: unknown): void {
  console.log(`[transfer:${step}]`, detail ?? "");
}

/**
 * The transfer flow is owned by the backend (`POST /v1/tickets/{ticketId}/transfer`):
 *   prepare  → backend resolves the event + fetches the holder's UTXOs + builds
 *              the unsigned template
 *   wallet   → signs the inputs the backend listed
 *   finalize → backend merges the signature, broadcasts, and waits for
 *              confirmation
 *
 * The frontend only relays. It never fetches UTXOs, merges signatures, or
 * broadcasts. "Success" is set only after the backend confirms the tx.
 */
export async function executeTransfer(
  setState: (s: TransferState) => void,
  params: TransferParams,
): Promise<void> {
  setState({ phase: "building" });

  const ticketId = params.ticket.ticket_id;

  let prepared: TransferPrepareResult;
  try {
    const event = await fetchEvent(params.ticket.covenant_id);
    prepared = await transferPrepare(ticketId, {
      phase: "prepare",
      covenant_id: params.ticket.covenant_id,
      ticket_id: ticketId,
      publicKey: params.publicKey,
      address: params.address,
    });
    logStep("prepared", { event: event.event.name, signInputs: prepared.sign_inputs });
  } catch (err) {
    logError("prepare", err);
    setState({ phase: "error", message: errorMsg(err) });
    return;
  }

  setState({ phase: "broadcasting" });

  try {
    const signed = await signTemplate(prepared.signing_template, prepared.sign_inputs);
    const result = await transferFinalize(ticketId, {
      phase: "finalize",
      template: prepared.template,
      signed,
    });
    logStep("finalized", result);
    setState({ phase: "success" });
  } catch (err) {
    logError("finalize", err);
    setState({ phase: "error", message: errorMsg(err) });
  }
}
