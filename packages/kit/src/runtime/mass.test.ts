import { describe, expect, it } from "vitest";
import {
  computeMass,
  MAX_STORAGE_MASS,
  type MassInput,
  storageMassOf,
  utxoPlurality,
} from "./mass";
import type { TxOutput, UnsignedTransaction } from "./tx";

const P2PK = `20${"11".repeat(32)}ac`; // 34-byte script
const P2SH = `aa20${"22".repeat(32)}87`; // 35-byte covenant script
const KAS = 100_000_000;

const COVENANT = { authorizingInput: 0, covenantId: "33".repeat(32) };
const SIG_OP_COUNT = 50;

function output(value: number, script: string, covenant = false): TxOutput {
  return {
    value,
    scriptPublicKey: { version: 0, script },
    covenant: covenant ? COVENANT : null,
  };
}

function input(value: number, script: string, covenant: boolean): MassInput {
  return { value, script, covenant };
}

function buyTx(change: number): UnsignedTransaction {
  return {
    version: 1,
    inputs: [
      {
        previousOutpoint: { txId: "aa".repeat(32), index: 0 },
        signatureScript: "",
        sequence: 0,
        sigOpCount: SIG_OP_COUNT,
      },
      {
        previousOutpoint: { txId: "bb".repeat(32), index: 0 },
        signatureScript: "",
        sequence: 0,
        sigOpCount: SIG_OP_COUNT,
      },
    ],
    outputs: [
      output(KAS / 2, P2SH, true),
      output(KAS / 2, P2SH, true),
      output(10 * KAS - KAS / 2, P2PK),
      ...(change > 0 ? [output(change, P2PK)] : []),
    ],
    lockTime: 0,
  };
}

const BUY_INPUTS: MassInput[] = [
  input(KAS / 2, P2SH, true),
  input(10 * KAS, P2PK, false),
];

describe("utxoPlurality", () => {
  it("is 1 for a standard P2PK output", () => {
    expect(utxoPlurality(P2PK, false)).toBe(1);
  });

  it("is 2 for a covenant P2SH output", () => {
    expect(utxoPlurality(P2SH, true)).toBe(2);
  });
});

describe("computeMass (KIP-9)", () => {
  it("prices the transaction on its storage mass when that dominates", () => {
    const mass = computeMass(buyTx(0), BUY_INPUTS);

    // Two 0.5 KAS covenant outputs dominate the harmonic term; the inputs are
    // 0.5 KAS + 10 KAS, so the arithmetic-mean input term is small.
    expect(mass.storageMass).toBe(152_481);
    expect(mass.computeMass).toBe(11_528);
    expect(mass.transientMass).toBe(1_712);
    expect(mass.mass).toBe(mass.storageMass);
  });

  it("keeps a clean change well under the mempool lane limit", () => {
    expect(storageMassOf(buyTx(5_000_000), BUY_INPUTS)).toBeLessThan(
      MAX_STORAGE_MASS,
    );
  });

  it("makes a dust change exceed the mempool lane limit", () => {
    expect(storageMassOf(buyTx(1_000), BUY_INPUTS)).toBeGreaterThan(
      MAX_STORAGE_MASS,
    );
  });

  it("rejects non-positive amounts instead of dividing by zero", () => {
    expect(() => storageMassOf(buyTx(1), [...BUY_INPUTS, input(0, P2PK, false)])).toThrow(
      /positive integer/,
    );
  });
});
