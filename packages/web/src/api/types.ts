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

export interface DeployPrepareRequest {
  capacity: number;
  /** Ticket price in KAS (the backend converts KAS → sompi). */
  price_kas: number;
  /** Compressed (66-hex) or bare x-coordinate (64-hex) organizer public key. */
  publicKey: string;
  /** The organizer's bech32 address — the backend fetches its UTXOs itself. */
  address: string;
  name?: string;
  date?: string;
  /** Local wall-clock start time (HH:MM). */
  time?: string;
}

export interface DeployPrepareResult {
  /** Correlation id echoed back on finalize so the backend can spot abandoned prepares. */
  deploy_id: string;
  signing_template: string;
  event_covenant_id?: string;
  /** The unsigned template the wallet signed — relayed back in finalize. */
  template: WireTransaction;
}
