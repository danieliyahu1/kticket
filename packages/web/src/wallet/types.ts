/** Input selection for `signPskt`: which input to sign and with what sighash. */
export interface KaswareSignInput {
  index: number;
  sighashType?: number;
}

export interface KaswareSignPsktRequest {
  /** Unsigned tx in the kaspa-wasm safe-JSON shape `signPskt` signs. */
  txJsonString: string;
  options?: { signInputs: KaswareSignInput[] };
}

export interface KaswareSignMessageOptions {
  /** Signature algorithm; `schnorr` is what the API verifies. */
  type?: "auto" | "schnorr" | "ecdsa";
  /** Disable auxiliary randomness (deterministic Schnorr). */
  noAuxRand?: boolean;
}

/**
 * The subset of the Kasware browser-extension API (`window.kasware`) kticket
 * uses. Reference: https://docs.kasware.xyz/wallet/developer-documentation/kaspa
 */
export interface KaswareProvider {
  requestAccounts: () => Promise<string[]>;
  getAccounts: () => Promise<string[]>;
  getPublicKey: () => Promise<string>;
  /** Current network name, e.g. `kaspa_testnet_10`; `""` when not connected. */
  getNetwork: () => Promise<string>;
  /** Kasware network name (e.g. `kaspa_testnet_10`), not the app's `testnet-10`. */
  switchNetwork: (network: string) => Promise<string>;
  disconnect: (origin: string) => Promise<void>;
  /** Signs a plain message (Schnorr by default). */
  signMessage: (message: string, options?: KaswareSignMessageOptions) => Promise<string>;
  /** Signs without broadcasting; returns the signed tx as kaspa-wasm safe-JSON. */
  signPskt: (
    request: KaswareSignPsktRequest,
  ) => Promise<string | { txJsonString?: string; signedTx?: string; tx?: string }>;
  on: (event: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (event: string, callback: (...args: unknown[]) => void) => void;
}

export type WalletState =
  | { status: "idle" }
  | { status: "not-installed" }
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "connected"; accounts: string[]; publicKey: string; networkMismatch?: boolean }
  | { status: "wrong-network"; accounts: string[]; publicKey: string };

declare global {
  interface Window {
    kasware?: KaswareProvider;
  }
}
