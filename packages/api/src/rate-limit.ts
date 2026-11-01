// Fixed-window rate limiter with a bounded key space.
//
// `POST /v1/feedback` is public and anonymous, so the key is a client address.
// The map is capped and swept so a public endpoint cannot retain unbounded
// per-client state.

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  maxKeys?: number;
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Whole seconds until the window resets; 0 when allowed. */
  retryAfterSeconds: number;
}

export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #now: () => number;
  readonly #windows = new Map<string, { startedAt: number; count: number }>();

  constructor(options: RateLimiterOptions) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#maxKeys = options.maxKeys ?? 4096;
    this.#now = options.now ?? Date.now;
  }

  check(key: string): RateLimitDecision {
    const now = this.#now();
    this.#sweep(now);

    let window = this.#windows.get(key);
    if (window === undefined || now - window.startedAt >= this.#windowMs) {
      window = { startedAt: now, count: 0 };
      this.#windows.delete(key);
      this.#windows.set(key, window);
    }

    window.count += 1;
    if (window.count <= this.#limit) return { allowed: true, retryAfterSeconds: 0 };

    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((window.startedAt + this.#windowMs - now) / 1000),
      ),
    };
  }

  #sweep(now: number): void {
    for (const [key, window] of this.#windows) {
      if (now - window.startedAt >= this.#windowMs) this.#windows.delete(key);
    }
    while (this.#windows.size > this.#maxKeys) {
      const oldest = this.#windows.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.#windows.delete(oldest);
    }
  }
}
