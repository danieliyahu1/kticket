export interface KastleAccount {
  address: string;
  publicKey?: string;
}

/** Per-input override for covenant / P2SH spends passed to `signTx`. */
export interface KastleSignScript {
  inputIndex: number;
  scriptHex?: string;
  signType?: string;
}

/**
 * The subset of the Kastle browser-extension API (`window.kastle`) kticket
 * uses. Reference: https://docs.kastle.cc/readme/how-to-integrate/kastle-wallet-api
 */
export interface KastleProvider {
  connect: () => Promise<boolean>;
  getAccount: () => Promise<KastleAccount>;
  getNetwork: () => Promise<string>;
  switchNetwork: (networkId: string) => Promise<unknown>;
  /** Signs without broadcasting; returns the signed tx as kaspa-wasm safe-JSON. */
  signTx: (
    networkId: string | undefined,
    txJson: string,
    scripts?: KastleSignScript[],
  ) => Promise<string | { txJson?: string; signedTx?: string; tx?: string }>;
  /** Signs a plain message (Schnorr) — used for the wallet-identity claim. */
  signMessage: (message: string) => Promise<string>;
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
    kastle?: KastleProvider;
  }
}
