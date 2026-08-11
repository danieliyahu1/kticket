import { describe, expect, it } from "vitest";
import {
  HTTP_BAD_REQUEST,
  HTTP_INTERNAL_SERVER_ERROR,
  HTTP_NOT_FOUND,
  HTTP_OK,
  HTTP_SERVICE_UNAVAILABLE,
  HTTP_TOO_MANY_REQUESTS,
  HTTP_UNPROCESSABLE_ENTITY,
} from "./http-status.js";
import { KaspaClient, type UpstreamOptions, UpstreamRequestError } from "./kaspa-client";

const TXID_BYTE_LENGTH = 32;
const RETRY_TOTAL_ATTEMPTS = 3;
const FIRST_RETRY_SLEEP_MS = 100;
const SECOND_RETRY_SLEEP_MS = 200;
const RETRY_AFTER_MS = 2000;
const BASE_RETRY_MS = 100;
const CACHE_TTL_EXPIRED = 3001;
const DISTINCT_CACHE_KEYS = 3;
const PRIORITY_FEERATE = 100;

const ADDRESS_UTXOS = [
  {
    address: "kaspatest:abc",
    outpoint: { transactionId: "aa".repeat(TXID_BYTE_LENGTH), index: 1 },
    utxoEntry: { amount: "5" },
  },
];

const TX = {
  version: 1,
  inputs: [
    {
      previousOutpoint: { transactionId: "aa".repeat(TXID_BYTE_LENGTH), index: 0 },
      signatureScript: "",
      sequence: 0,
      sigOpCount: 1,
    },
  ],
  outputs: [{ amount: 49_000, scriptPublicKey: { version: 0, scriptPublicKey: "51" } }],
  lockTime: 0,
};

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function fetchFrom(routes: Array<{ match: (url: string) => boolean; respond: () => Response }>) {
  const calls: FetchCall[] = [];
  const fetchFn: typeof fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    for (const route of routes) {
      if (route.match(url)) return route.respond();
    }
    return jsonResponse(HTTP_NOT_FOUND, {});
  };
  return { fetchFn, calls };
}

function makeClient(fetchFn: typeof fetch, overrides: UpstreamOptions = {}): KaspaClient {
  return new KaspaClient("https://upstream.test", {
    fetch: fetchFn,
    sleep: async () => {},
    ...overrides,
  });
}

describe("KaspaClient — utxo reads (KTK-5)", () => {
  it("returns the utxo array for an address", async () => {
    const { fetchFn, calls } = fetchFrom([
      {
        match: (u) => u.endsWith("/addresses/kaspatest%3Aabc/utxos") || u.includes("/utxos"),
        respond: () => jsonResponse(HTTP_OK, ADDRESS_UTXOS),
      },
    ]);
    const client = makeClient(fetchFn);
    const result = await client.getUtxos("kaspatest:abc");
    expect(result).toEqual(ADDRESS_UTXOS);
    expect(calls).toHaveLength(1);
  });

  it("sends the batch request body as { addresses }", async () => {
    let seenBody: unknown;
    const fetchFn: typeof fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      seenBody = init?.body;
      return jsonResponse(HTTP_OK, []);
    };
    const client = makeClient(fetchFn);
    await client.getUtxosForAddresses(["kaspatest:a", "kaspatest:b"]);
    expect(seenBody).toBe(JSON.stringify({ addresses: ["kaspatest:a", "kaspatest:b"] }));
  });
});

describe("KaspaClient — retry backoff (KTK-5)", () => {
  it("retries 503 with backoff then succeeds", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const fetchFn = async () => {
      calls += 1;
      return calls < RETRY_TOTAL_ATTEMPTS
        ? jsonResponse(HTTP_SERVICE_UNAVAILABLE, {})
        : jsonResponse(HTTP_OK, [{ address: "kaspatest:a" }]);
    };
    const client = makeClient(fetchFn, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      maxAttempts: RETRY_TOTAL_ATTEMPTS,
      baseRetryMs: 100,
      maxRetryMs: 1000,
    });
    const result = await client.getUtxos("kaspatest:a");
    expect(calls).toBe(RETRY_TOTAL_ATTEMPTS);
    expect(sleeps).toEqual([FIRST_RETRY_SLEEP_MS, SECOND_RETRY_SLEEP_MS]); // base * 2^(attempt-1)
    expect(result).toEqual([{ address: "kaspatest:a" }]);
  });

  it("gives up with a 503 upstream error after exhausting retries", async () => {
    const fetchFn = async () => jsonResponse(HTTP_SERVICE_UNAVAILABLE, {});
    const client = makeClient(fetchFn, { maxAttempts: 2 });
    await expect(client.getUtxos("kaspatest:a")).rejects.toMatchObject({
      type: "upstream",
      statusCode: 503,
      retryable: true,
    });
  });
});

