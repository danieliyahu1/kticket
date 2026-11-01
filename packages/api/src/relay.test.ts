import { beforeEach, describe, expect, it, vi } from "vitest";
import { relaySignedTransaction } from "./relay.js";
import type { WireTransaction } from "./wire.js";

const TXID = "ab".repeat(32);

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
    await expect(relaySignedTransaction(tx(), "testnet-10")).resolves.toBe(TXID);
  });

  it("reports a clash with another spend as a conflict", async () => {
    submit.mockRejectedValue(new Error("Rejected transaction: double spend"));
    await expect(relaySignedTransaction(tx(), "testnet-10")).rejects.toMatchObject({
      type: "conflict",
    });
  });
});
