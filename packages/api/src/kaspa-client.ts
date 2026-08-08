// Typed HTTP client for the Kaspa public REST API (HLD v0.23 §2.2 — "reads via
// api-tn10.kaspa.org"). Upstream handling per KTK-5:
//   - 503 / 429  → retry with exponential backoff (honouring `Retry-After`),
//     then 503 `upstream` error (retryable).
//   - timeout / connection errors → 502 `network` error (no retry).
//   - a short-TTL in-process cache is used only as a rate-limit valve.
//
// All 200 responses are cached; the reader and availability path reuse the
// same client, so one event directory scan does not hammer api-tn10.kaspa.org.

import { networkError, upstreamError } from "./errors.js";
import type {
  FeeEstimateResponse,
  SubmitTransactionResponse,
  SubmitTxModel,
  TxMass,
  TxModel,
  UtxoResponse,
} from "./kaspa-types.js";
import { isRecord } from "./validate.js";

const UPSTREAM_HOST = "api-tn10.kaspa.org";

/** Public surface used by the reader / routes — makes clients injectable in tests. */
export interface KaspaClientLike {
  getUtxos(address: string): Promise<UtxoResponse[]>;
  getUtxosForAddresses(addresses: string[]): Promise<UtxoResponse[]>;
  getFullTransactions(address: string, limit?: number): Promise<TxModel[]>;
  getTransaction(txId: string): Promise<TxModel | null>;
  getFeeEstimate(): Promise<FeeEstimateResponse>;
  computeMass(tx: SubmitTxModel): Promise<TxMass>;
  broadcastTransaction(tx: SubmitTxModel): Promise<SubmitTransactionResponse>;
}

