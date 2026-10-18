// One human sentence for every failure (KTK-169).
//
// API envelopes, transport failures, wallet rejections, and unknown throws all
// pass through here so the same failure reads the same way everywhere. Server
// copy is only relayed when it is already user-facing; stack traces, URLs, and
// protocol vocabulary fall back to the call site's sentence.

import { isUserRejected } from "../auth/wallet-error";
import { isWalletCanceled } from "../wallet/cancel";

export const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";
export const SESSION_EXPIRED_MESSAGE = "Your session expired. Sign in to continue.";
export const WALLET_CANCELED_MESSAGE = "Canceled in your wallet.";
export const WALLET_REJECTED_MESSAGE = "Canceled in Kasware.";
export const MISSING_WALLET_MESSAGE = "Kasware isn't available in this browser.";

export interface PresentErrorOptions {
  /** The sentence to use when the failure cannot be explained to the user. */
  fallback?: string;
}

/** Messages longer than this are reports, not sentences. */
const MAX_MESSAGE_LENGTH = 180;

// Protocol vocabulary that means the message came from a validation layer, not
// from the product's voice. It must never reach the UI.
const TECHNICAL_MESSAGE =
  /(https?:\/\/|\bat\s+[\w.$]+\s*\(|\bstack\b|\btrace\b|\bundefined\b|\bNaN\b|\bJSON\b|\bhex\b|request body|\bmust be\b|\bmust have\b|did not sign|could not build|not a valid transaction|template (?:has|is) no|output (?:has|is) no|input (?:has|is) no|API error \d+)/i;

/** Log codes such as ECONNRESET are reports, not sentences. */
const TECHNICAL_TOKEN = /\b[A-Z][A-Z0-9_]{2,}\b/;

interface ErrorEnvelopeLike {
  error?: {
    type?: unknown;
    message?: unknown;
  };
}

function fallbackFrom(value: string | PresentErrorOptions | undefined): string {
  if (typeof value === "string") return value;
  return value?.fallback ?? GENERIC_ERROR_MESSAGE;
}

/** A server sentence we may repeat, or null when it is not for the user. */
function userFacingMessage(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_MESSAGE_LENGTH) return null;
  if (/[\r\n]/.test(trimmed)) return null;
  if (/^\w*Error:/.test(trimmed)) return null;
  if (TECHNICAL_MESSAGE.test(trimmed) || TECHNICAL_TOKEN.test(trimmed)) return null;
  return trimmed;
}

function envelopeOf(err: unknown): { type: string; message: string } | null {
  if (typeof err !== "object" || err === null) return null;
  const { error } = err as ErrorEnvelopeLike;
  if (typeof error !== "object" || error === null) return null;
  return {
    type: typeof error.type === "string" ? error.type : "",
    message: typeof error.message === "string" ? error.message : "",
  };
}

function isNetworkFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err instanceof TypeError ||
    /failed to fetch|networkerror|load failed|network request failed/i.test(err.message)
  );
}

// Structural checks keep this mapper independent of the API adapter (and
// usable with a plain envelope) while still recognising both error classes.
function isApiErrorLike(err: unknown): err is Error & { type?: string; message: string } {
  return err instanceof Error && err.name === "ApiError";
}

function isServerErrorLike(err: unknown): boolean {
  return err instanceof Error && err.name === "ServerError";
}

function isMissingWallet(err: unknown): boolean {
  return err instanceof Error && /wallet (?:not available|isn't available)/i.test(err.message);
}

function mapApiError(type: string, message: string, fallback: string): string {
  switch (type) {
    case "unauthorized":
      return SESSION_EXPIRED_MESSAGE;
    case "network":
      return "The network is unreachable. Try again in a moment.";
    case "upstream":
      return "The network is busy. Try again in a moment.";
    case "conflict":
      return userFacingMessage(message) ?? "That was already done. Refresh and try again.";
    case "policy":
      return userFacingMessage(message) ?? "That isn't available right now.";
    case "invalid":
      return userFacingMessage(message) ?? fallback;
    default:
      // `unknown-*` and anything new: the server's text is diagnostic.
      return fallback;
  }
}

/**
 * Turn any thrown value into one sentence.
 *
 * `fallback` (or `{ fallback }`) is the call site's own copy for failures that
 * have no safe server or transport explanation.
 */
export function presentError(
  err: unknown,
  fallback?: string | PresentErrorOptions,
): string {
  const fallbackMessage = fallbackFrom(fallback);

  if (isWalletCanceled(err)) return WALLET_CANCELED_MESSAGE;
  if (isUserRejected(err)) return WALLET_REJECTED_MESSAGE;

  if (isApiErrorLike(err)) {
    return mapApiError(err.type ?? "", err.message, fallbackMessage);
  }

  const envelope = envelopeOf(err);
  if (envelope !== null) {
    return mapApiError(envelope.type, envelope.message, fallbackMessage);
  }

  if (isServerErrorLike(err)) {
    return "The server isn't responding. Try again in a moment.";
  }
  if (isMissingWallet(err)) return MISSING_WALLET_MESSAGE;
  if (isNetworkFailure(err)) {
    return "No connection. Check your connection and try again.";
  }
  if (err instanceof Error) {
    return userFacingMessage(err.message) ?? fallbackMessage;
  }
  return fallbackMessage;
}
