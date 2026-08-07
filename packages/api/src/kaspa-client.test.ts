import { describe, expect, it } from "vitest";
import { KaspaClient, UpstreamRequestError } from "./kaspa-client";

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
    return jsonResponse(404, {});
  };
  return { fetchFn, calls };
}

describe("KaspaClient — upstream handling (KTK-5)", () => {
  it("returns the utxo array for an address", async () => {
    const utxos = [
      {
        address: "kaspatest:abc",
        outpoint: { transactionId: "aa".repeat(32), index: 1 },
        utxoEntry: { amount: "5" },
      },
    ];
    const { fetchFn, calls } = fetchFrom([
      {
        match: (u) => u.endsWith("/addresses/kaspatest%3Aabc/utxos") || u.includes("/utxos"),
        respond: () => jsonResponse(200, utxos),
      },
    ]);
    const client = new KaspaClient("https://upstream.test", {
      fetch: fetchFn,
      sleep: async () => {},
    });
    const result = await client.getUtxos("kaspatest:abc");
    expect(result).toEqual(utxos);
    expect(calls).toHaveLength(1);
  });

  it("sends the batch request body as { addresses }", async () => {
    let seenBody: unknown;
    const fetchFn: typeof fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      seenBody = init?.body;
      return jsonResponse(200, []);
    };
    const client = new KaspaClient("https://upstream.test", {
      fetch: fetchFn,
      sleep: async () => {},
    });
    await client.getUtxosForAddresses(["kaspatest:a", "kaspatest:b"]);
    expect(seenBody).toBe(JSON.stringify({ addresses: ["kaspatest:a", "kaspatest:b"] }));
  });

  it("retries 503 with backoff then succeeds", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const fetchFn = async () => {
      calls += 1;
      return calls < 3 ? jsonResponse(503, {}) : jsonResponse(200, [{ address: "kaspatest:a" }]);
    };
    const client = new KaspaClient("https://upstream.test", {
      fetch: fetchFn,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      maxAttempts: 3,
      baseRetryMs: 100,
      maxRetryMs: 1000,
    });
    const result = await client.getUtxos("kaspatest:a");
    expect(calls).toBe(3);
    expect(sleeps).toEqual([100, 200]); // base * 2^(attempt-1)
    expect(result).toEqual([{ address: "kaspatest:a" }]);
  });

  it("honours Retry-After on 503", async () => {
    const sleeps: number[] = [];
    const fetchFn = async () => jsonResponse(503, {}, { "retry-after": "2" });
    const client = new KaspaClient("https://upstream.test", {
      fetch: fetchFn,
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
    expect(sleeps).toEqual([2000 + 100]);
  });

  it("gives up with a 503 upstream error after exhausting retries", async () => {
    const fetchFn = async () => jsonResponse(503, {});
    const client = new KaspaClient("https://upstream.test", {
      fetch: fetchFn,
      sleep: async () => {},
      maxAttempts: 2,
    });
    await expect(client.getUtxos("kaspatest:a")).rejects.toMatchObject({
      type: "upstream",
      statusCode: 503,
      retryable: true,
    });
  });

  it("treats 429 like 503 (retry then upstream error)", async () => {
    const fetchFn = async () => jsonResponse(429, {});
    const client = new KaspaClient("https://upstream.test", {
      fetch: fetchFn,
      sleep: async () => {},
      maxAttempts: 2,
    });
    await expect(client.getUtxos("kaspatest:a")).rejects.toMatchObject({
      type: "upstream",
      statusCode: 503,
    });
  });

  it("maps a timeout to a network error without retrying", async () => {
    let calls = 0;
    const fetchFn: typeof fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      init?.signal?.dispatchEvent(new Event("abort"));
      throw new DOMException("aborted", "AbortError");
    };
    const client = new KaspaClient("https://upstream.test", {
      fetch: fetchFn as typeof fetch,
      sleep: async () => {},
      timeoutMs: 10,
      maxAttempts: 3,
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
    const client = new KaspaClient("https://upstream.test", {
      fetch: fetchFn,
      sleep: async () => {},
    });
    await expect(client.getUtxos("kaspatest:a")).rejects.toMatchObject({
      type: "network",
      statusCode: 502,
    });
  });

  it("returns null for a 404 transaction (not a ticket genesis)", async () => {
    const { fetchFn } = fetchFrom([{ match: () => true, respond: () => jsonResponse(404, {}) }]);
    const client = new KaspaClient("https://upstream.test", {
      fetch: fetchFn,
      sleep: async () => {},
    });
    await expect(client.getTransaction("ab".repeat(32))).resolves.toBeNull();
  });

  it("throws UpstreamRequestError for other 4xx", async () => {
    const { fetchFn } = fetchFrom([
      { match: () => true, respond: () => jsonResponse(422, { detail: "bad" }) },
    ]);
    const client = new KaspaClient("https://upstream.test", {
      fetch: fetchFn,
      sleep: async () => {},
    });
    const err = await client.getUtxos("kaspatest:a").catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamRequestError);
    expect(err.status).toBe(422);
  });

  it("throws an upstream error for an unhandled 5xx", async () => {
    const { fetchFn } = fetchFrom([{ match: () => true, respond: () => jsonResponse(500, {}) }]);
    const client = new KaspaClient("https://upstream.test", {
      fetch: fetchFn,
      sleep: async () => {},
    });
    await expect(client.getUtxos("kaspatest:a")).rejects.toMatchObject({
      type: "upstream",
      statusCode: 503,
    });
  });

  it("caches a 200 response within its TTL (rate-limit valve)", async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      return jsonResponse(200, [{ address: "kaspatest:a" }]);
    };
    const now = { t: 0 };
    const client = new KaspaClient("https://upstream.test", {
      fetch: fetchFn,
      sleep: async () => {},
      now: () => now.t,
      utxoCacheMs: 3000,
    });
    await client.getUtxos("kaspatest:a");
    await client.getUtxos("kaspatest:a");
    expect(calls).toBe(1);
    now.t = 3001; // TTL expired
    await client.getUtxos("kaspatest:a");
    expect(calls).toBe(2);
  });

  it("keys the cache by URL and body", async () => {
    const urls: string[] = [];
    const fetchFn: typeof fetch = async (input: string | URL | Request) => {
      urls.push(String(input));
      return jsonResponse(200, []);
    };
    const client = new KaspaClient("https://upstream.test", {
      fetch: fetchFn,
      sleep: async () => {},
    });
    await client.getUtxos("kaspatest:a");
    await client.getFullTransactions("kaspatest:a");
    await client.getTransaction("ab".repeat(32));
    await client.getTransaction("ab".repeat(32));
    expect(urls).toHaveLength(3);
  });
});

