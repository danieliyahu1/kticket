export interface KaswareProvider {
  requestAccounts: () => Promise<string[]>;
  getAccounts: () => Promise<string[]>;
  getPublicKey: () => Promise<string>;
  getBalance: () => Promise<KaswareBalance>;
  signMessage: (message: string, type?: "ecdsa" | "schnorr") => Promise<SignedMessage>;
  sendKaspa: (
    to: string,
    amount: number,
    options?: { priorityFee?: number },
  ) => Promise<{ id: string }>;
  isConnected: () => Promise<boolean>;
  on: (event: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (event: string, callback: (...args: unknown[]) => void) => void;
}

export interface KaswareBalance {
  confirmed: number;
  unconfirmed: number;
  total: number;
}

export interface SignedMessage {
  message: string;
  publicKey: string;
  signature: string;
}

export type WalletState =
  | { status: "idle" }
  | { status: "not-installed" }
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "connected"; accounts: string[]; publicKey: string };

declare global {
  interface Window {
    kasware?: KaswareProvider;
  }
}
