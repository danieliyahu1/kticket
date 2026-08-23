// KCC20-fork covenant types (HLD v0.22 §2.1).
//
// The on-chain model follows forge's KCC20: state is
// `(ownerIdentifier, identifierType, amount, isMinter)`. For kticket:
//
//   - The event covenant starts with `amount = capacity` (remaining tickets)
//     and `isMinter = false` (fixed supply). `mint` (buy) splits off one
//     ticket covenant (`amount = 1`) and decrements the event covenant.
//   - A ticket covenant is `amount = 1`, owned by the buyer's identifier.
//   - `mark_used` checks the ticket in at the door (owner + organizer
//     co-signature); the ticket stays with its owner, resale ends.
//   - Resale moves a ticket via the market only: list / purchase / delist —
//     there is no direct re-bind entrypoint (v3).
//   - `use` (handover) spends a ticket into the event's burn-owner covenant —
//     an unspendable identifier, so the ticket (dust included) is consumed.
//
// Price (+ event meta) lives in the covenant constants, not the state, so both
// sides always see it; kticket does not covenant-enforce the payment amount.

export type IdentifierType = 0 | 1 | 2;

export interface Kcc20State {
  /** 32-byte owner identifier (pubkey / script hash / covenant id). */
  owner: Uint8Array;
  identifierType: IdentifierType;
  /** Token balance: remaining tickets on the event covenant, 1 on a ticket. */
  amount: number;
  isMinter: boolean;
}

export interface Kcc20Constants {
  authorizingTxId: Uint8Array;
  /** Price per ticket in sompi (0 = free). */
  price: number;
  orgSpk: Uint8Array;
  /** Script hash of the event's burn-owner covenant template. */
  burnTemplateHash: Uint8Array;
}

export type TicketEntrypoint = "mint" | "use";

export interface CovenantContext {
  /** Number of covenant (authorized) outputs in the transaction. */
  authOutputCount: number;
  /** Whether the organizer signed the event covenant spend (mint). */
  organizerSigned: boolean;
  /** Whether the holder signed the ticket spend (mark_used / list / delist). */
  holderSigned: boolean;
  /** Whether the handover successor is the event's burn-owner covenant. */
  successorIsBurn: boolean;
  /** Whether the buy transaction carries the org payout output (price > 0). */
  hasOrgPayout: boolean;
}

export interface TransitionResult {
  ok: boolean;
  code: ResultCode;
  reason?: string;
  state?: Kcc20State;
}

export const RESULT_CODES = {
  OK: 0,
  ERR_AMOUNT: 1,
  ERR_AUTH_OUTPUT: 2,
  ERR_SIG: 3,
  ERR_BURN_TEMPLATE: 4,
  ERR_FUNCTION: 5,
  ERR_UNSPENDABLE: 6,
} as const;

export type ResultCode = (typeof RESULT_CODES)[keyof typeof RESULT_CODES];
