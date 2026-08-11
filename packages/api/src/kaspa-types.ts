// Typed models for the Kaspa public REST API (api-tn10.kaspa.org, kaspa-rest-server
// v2.3.0 — HLD v0.23 §1). Only the shapes the availability walk uses are
// modelled; amounts come back as strings from `/utxos` and integers from
// `/full-transactions`, matching the upstream spec.

export interface UtxoEntry {
  amount: string;
  scriptPublicKey: { scriptPublicKey: string };
  blockDaaScore: string;
  isCoinbase: boolean;
}

export interface UtxoResponse {
  address?: string;
  outpoint: { transactionId: string; index: number };
  utxoEntry: UtxoEntry;
}

export interface TxInput {
  transaction_id: string;
  index: number;
  previous_outpoint_hash: string;
  previous_outpoint_index: string;
  signature_script: string;
  sig_op_count?: string;
  covenant_id?: string | null;
  previous_outpoint_resolved?: TxOutput;
  previous_outpoint_address?: string;
  previous_outpoint_amount?: number;
}

export interface TxOutput {
  transaction_id: string;
  index: number;
  amount: number;
  script_public_key?: string;
  script_public_key_address?: string;
  covenant_authorizing_input?: number | null;
  covenant_id?: string | null;
}

export interface TxModel {
  subnetwork_id?: string;
  transaction_id: string;
  hash?: string;
  mass?: string;
  block_time?: number;
  version?: number;
  is_accepted?: boolean;
  accepting_block_blue_score?: number;
  accepting_block_time?: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  /** Hex-encoded payload (KCC-0021 metadata for deploy txs). */
  payload?: string;
}

// --- tx build / broadcast models (HLD §2.2 — POST /v1/tx/build, /v1/tx/broadcast) ---

export interface SubmitTxOutpoint {
  transactionId: string;
  index: number;
}

export interface SubmitTxInput {
  previousOutpoint: SubmitTxOutpoint;
  signatureScript: string;
  sequence: number;
  sigOpCount: number;
}

export interface SubmitTxScriptPublicKey {
  version: number;
  scriptPublicKey: string;
}

export interface SubmitTxOutput {
  amount: number;
  scriptPublicKey: SubmitTxScriptPublicKey;
}

/** The upstream `SubmitTxModel` — what `/transactions/mass` and `/transactions` accept. */
export interface SubmitTxModel {
  version: number;
  inputs: SubmitTxInput[];
  outputs: SubmitTxOutput[];
  lockTime: number;
  subnetworkId?: string;
}

export interface SubmitTransactionResponse {
  transactionId?: string;
  error?: string;
}

/** Response of `GET /info/fee-estimate`. */
export interface FeeEstimateBucket {
  feerate: number;
  estimatedSeconds: number;
}

export interface FeeEstimateResponse {
  priorityBucket: FeeEstimateBucket;
  normalBuckets: FeeEstimateBucket[];
  lowBuckets: FeeEstimateBucket[];
}

/** Response of `POST /transactions/mass`. */
export interface TxMass {
  mass: number;
  storage_mass: number;
  compute_mass: number;
}
