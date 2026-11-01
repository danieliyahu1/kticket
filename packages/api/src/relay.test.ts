import { beforeEach, describe, expect, it, vi } from "vitest";
import { relaySignedTransaction } from "./relay.js";
import type { WireTransaction } from "./wire.js";

const TXID = "ab".repeat(32);
/** No waiting: these tests pin the retry rule, not the clock. */
const NO_DELAY = { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 };
/** The node's wording for a fee input whose parent it does not have yet. */
const ORPHAN =
  "RPC Server (remote error) -> Rejected transaction 2f90: transaction 2f90 is an orphan where orphan is disallowed";

vi.mock("./wrpc-client.js", () => ({ submitTransactionOverWrpc: vi.fn() }));

import { submitTransactionOverWrpc } from "./wrpc-client.js";

const submit = vi.mocked(submitTransactionOverWrpc);

function tx(): WireTransaction {
  return {
    version: 1,
    lock_time: 0,
    inputs: [
      {
        previous_outpoint: { transaction_id: "aa".repeat(32), index: 0 },
        signature_script: "",
        sequence: 0,
        sig_op_count: 1,
      },
    ],
    outputs: [],
  };
}

describe("relaySignedTransaction", () => {
  beforeEach(() => {
    submit.mockReset();
  });

  it("returns the txid in the lowercase form every route reports", async () => {
    submit.mockResolvedValue(TXID.toUpperCase());
    await expect(relaySignedTransaction(tx(), "testnet-10", NO_DELAY)).resolves.toBe(TXID);
  });

  it("re-sends the same bytes while the node does not know an input", async () => {
    submit.mockRejectedValueOnce(new Error(ORPHAN)).mockResolvedValueOnce(TXID);
    await expect(relaySignedTransaction(tx(), "testnet-10", NO_DELAY)).resolves.toBe(TXID);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("answers a spent retry budget with 'not yet', not with a conflict", async () => {
    submit.mockRejectedValue(new Error(ORPHAN));
    await expect(relaySignedTransaction(tx(), "testnet-10", NO_DELAY)).rejects.toMatchObject({
      type: "upstream",
      statusCode: 503,
      retryable: true,
      retryAfter: 5,
    });
    expect(submit).toHaveBeenCalledTimes(NO_DELAY.maxAttempts + 1);
  });

  it("does not retry a clash with another spend", async () => {
    submit.mockRejectedValue(new Error("Rejected transaction: double spend"));
    await expect(relaySignedTransaction(tx(), "testnet-10", NO_DELAY)).rejects.toMatchObject({
      type: "conflict",
    });
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
