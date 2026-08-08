export interface WireOutpoint {
  transaction_id: string;
  index: number;
}

export interface WireUtxo extends WireOutpoint {
  value: number;
}

export interface WireUtxoMeta extends WireUtxo {
  script_public_key: WireScriptPublicKey;
  block_daa_score: number;
  is_coinbase: boolean;
  address?: string;
}

export interface WireScriptPublicKey {
  version: number;
  script: string;
}

export interface WireCovenant {
  authorizing_input: number;
  covenant_id: string;
}

export interface WireInput {
  previous_outpoint: WireOutpoint;
  signature_script: string;
  sequence: number;
  sig_op_count: number;
}

export interface WireOutput {
  value: number;
  script_public_key: WireScriptPublicKey;
  covenant: WireCovenant | null;
}

export interface WireTransaction {
  version: number;
  inputs: WireInput[];
  outputs: WireOutput[];
  lock_time: number;
}

export interface BuildResult {
  template: WireTransaction;
  /** Unsigned tx in the kaspa-wasm safe-JSON shape Kasware's `signPskt` signs. */
  signing_template?: string;
  event_covenant_id?: string;
}

export interface BroadcastResult {
  txid: string;
}
