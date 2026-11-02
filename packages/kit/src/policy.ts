import { SOMPI_PER_KAS } from "./runtime/fee.js";

/** Smallest accepted ticket price, in KAS. No ticket is free. */
export const MIN_TICKET_PRICE_KAS = 1;

/** The same floor in sompi — the unit the event covenant stores. */
export const MIN_TICKET_PRICE_SOMPI = MIN_TICKET_PRICE_KAS * SOMPI_PER_KAS;

/** True when `priceSompi` is a paid ticket price (at least the product floor). */
export function isPaidTicketPrice(priceSompi: number): boolean {
  return Number.isFinite(priceSompi) && priceSompi >= MIN_TICKET_PRICE_SOMPI;
}