describe("KaspaClient — fee / mass / broadcast (KTK-6)", () => {
  const tx = {
    version: 1,
    inputs: [
      {
        previousOutpoint: { transactionId: "aa".repeat(32), index: 0 },
        signatureScript: "",
        sequence: 0,
        sigOpCount: 1,
      },
    ],
    outputs: [{ amount: 49_000, scriptPublicKey: { version: 0, scriptPublicKey: "51" } }],
    lockTime: 0,
  };

  it("getFeeEstimate returns the priority bucket feerate", async () => {
    const estimate = {
      priorityBucket: { feerate: 100, estimatedSeconds: 0.009 },
      normalBuckets: [{ feerate: 100, estimatedSeconds: 0.009 }],
      lowBuckets: [{ feerate: 100, estimatedSeconds: 0.009 }],
    };
    const { fetchFn, calls } = fetchFrom([
      {
        match: (u) => u.endsWith("/info/fee-estimate"),
        respond: () => jsonResponse(200, estimate),
      },
    ]);
    const client = new KaspaClient("https://upstream.test", {
      fetch: fetchFn,
      sleep: async () => {},
    });
    const result = await client.getFeeEstimate();
    expect(result.priorityBucket.feerate).toBe(100);
    expect(calls).toHaveLength(1);
  });

  it("computeMass POSTs the SubmitTxModel and returns mass + compute_mass", async () => {
    let seenBody: unknown;
    const fetchFn: typeof fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      seenBody = init?.body;
      return jsonResponse(200, { mass: 1558, storage_mass: 0, compute_mass: 1558 });
    };
    const client = new KaspaClient("https://upstream.test", {
      fetch: fetchFn,
      sleep: async () => {},
    });
    const result = await client.computeMass(tx);
    expect(result).toEqual({ mass: 1558, storage_mass: 0, compute_mass: 1558 });
    expect(JSON.parse(String(seenBody))).toEqual(tx);
  });

  it("broadcastTransaction sends { transaction, allowOrphan } and returns the txid", async () => {
    let seenBody: unknown;
    const fetchFn: typeof fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      seenBody = init?.body;
      return jsonResponse(200, { transactionId: "dd".repeat(32) });
    };
    const client = new KaspaClient("https://upstream.test", {
      fetch: fetchFn,
      sleep: async () => {},
    });
    const result = await client.broadcastTransaction(tx);
    expect(result.transactionId).toBe("dd".repeat(32));
    expect(JSON.parse(String(seenBody))).toEqual({ transaction: tx, allowOrphan: false });
  });

  it("broadcastTransaction surfaces a 400 rejection as { error }", async () => {
    const fetchFn = async () =>
      jsonResponse(400, {
        error: "RPC Server (remote error) -> Rejected transaction: double spend",
      });
    const client = new KaspaClient("https://upstream.test", {
      fetch: fetchFn,
      sleep: async () => {},
    });
    const result = await client.broadcastTransaction(tx);
    expect(result.error).toContain("double spend");
  });

  it("broadcastTransaction re-throws non-400 upstream errors", async () => {
    const fetchFn = async () => jsonResponse(503, {});
    const client = new KaspaClient("https://upstream.test", {
      fetch: fetchFn,
      sleep: async () => {},
      maxAttempts: 1,
    });
    await expect(client.broadcastTransaction(tx)).rejects.toMatchObject({ type: "upstream" });
  });
});