describe("KaspaClient — Retry-After / 429 (KTK-5)", () => {
  it("honours Retry-After on 503", async () => {
    const sleeps: number[] = [];
    const fetchFn = async () => jsonResponse(HTTP_SERVICE_UNAVAILABLE, {}, { "retry-after": "2" });
    const client = makeClient(fetchFn, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      maxAttempts: 2,
      baseRetryMs: 100,
    });
    await expect(client.getUtxos("kaspatest:a")).rejects.toMatchObject({
      type: "upstream",
      statusCode: 503,
      retryable: true,
      retryAfter: 2,
    });
    expect(sleeps).toEqual([RETRY_AFTER_MS + BASE_RETRY_MS]);
  });

  it("treats 429 like 503 (retry then upstream error)", async () => {
    const fetchFn = async () => jsonResponse(HTTP_TOO_MANY_REQUESTS, {});
    const client = makeClient(fetchFn, { maxAttempts: 2 });
    await expect(client.getUtxos("kaspatest:a")).rejects.toMatchObject({
      type: "upstream",
      statusCode: 503,
    });
  });
});

describe("KaspaClient — network error mapping (KTK-5)", () => {
  it("maps a timeout to a network error without retrying", async () => {
    let calls = 0;
    const fetchFn: typeof fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      init?.signal?.dispatchEvent(new Event("abort"));
      throw new DOMException("aborted", "AbortError");
    };
    const client = makeClient(fetchFn, {
      timeoutMs: 10,
      maxAttempts: RETRY_TOTAL_ATTEMPTS,
    });
    await expect(client.getUtxos("kaspatest:a")).rejects.toMatchObject({
      type: "network",
      statusCode: 502,
    });
    expect(calls).toBe(1);
  });

  it("maps a connection error to a network error", async () => {
    const fetchFn = async () => {
      throw new TypeError("fetch failed");
    };
    const client = makeClient(fetchFn);
    await expect(client.getUtxos("kaspatest:a")).rejects.toMatchObject({
      type: "network",
      statusCode: 502,
    });
  });
});

describe("KaspaClient — transaction error mapping (KTK-5)", () => {
  it("returns null for a 404 transaction (not a ticket genesis)", async () => {
    const { fetchFn } = fetchFrom([
      { match: () => true, respond: () => jsonResponse(HTTP_NOT_FOUND, {}) },
    ]);
    const client = makeClient(fetchFn);
    await expect(client.getTransaction("ab".repeat(TXID_BYTE_LENGTH))).resolves.toBeNull();
  });

  it("throws UpstreamRequestError for other 4xx", async () => {
    const { fetchFn } = fetchFrom([
      {
        match: () => true,
        respond: () => jsonResponse(HTTP_UNPROCESSABLE_ENTITY, { detail: "bad" }),
      },
    ]);
    const client = makeClient(fetchFn);
    const err = await client.getUtxos("kaspatest:a").catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamRequestError);
    expect(err.status).toBe(HTTP_UNPROCESSABLE_ENTITY);
  });

  it("throws an upstream error for an unhandled 5xx", async () => {
    const { fetchFn } = fetchFrom([
      { match: () => true, respond: () => jsonResponse(HTTP_INTERNAL_SERVER_ERROR, {}) },
    ]);
    const client = makeClient(fetchFn);
    await expect(client.getUtxos("kaspatest:a")).rejects.toMatchObject({
      type: "upstream",
      statusCode: 503,
    });
  });
});

