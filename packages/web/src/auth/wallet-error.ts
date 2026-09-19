/**
 * Wallet-side error helpers.
 *
 * Kasware surfaces a user cancel as an Ethereum RPC error (`userRejectedRequest`,
 * code 4001) that the extension serializes into a plain object before it reaches
 * the page — so detection must not rely on `instanceof Error`.
 */

/** EIP-1193 user-rejected-request code; every Kasware approval cancel uses it. */
const USER_REJECTED = 4001;

/** True when the wallet request was rejected by the user (canceled in Kasware). */
export function isUserRejected(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code === USER_REJECTED) return true;
  return typeof message === "string" && /user rejected|user cancel/i.test(message);
}

/** A loggable reason for any thrown value (Error, serialized RPC error, or primitive). */
export function reasonOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return typeof err;
}

/** The numeric RPC code of a thrown value, for logs. */
export function codeOf(err: unknown): number | undefined {
  if (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { code?: unknown }).code === "number"
  ) {
    return (err as { code: number }).code;
  }
  return undefined;
}
