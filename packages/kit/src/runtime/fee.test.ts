import { describe, expect, it } from "vitest";
import { computeFee, computeMass, FeeError, relayFloor, requiredInput } from "./fee";

const INPUT_TOTAL = 100_000_000;
const PAYOUT_100 = 100;
const PAYOUT_1000 = 1_000;
const PAYOUT_2000 = 2_000;
const TOTAL_PAYOUTS_3000 = 3_000;
const NEGATIVE_PAYOUT = -5;
const MASS_500 = 500;
const MASS_100 = 100;
const MASS_300 = 300;
const BYTES_100 = 100;
const BYTES_200 = 200;
const BYTES_1000 = 1000;
const BYTES_2000 = 2000;
const RELAY_FEERATE = 100;
const FEE_200_000 = 200_000;
const FLOOR_100_000 = 100_000;
const REQUIRED_INPUT_A = 100;
const REQUIRED_INPUT_B = 200;
const REQUIRED_AMOUNT = 50;
const REQUIRED_TOTAL = 350;

describe("fee = feerate × mass (HLD §2.2)", () => {
  it("fee = feerate × mass when the estimate is above the relay floor", () => {
    // mass 1000g, feerate 200 sompi/g -> 200_000 sompi; floor 100 × max(1000, 2×500) = 100_000
    const r = computeFee({
      mass: 1000,
      sizeBytes: 500,
      feerateSompiPerGram: 200,
      inputTotal: INPUT_TOTAL,
      payouts: [PAYOUT_100],
    });
    expect(r.fee).toBe(FEE_200_000);
    expect(r.floor).toBe(FLOOR_100_000);
    expect(r.change).toBe(INPUT_TOTAL - PAYOUT_100 - FEE_200_000);
  });
});

describe("relay floor (HLD §2.2)", () => {
  it("enforces the 100 sompi × max(compute grams, 2×tx bytes) floor", () => {
    // estimate 1×100 = 100 sompi; floor 100 × max(100, 2000) = 200_000 -> fee = 200_000
    const r = computeFee({
      mass: MASS_100,
      sizeBytes: BYTES_1000,
      feerateSompiPerGram: 1,
      inputTotal: INPUT_TOTAL,
      payouts: [],
    });
    expect(r.floor).toBe(RELAY_FEERATE * Math.max(MASS_100, 2 * BYTES_1000));
    expect(r.fee).toBe(r.floor);
  });

  it("relayFloor uses max(compute grams, 2×tx bytes)", () => {
    expect(relayFloor({ mass: MASS_300, sizeBytes: BYTES_100 })).toBe(
      RELAY_FEERATE * Math.max(MASS_300, BYTES_200),
    );
    expect(relayFloor({ mass: MASS_100, sizeBytes: BYTES_1000 })).toBe(RELAY_FEERATE * BYTES_2000);
  });
});

describe("change = inputs − payouts − fee (HLD §2.2)", () => {
  it("change = sum(inputs) − payouts − fee (the inputs−outputs gap IS the fee)", () => {
    const r = computeFee({
      mass: 100_000,
      sizeBytes: 400,
      feerateSompiPerGram: 300,
      inputTotal: INPUT_TOTAL,
      payouts: [PAYOUT_1000, PAYOUT_2000],
    });
    expect(r.change).toBe(INPUT_TOTAL - TOTAL_PAYOUTS_3000 - r.fee);
  });
});

describe("relay floor lifts a 0-fee estimate", () => {
  it("a 0-fee estimate is lifted to the relay floor (0-fee tx never relays)", () => {
    // feerate 0 → estimated fee 0, but floor > 0 → fee forced to floor.
    const r = computeFee({
      mass: 100,
      sizeBytes: 100,
      feerateSompiPerGram: 0,
      inputTotal: INPUT_TOTAL,
      payouts: [],
    });
    expect(r.fee).toBeGreaterThan(0);
    expect(r.fee).toBe(r.floor);
  });
});

describe("invalid fee inputs", () => {
  it("rejects inputs that cannot cover payouts + fee", () => {
    expect(() =>
      computeFee({
        mass: 100,
        sizeBytes: 100,
        feerateSompiPerGram: 1,
        inputTotal: 10,
        payouts: [PAYOUT_100],
      }),
    ).toThrow(FeeError);
  });

  it("rejects malformed inputs", () => {
    expect(() =>
      computeFee({
        mass: -1,
        sizeBytes: 10,
        feerateSompiPerGram: 1,
        inputTotal: 100,
        payouts: [],
      }),
    ).toThrow(FeeError);
    expect(() =>
      computeFee({
        mass: 10,
        sizeBytes: 10,
        feerateSompiPerGram: 1,
        inputTotal: 100,
        payouts: [NEGATIVE_PAYOUT],
      }),
    ).toThrow(FeeError);
  });
});

describe("fee helpers", () => {
  it("computeMass and requiredInput helpers", () => {
    expect(computeMass(MASS_500)).toBe(MASS_500);
    expect(requiredInput([REQUIRED_INPUT_A, REQUIRED_INPUT_B], REQUIRED_AMOUNT)).toBe(
      REQUIRED_TOTAL,
    );
  });
});
