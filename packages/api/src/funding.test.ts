import { describe, expect, it } from "vitest";
import { MIN_CHANGE_SOMPI } from "@kticket/kit";
import { selectFundingUtxos } from "./funding";
import type { UtxoResponse } from "./kaspa-types";

const REQUIRED = 100_000_000; // 1 KAS

function utxo(amount: number, index = 0): UtxoResponse {
  return {
    outpoint: { transactionId: "aa".repeat(32), index },
    utxoEntry: {
      amount: String(amount),
      scriptPublicKey: { scriptPublicKey: "51" },
      blockDaaScore: "0",
      isCoinbase: false,
    },
  };
}

describe("selectFundingUtxos", () => {
  it("takes the fewest largest UTXOs that cover the amount", () => {
    const selected = selectFundingUtxos(
      [utxo(500_000_000), utxo(100_000_000, 1)],
      REQUIRED,
      7,
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]?.utxoEntry.amount).toBe("500000000");
  });

  it("extends the selection when the first change would be dust", () => {
    // 1 sompi of change is dust, so the next UTXO joins the transaction.
    const selected = selectFundingUtxos(
      [utxo(REQUIRED + 1), utxo(MIN_CHANGE_SOMPI, 1)],
      REQUIRED,
      7,
    );
    expect(selected).toHaveLength(2);
  });

  it("rejects a dust change when no further UTXO is available", () => {
    expect(() => selectFundingUtxos([utxo(REQUIRED + 1)], REQUIRED, 7)).toThrow(
      /too small a change/,
    );
  });

  it("rejects when the funding cannot cover the amount", () => {
    expect(() => selectFundingUtxos([utxo(REQUIRED - 1)], REQUIRED, 7)).toThrow(
      /enough funds/,
    );
  });

  it("stops at the input cap", () => {
    const halves = Array.from({ length: 10 }, (_, index) =>
      utxo(REQUIRED / 2 - 1, index),
    );
    expect(() => selectFundingUtxos(halves, REQUIRED, 2)).toThrow(/enough funds/);
  });
});
