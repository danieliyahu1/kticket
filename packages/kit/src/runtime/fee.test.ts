import { describe, expect, it } from "vitest";
import { computeFee, computeMass, FeeError, relayFloor, requiredInput } from "./fee";

describe("fee computation (HLD §2.2)", () => {
  it("fee = feerate × mass when the estimate is above the relay floor", () => {
    // mass 1000g, feerate 200 sompi/g -> 200_000 sompi; floor 100 × max(1000, 2×500) = 100_000
    const r = computeFee({
      mass: 1000,
      sizeBytes: 500,
      feerateSompiPerGram: 200,
      inputTotal: 100_000_000,
      payouts: [100],
    });
    expect(r.fee).toBe(200_000);
    expect(r.floor).toBe(100_000);
    expect(r.change).toBe(100_000_000 - 100 - 200_000);
  });

  it("enforces the 100 sompi × max(compute grams, 2×tx bytes) floor", () => {
    // estimate 1×100 = 100 sompi; floor 100 × max(100, 2000) = 200_000 -> fee = 200_000
    const r = computeFee({
      mass: 100,
      sizeBytes: 1000,
      feerateSompiPerGram: 1,
      inputTotal: 100_000_000,
      payouts: [],
    });
    expect(r.floor).toBe(100 * Math.max(100, 2 * 1000));
    expect(r.fee).toBe(r.floor);
  });

  it("change = sum(inputs) − payouts − fee (the inputs−outputs gap IS the fee)", () => {
    const r = computeFee({
      mass: 100_000,
      sizeBytes: 400,
      feerateSompiPerGram: 300,
      inputTotal: 100_000_000,
      payouts: [1_000, 2_000],
    });
    expect(r.change).toBe(100_000_000 - 3_000 - r.fee);
  });

  it("a 0-fee estimate is lifted to the relay floor (0-fee tx never relays)", () => {
    // feerate 0 → estimated fee 0, but floor > 0 → fee forced to floor.
    const r = computeFee({
      mass: 100,
      sizeBytes: 100,
      feerateSompiPerGram: 0,
      inputTotal: 100_000_000,
      payouts: [],
    });
    expect(r.fee).toBeGreaterThan(0);
    expect(r.fee).toBe(r.floor);
  });

  it("rejects inputs that cannot cover payouts + fee", () => {
    expect(() =>
      computeFee({
        mass: 100,
        sizeBytes: 100,
        feerateSompiPerGram: 1,
        inputTotal: 10,
        payouts: [100],
      }),
    ).toThrow(FeeError);
  });

  it("rejects malformed inputs", () => {
    expect(() =>
      computeFee({ mass: -1, sizeBytes: 10, feerateSompiPerGram: 1, inputTotal: 100, payouts: [] }),
    ).toThrow(FeeError);
    expect(() =>
      computeFee({
        mass: 10,
        sizeBytes: 10,
        feerateSompiPerGram: 1,
        inputTotal: 100,
        payouts: [-5],
      }),
    ).toThrow(FeeError);
  });

  it("computeMass and requiredInput helpers", () => {
    expect(computeMass(500)).toBe(500);
    expect(requiredInput([100, 200], 50)).toBe(350);
  });

  it("relayFloor uses max(compute grams, 2×tx bytes)", () => {
    expect(relayFloor({ mass: 300, sizeBytes: 100 })).toBe(100 * Math.max(300, 200));
    expect(relayFloor({ mass: 100, sizeBytes: 1000 })).toBe(100 * 2000);
  });
});