describe("KaspaClient — caching (KTK-5)", () => {
  it("caches a 200 response within its TTL (rate-limit valve)", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      return jsonResponse(HTTP_OK, [{ address: "kaspatest:a" }]);
    };
    const now = { t: 0 };
    const client = makeClient(fetchFn, { now: () => now.t, utxoCacheMs: 3000 });
    await client.getUtxos("kaspatest:a");
    await client.getUtxos("kaspatest:a");
    expect(calls).toBe(1);
    now.t = CACHE_TTL_EXPIRED; // TTL expired
    await client.getUtxos("kaspatest:a");
    expect(calls).toBe(2);
  });

  it("keys the cache by URL and body", async () => {
    const urls: string[] = [];
    const fetchFn: typeof fetch = async (input: string | URL | Request) => {
      urls.push(String(input));
      return jsonResponse(HTTP_OK, []);
    };
    const client = makeClient(fetchFn);
    await client.getUtxos("kaspatest:a");
    await client.getFullTransactions("kaspatest:a");
    await client.getTransaction("ab".repeat(TXID_BYTE_LENGTH));
    await client.getTransaction("ab".repeat(TXID_BYTE_LENGTH));
    expect(urls).toHaveLength(DISTINCT_CACHE_KEYS);
  });

  it("clearCache drops cached entries so the next read refetches", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      return jsonResponse(HTTP_OK, [{ address: "kaspatest:a" }]);
    };
    const client = makeClient(fetchFn);
    await client.getUtxos("kaspatest:a");
    await client.getUtxos("kaspatest:a");
    expect(calls).toBe(1);
    client.clearCache();
    await client.getUtxos("kaspatest:a");
    expect(calls).toBe(2);
  });
});

describe("KaspaClient — fee estimate / mass (KTK-6)", () => {
  it("getFeeEstimate returns the priority bucket feerate", async () => {
    const estimate = {
      priorityBucket: { feerate: 100, estimatedSeconds: 0.009 },
      normalBuckets: [{ feerate: 100, estimatedSeconds: 0.009 }],
      lowBuckets: [{ feerate: 100, estimatedSeconds: 0.009 }],
    };
    const { fetchFn, calls } = fetchFrom([
      {
        match: (u) => u.endsWith("/info/fee-estimate"),
        respond: () => jsonResponse(HTTP_OK, estimate),
      },
    ]);
    const client = makeClient(fetchFn);
    const result = await client.getFeeEstimate();
    expect(result.priorityBucket.feerate).toBe(PRIORITY_FEERATE);
    expect(calls).toHaveLength(1);
  });

  it("computeMass POSTs the SubmitTxModel and returns mass + compute_mass", async () => {
    let seenBody: unknown;
    const fetchFn: typeof fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      seenBody = init?.body;
      return jsonResponse(HTTP_OK, { mass: 1558, storage_mass: 0, compute_mass: 1558 });
    };
    const client = makeClient(fetchFn);
    const result = await client.computeMass(TX);
    expect(result).toEqual({ mass: 1558, storage_mass: 0, compute_mass: 1558 });
    expect(JSON.parse(String(seenBody))).toEqual(TX);
  });
});

describe("KaspaClient — broadcastTransaction (KTK-6)", () => {
  it("broadcastTransaction sends { transaction, allowOrphan } and returns the txid", async () => {
    let seenBody: unknown;
    const fetchFn: typeof fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      seenBody = init?.body;
      return jsonResponse(HTTP_OK, { transactionId: "dd".repeat(TXID_BYTE_LENGTH) });
    };
    const client = makeClient(fetchFn);
    const result = await client.broadcastTransaction(TX);
    expect(result.transactionId).toBe("dd".repeat(TXID_BYTE_LENGTH));
    expect(JSON.parse(String(seenBody))).toEqual({ transaction: TX, allowOrphan: false });
  });

  it("broadcastTransaction surfaces a 400 rejection as { error }", async () => {
    const fetchFn = async () =>
      jsonResponse(HTTP_BAD_REQUEST, {
        error: "RPC Server (remote error) -> Rejected transaction: double spend",
      });
    const client = makeClient(fetchFn);
    const result = await client.broadcastTransaction(TX);
    expect(result.error).toContain("double spend");
  });

  it("broadcastTransaction re-throws non-400 upstream errors", async () => {
    const fetchFn = async () => jsonResponse(HTTP_SERVICE_UNAVAILABLE, {});
    const client = makeClient(fetchFn, { maxAttempts: 1 });
    await expect(client.broadcastTransaction(TX)).rejects.toMatchObject({ type: "upstream" });
  });
});
