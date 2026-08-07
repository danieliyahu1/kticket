export type TicketPhase = 0 | 1 | 2;

export interface TicketState {
  phase: TicketPhase;
  owner: Uint8Array;
}

export type TicketEntrypoint = "buy" | "transfer" | "use";

export interface CovenantContext {
  authOutputCount: number;
  hasOrgPayout: boolean;
  holderSigned: boolean;
  successorIsBurn: boolean;
}

export interface TicketConstants {
  eventId: Uint8Array;
  index: number;
  price: number;
  orgSpk: Uint8Array;
  burnTemplateHash: Uint8Array;
}

export const RESULT_CODES = {
  OK: 0,
  ERR_PHASE: 1,
  ERR_AUTH_OUTPUT: 2,
  ERR_PAYOUT: 3,
  ERR_SIG: 4,
  ERR_BURN_TEMPLATE: 5,
  ERR_FUNCTION: 6,
  ERR_UNSPENDABLE: 7,
} as const;

export type ResultCode = (typeof RESULT_CODES)[keyof typeof RESULT_CODES];

export interface TransitionResult {
  ok: boolean;
  code: ResultCode;
  reason?: string;
  state?: TicketState;
}
