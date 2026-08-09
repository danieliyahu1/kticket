// Unsigned v1 transaction template types (HLD v0.21 §2.1 "Transactions (v1)").
//
// The kit produces *unsigned* templates; signing and broadcast are handled by
// the wallet (Kasware) and the API. Templates are plain data — the concrete
// kaspa-wasm v1 serialization (`Transaction`, `CovenantBinding`,
// `populateGenesisCovenants`) is applied at the network boundary (see the
// spike decision note).

export const TX_VERSION_V1 = 1;

export interface SerializedOutpoint {
  /** Transaction id as a hex string. */
  txId: string;
  index: number;
}

export interface ScriptPublicKey {
  /** Script version (0 for kticket covenant outputs). */
  version: number;
  /** Raw script bytes (the P2SH script, hex). */
  script: string;
}

export interface CovenantBinding {
  authorizingInput: number;
  covenantId: string;
}

export interface TxInput {
  previousOutpoint: SerializedOutpoint;
  /** Empty for the covenant input before signing; wallet fills it. */
  signatureScript: string;
  sequence: number;
  sigOpCount: number;
}

export interface TxOutput {
  value: number;
  scriptPublicKey: ScriptPublicKey;
  covenant: CovenantBinding | null;
}

export interface UnsignedTransaction {
  version: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  lockTime: number;
  /** Hex-encoded payload (KCC-0021: covenant metadata in genesis tx payload). */
  payload?: string;
}

/** Which party pays the fee, per transaction type (HLD §2.1). */
export const FEE_PAYER = {
  genesis: "organizer",
  buy: "buyer",
  transfer: "holder",
  handover: "attendee",
} as const;
