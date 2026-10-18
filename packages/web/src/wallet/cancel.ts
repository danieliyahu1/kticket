// A wallet action the user canceled — closing the popup, rejecting a signature,
// or dismissing a network switch. It is never an error: flows return to idle,
// and nothing is retried automatically.

export class WalletCanceledError extends Error {
  constructor(message = "Canceled in your wallet.") {
    super(message);
    this.name = "WalletCanceledError";
  }
}

export function isWalletCanceled(err: unknown): err is WalletCanceledError {
  return err instanceof WalletCanceledError;
}
