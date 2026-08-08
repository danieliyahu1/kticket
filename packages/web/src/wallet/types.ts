export interface KaswareProvider {
  requestAccounts: () => Promise<string[]>;
  getAccounts: () => Promise<string[]>;
  getPublicKey: () => Promise<string>;
  getBalance: () => Promise<KaswareBalance>;
  getUtxoEntries: (address?: string) => Promise<KaswareUtxoEntry[]>;
  signMessage: (message: string, type?: "ecdsa" | "schnorr") => Promise<SignedMessage>;
  signPskt: (
    request: KaswareSignPsktRequest,
  ) => Promise<string | { txJsonString?: string; signedTx?: string; tx?: string }>;
  sendKaspa: (
    to: string,
    amount: number,
    options?: { priorityFee?: number },
  ) => Promise<{ id: string }>;
  isConnected: () => Promise<boolean>;
  on: (event: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (event: string, callback: (...args: unknown[]) => void) => void;
}

export interface KaswareSignPsktRequest {
  txJsonString: string;
  options?: { signInputs?: { index: number; sighashType?: number }[] };
}

export interface KaswareAddress {
  prefix: string;
  payload: string;
  version: string;
}

export interface KaswareUtxoEntry {
  amount: number;
  scriptPublicKey: { version: number; script: string };
  blockDaaScore: number;
  isCoinbase: boolean;
  address?: KaswareAddress;
  outpoint: { transactionId: string; index: number };
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
