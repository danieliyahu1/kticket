import { isPaidTicketPrice, MIN_TICKET_PRICE_KAS } from "@kticket/kit";
import type { VerifiedEvent } from "./provenance.js";

/** The product rule: every event sold through the app has a paid ticket. */
export function isPaidEvent(event: Pick<VerifiedEvent, "price">): boolean {
  return isPaidTicketPrice(event.price);
}

export const UNPAID_EVENT_MESSAGE =
  `only paid events are supported (minimum ${MIN_TICKET_PRICE_KAS} KAS per ticket)`;
