import { describe, expect, it } from "vitest";
import { describeWalletSignatures } from "./flow.js";
import type { WireTransaction } from "./wire.js";

const TXID_A = "aa".repeat(32);
const TXID_B = "bb".repeat(32);

function template(): WireTransaction {
  return {
    version: 0,
    lock_time: 0,
    inputs: [
      { previous_outpoint: { transaction_id: TXID_A, index: 0 }, sequence: 0, sig_op_count: 1 },
      { previous_outpoint: { transaction_id: TXID_B, index: 1 }, sequence: 0, sig_op_count: 1 },
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
