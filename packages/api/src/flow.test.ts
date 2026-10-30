import { describe, expect, it, vi } from "vitest";
import { broadcastAndConfirm, describeWalletSignatures, waitForAcceptance } from "./flow.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import type { WireTransaction } from "./wire.js";

const TXID_A = "aa".repeat(32);
const TXID_B = "bb".repeat(32);
/** No waiting in tests: the poll runs its first attempt and gives up. */
const NO_RETRIES = { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0 };
/** The full acceptance window the flow spends before reporting `pending`. */
const CONFIRM_WINDOW_MS = 120_000;

vi.mock("./wrpc-client.js", () => ({
  submitTransactionOverWrpc: async () => "aa".repeat(32),
}));

function template(): WireTransaction {
  return {
    version: 0,
    lock_time: 0,
    inputs: [
      {
        previous_outpoint: { transaction_id: TXID_A, index: 0 },
        signature_script: "",
        sequence: 0,
        sig_op_count: 1,
      },
      {
        previous_outpoint: { transaction_id: TXID_B, index: 1 },
        signature_script: "",
        sequence: 0,
        sig_op_count: 1,
      },
    ],
    outputs: [],
  };
}

function walletPayload(entries: { txid: string; index: number; sig?: string }[]) {
  return {
    id: "0".repeat(64),
    version: 0,
    inputs: entries.map((e) => ({
      transactionId: e.txid,
      index: e.index,
      ...(e.sig ? { signatureScript: e.sig } : {}),
    })),
    outputs: [],
  };
}

describe("describeWalletSignatures", () => {
  it("reports which template positions each wallet payload covered", () => {
    const outcome = describeWalletSignatures(
      "list finalize",
      template(),
      walletPayload([{ txid: TXID_A, index: 0, sig: "41ff" }]),
    );
    expect(outcome).toEqual({
      flow: "list finalize",
      inputs: 2,
      wallets: [{ signed: [0], missing: [1] }],
    });
  });

  it("parses string payloads and counts empty signature scripts as unsigned", () => {
    const payload = JSON.stringify(
      walletPayload([
        { txid: TXID_A, index: 0, sig: "41ff" },
        { txid: TXID_B, index: 1 },
      ]),
    );
    const outcome = describeWalletSignatures("use finalize", template(), payload);
    expect(outcome.wallets[0]).toEqual({ signed: [0], missing: [1] });
  });

  it("accepts two payloads (owner + gate)", () => {
    const outcome = describeWalletSignatures(
      "use finalize",
      template(),
      walletPayload([{ txid: TXID_A, index: 0, sig: "41aa" }, { txid: TXID_B, index: 1, sig: "41bb" }]),
      walletPayload([{ txid: TXID_A, index: 0, sig: "41cc" }]),
    );
    expect(outcome.wallets).toEqual([
      { signed: [0, 1], missing: [] },
      { signed: [0], missing: [1] },
    ]);
  });

  it("tolerates garbage payloads", () => {
    const outcome = describeWalletSignatures("buy finalize", template(), "{broken", undefined);
    expect(outcome.wallets).toEqual([
      { signed: [], missing: [0, 1] },
      { signed: [], missing: [0, 1] },
    ]);
  });
});

/**
 * A client where only the methods a test names work. Everything else throws,
 * so a test that accidentally exercises the wrong path fails loudly.
 */
function stubClient(overrides: Partial<KaspaClientLike> = {}): KaspaClientLike {
  const unused = (): Promise<never> => Promise.reject(new Error("not used by this test"));
  return {
    getUtxos: unused,
    getUtxosForAddresses: unused,
    getFullTransactions: unused,
    getTransaction: unused,
    isTransactionAccepted: unused,
    getFeeEstimate: unused,
    computeMass: unused,
    broadcastTransaction: unused,
    clearCache: () => {},
    ...overrides,
  };
}

/** Answers the acceptance lookup in order, then "not accepted" forever. */
function acceptedInOrder(answers: boolean[]): () => Promise<boolean> {
  const queue = [...answers];
  return async () => queue.shift() ?? false;
}

describe("waitForAcceptance", () => {
  it("reports acceptance as soon as the ledger has it", async () => {
    const kaspa = stubClient({ isTransactionAccepted: acceptedInOrder([true]) });
    await expect(waitForAcceptance(kaspa, TXID_A, NO_RETRIES)).resolves.toBe(true);
  });

  it("keeps polling while the transaction is only indexed, then settles", async () => {
    const kaspa = stubClient({ isTransactionAccepted: acceptedInOrder([false, false, true]) });
    await expect(
      waitForAcceptance(kaspa, TXID_A, { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 }),
    ).resolves.toBe(true);
  });

  it("reports pending — not an error — when acceptance never arrives", async () => {
    const kaspa = stubClient({ isTransactionAccepted: acceptedInOrder([]) });
    await expect(
      waitForAcceptance(kaspa, TXID_A, { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 }),
    ).resolves.toBe(false);
  });

  it("treats an unreadable verdict as 'not yet' — the tx is already broadcast", async () => {
    const isTransactionAccepted = vi.fn(async () => {
      throw new Error("upstream unavailable");
    });
    const kaspa = stubClient({ isTransactionAccepted });
    await expect(waitForAcceptance(kaspa, TXID_A, NO_RETRIES)).resolves.toBe(false);
    expect(isTransactionAccepted).toHaveBeenCalledTimes(1);
  });
});

describe("broadcastAndConfirm", () => {
  const ctx = (kaspa: KaspaClientLike) => ({ kaspa, networkId: "testnet-10" });

  it("settles a broadcast the ledger accepted and drops cached reads", async () => {
    const clearCache = vi.fn();
    const kaspa = stubClient({ isTransactionAccepted: async () => true, clearCache });
    const outcome = await broadcastAndConfirm(template(), {}, ctx(kaspa));
    expect(outcome).toEqual({ txid: TXID_A, status: "settled" });
    expect(clearCache).toHaveBeenCalledTimes(1);
  });

  it("reports a relayed-but-unaccepted broadcast as pending, keeps the cache", async () => {
    vi.useFakeTimers();
    try {
      const clearCache = vi.fn();
      const kaspa = stubClient({ isTransactionAccepted: async () => false, clearCache });
      const broadcast = broadcastAndConfirm(template(), {}, ctx(kaspa));
      // Let the flow spend its whole ~95s acceptance window.
      await vi.advanceTimersByTimeAsync(CONFIRM_WINDOW_MS);
      await expect(broadcast).resolves.toEqual({ txid: TXID_A, status: "pending" });
      expect(clearCache).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
