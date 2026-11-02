import { SOMPI_PER_KAS } from "./runtime/fee.js";

/** Smallest accepted ticket price, in KAS. No ticket is free. */
export const MIN_TICKET_PRICE_KAS = 1;

/** The same floor in sompi — the unit the event covenant stores. */
export const MIN_TICKET_PRICE_SOMPI = MIN_TICKET_PRICE_KAS * SOMPI_PER_KAS;

/** True when `priceSompi` is a paid ticket price (at least the product floor). */
export function isPaidTicketPrice(priceSompi: number): boolean {
  return Number.isFinite(priceSompi) && priceSompi >= MIN_TICKET_PRICE_SOMPI;
}

/**
 * The most the network may take out of a ticket price, per input (sompi).
 * Mirrors `MAX_FEE_PER_INPUT` in `contracts/event.sil`: the fee scales with the
 * committed compute budget, which is per input, so the covenant's allowance is
 * per input too.
 */
export const MAX_FEE_PER_INPUT_SOMPI = 15_000_000;

/**
 * `MAX_ITEMS` in `contracts/event.sil` bounds the covenant's input/output scan.
 * The covenant (or ticket) spends input 0, so at most this many buyer UTXOs may
 * join a buy or purchase.
 */
export const MAX_BUY_UTXOS = 7;

/** The covenant's per-input fee ceiling for a transaction with `inputs` inputs. */
export function maxFeeForInputs(inputs: number): number {
  return MAX_FEE_PER_INPUT_SOMPI * Math.max(1, inputs);
}