export interface UpstreamOptions {
  /** Per-request timeout in ms (default 10_000). */
  timeoutMs?: number;
  /** Total attempts for retryable statuses (default 3). */
  maxAttempts?: number;
  /** Base backoff in ms, doubled per attempt (default 200). */
  baseRetryMs?: number;
  /** Backoff ceiling in ms (default 2_000). */
  maxRetryMs?: number;
  /** Cache TTL for UTXO reads in ms (default 3_000). */
  utxoCacheMs?: number;
  /** Cache TTL for address transaction lists in ms (default 5_000). */
  addressTxCacheMs?: number;
  /** Cache TTL for single transactions in ms (default 30_000). */
  transactionCacheMs?: number;
  /** Cache TTL for fee estimates in ms (default 5_000). */
  feeEstimateCacheMs?: number;
  /** Cache TTL for the mass endpoint in ms (default 3_000). */
  massCacheMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_RETRY_MS = 200;
const DEFAULT_MAX_RETRY_MS = 2_000;
const DEFAULT_UTXO_CACHE_MS = 3_000;
const DEFAULT_ADDRESS_TX_CACHE_MS = 5_000;
const DEFAULT_TRANSACTION_CACHE_MS = 30_000;
const DEFAULT_FEE_ESTIMATE_CACHE_MS = 5_000;
const DEFAULT_MASS_CACHE_MS = 3_000;

/** Non-retryable upstream response (e.g. 4xx) carrying the raw body. */
export class UpstreamRequestError extends Error {
  override readonly name = "UpstreamRequestError";

  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`${UPSTREAM_HOST} responded HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return undefined;
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

export class KaspaClient implements KaspaClientLike {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #baseRetryMs: number;
  readonly #maxRetryMs: number;
  readonly #utxoCacheMs: number;
  readonly #addressTxCacheMs: number;
  readonly #transactionCacheMs: number;
  readonly #feeEstimateCacheMs: number;
  readonly #massCacheMs: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  #cache = new Map<string, CacheEntry>();

  constructor(baseUrl: string, options: UpstreamOptions = {}) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#baseRetryMs = options.baseRetryMs ?? DEFAULT_BASE_RETRY_MS;
    this.#maxRetryMs = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
    this.#utxoCacheMs = options.utxoCacheMs ?? DEFAULT_UTXO_CACHE_MS;
    this.#addressTxCacheMs = options.addressTxCacheMs ?? DEFAULT_ADDRESS_TX_CACHE_MS;
    this.#transactionCacheMs = options.transactionCacheMs ?? DEFAULT_TRANSACTION_CACHE_MS;
    this.#feeEstimateCacheMs = options.feeEstimateCacheMs ?? DEFAULT_FEE_ESTIMATE_CACHE_MS;
    this.#massCacheMs = options.massCacheMs ?? DEFAULT_MASS_CACHE_MS;
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? Date.now;
  }

  async getUtxos(address: string): Promise<UtxoResponse[]> {
    return (await this.#request(
      `/addresses/${address}/utxos`,
      this.#utxoCacheMs,
    )) as UtxoResponse[];
  }

  async getUtxosForAddresses(addresses: string[]): Promise<UtxoResponse[]> {
    return (await this.#request("/addresses/utxos", this.#utxoCacheMs, "POST", {
      addresses,
    })) as UtxoResponse[];
  }

  async getFullTransactions(address: string, limit = 500): Promise<TxModel[]> {
    return (await this.#request(
      `/addresses/${address}/full-transactions?limit=${limit}`,
      this.#addressTxCacheMs,
    )) as TxModel[];
  }

  async getTransaction(txId: string): Promise<TxModel | null> {
    try {
      return (await this.#request(
        `/transactions/${txId.toLowerCase()}`,
        this.#transactionCacheMs,
      )) as TxModel;
    } catch (err) {
      if (err instanceof UpstreamRequestError && err.status === 404) return null;
      throw err;
    }
  }

  async getFeeEstimate(): Promise<FeeEstimateResponse> {
    return (await this.#request(
      "/info/fee-estimate",
      this.#feeEstimateCacheMs,
    )) as FeeEstimateResponse;
  }

  async computeMass(tx: SubmitTxModel): Promise<TxMass> {
    return (await this.#request("/transactions/mass", this.#massCacheMs, "POST", tx)) as TxMass;
  }

  async broadcastTransaction(tx: SubmitTxModel): Promise<SubmitTransactionResponse> {
    try {
      return (await this.#request("/transactions", 0, "POST", {
        transaction: tx,
        allowOrphan: false,
      })) as SubmitTransactionResponse;
    } catch (err) {
      // The upstream rejects invalid / double-spend / low-fee txs with HTTP 400
      // carrying `{ error: "RPC Server (remote error) -> ..." }`. The caller maps
      // that text to the taxonomy (invalid / conflict / policy); it is not an
      // upstream outage, so pass the response through instead of throwing.
      if (err instanceof UpstreamRequestError && err.status === 400) {
        try {
          const parsed: unknown = JSON.parse(err.body);
          if (isRecord(parsed) && typeof parsed.error === "string") {
            return { error: parsed.error };
          }
        } catch {
          // fall through to re-throw below
        }
      }
      throw err;
    }
  }

  async #request(
    path: string,
    cacheTtlMs: number,
    method: "GET" | "POST" = "GET",
    body?: unknown,
  ): Promise<unknown> {
    const key = `${method} ${path}${body === undefined ? "" : ` ${JSON.stringify(body)}`}`;
    const cached = this.#cache.get(key);
    if (cached && cached.expiresAt > this.#now()) return cached.value;

    const payload = body === undefined ? undefined : JSON.stringify(body);
    let lastRetryAfter: number | undefined;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      const response = await this.#fetchWithTimeout(method, path, payload);
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));

      if (response.status === 429 || response.status === 503) {
        lastRetryAfter = retryAfter;
        if (attempt < this.#maxAttempts) {
          await this.#sleep(this.#backoffMs(attempt, retryAfter));
          continue;
        }
        throw upstreamError(`${UPSTREAM_HOST} is unavailable or rate-limited`, {
          retryAfter: lastRetryAfter,
          detail: { status: response.status },
        });
      }

      if (response.status >= 500) {
        throw upstreamError(`${UPSTREAM_HOST} error (HTTP ${response.status})`, {
          detail: { status: response.status },
        });
      }
      if (response.status !== 200) {
        const text = await response.text().catch(() => "");
        throw new UpstreamRequestError(response.status, text);
      }

      const json: unknown = await response.json();
      this.#cache.set(key, { value: json, expiresAt: this.#now() + cacheTtlMs });
      return json;
    }

    throw upstreamError(`${UPSTREAM_HOST} is unavailable or rate-limited`, {
      retryAfter: lastRetryAfter,
    });
  }

  #fetchWithTimeout(
    method: "GET" | "POST",
    path: string,
    payload: string | undefined,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    return this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      signal: controller.signal,
      headers: payload === undefined ? undefined : { "content-type": "application/json" },
      body: payload,
    })
      .catch((err: unknown) => {
        if (isAbortError(err)) {
          throw networkError(`${UPSTREAM_HOST} timed out after ${this.#timeoutMs}ms`);
        }
        throw networkError(`${UPSTREAM_HOST} unreachable`, { detail: String(err) });
      })
      .finally(() => clearTimeout(timer));
  }

  #backoffMs(attempt: number, retryAfter: number | undefined): number {
    const exponential = Math.min(this.#maxRetryMs, this.#baseRetryMs * 2 ** (attempt - 1));
    return (retryAfter ?? 0) * 1000 + exponential;
  }
}
