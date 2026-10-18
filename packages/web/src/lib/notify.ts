// The app's one message output.
//
// Flow controllers call these verbs instead of reaching into the toast store.
// That keeps the tone and the copy mapping in one place, and leaves the toast
// implementation free to change without touching every flow.

import { showToast } from "../components/toast-store";
import { SESSION_EXPIRED_MESSAGE, presentError } from "./present-error";

/** Publish a failure through the error channel. */
export function notifyFailure(err: unknown, fallback?: string): void {
  showToast(presentError(err, fallback), { tone: "error" });
}

/** A wallet dismissal is a notice, never an error. */
export function notifyCanceled(err: unknown): void {
  showToast(presentError(err), { tone: "notice" });
}

/** The session ended; the user must sign in again. */
export function notifySessionExpired(): void {
  showToast(SESSION_EXPIRED_MESSAGE, { tone: "notice" });
}
