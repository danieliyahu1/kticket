// A small, business-agnostic polling helper. It owns only the timing (doubling
// backoff between attempts) — the predicate is the caller's logic, so retries
// that are specific to one user flow (deploy "verifiable", buy "visible") stay
// with that flow and never leak into the data-access layer.

export interface PollOptions {
  /** Total attempts, including the first (immediate) check. */
  maxAttempts: number;
  /** Initial delay between attempts, doubled each retry. */
  baseDelayMs: number;
  /** Backoff ceiling. */
  maxDelayMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll a predicate until it returns a value, or the attempt budget is spent.
 * The predicate's returned value (when present) is the poll's result — e.g.
 * the verified event — so the caller's business policy stays in the predicate.
 *
 * Both `null` and `undefined` mean "not yet" and keep the poll going; only a
 * non-nullish value is a result. `getTransaction` reports "not found" as
 * `null`, so treating it as a result would make confirmation give up on the
 * very first check (KTK buy).
 */
export async function pollUntil<T>(
  predicate: () => Promise<T | null | undefined>,
  options: PollOptions,
): Promise<T | undefined> {
  let delay = options.baseDelayMs;
  for (let attempt = 0; attempt <= options.maxAttempts; attempt++) {
    const result = await predicate();
    if (result != null) return result;
    if (attempt < options.maxAttempts) {
      await sleep(delay);
      delay = Math.min(delay * 2, options.maxDelayMs);
    }
  }
  return undefined;
}
