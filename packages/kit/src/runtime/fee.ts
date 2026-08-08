// Fee computation for kticket transactions (HLD v0.21 §2.2 "Fees").
//
// Kaspa has no fee field — the fee is `sum(inputs) - sum(outputs)`. The kit
// computes the fee from the transaction mass and the current fee estimate:
//
//   fee      = feerate (sompi/gram, priority bucket) × mass (grams)
//   floor    = 100 sompi × max(compute grams, 2 × tx bytes)
//   fee      = max(fee, floor)   (a 0-fee tx is consensus-valid but never relayed)
//   change   = sum(inputs) − payouts − fee
//
// Mass and feerate come from the network (`POST /transactions/mass` and
// `GET /info/fee-estimate`); this module is the pure, testable math around them.

export class FeeError extends Error {
  override readonly name = "FeeError";
}

export interface MassAndSize {
  /** Mass in grams as reported by the node's mass estimator. */
  mass: number;
  /** Serialized transaction size in bytes (for the relay floor). */
  sizeBytes: number;
}

/** The `compute` mass component of the relay floor. */
export function computeMass(computeGrams: number): number {
  if (!Number.isSafeInteger(computeGrams) || computeGrams < 0) {
    throw new FeeError(`compute grams ${computeGrams} is invalid`);
  }
  return computeGrams;
}

const RELAY_FLOOR_SOMPI = 100;

/** Relay floor: 100 sompi × max(compute grams, 2 × tx bytes). */
export function relayFloor(massAndSize: MassAndSize): number {
  const bound = Math.max(massAndSize.mass, 2 * massAndSize.sizeBytes);
  return RELAY_FLOOR_SOMPI * bound;
}

export interface FeeInput {
  mass: number;
  sizeBytes: number;
  /** Feerate in sompi/gram for the chosen priority bucket. */
  feerateSompiPerGram: number;
  /** Total value of the inputs that cover the fee (and any payouts). */
  inputTotal: number;
  /** Non-change output values, e.g. the organizer payout on a buy. */
  payouts: readonly number[];
  /**
   * The `compute` mass component of the relay floor (grams). Defaults to `mass`.
   * The build endpoint passes `compute_mass` from the mass endpoint — the floor
   * is `100 sompi × max(compute grams, 2 × tx bytes)`.
   */
  computeMass?: number;
}

export interface FeeResult {
  fee: number;
  change: number;
  floor: number;
}

/**
 * Compute `fee` and the change output for a transaction.
 *
 * - fee = max(feerate × mass, relayFloor)
 * - change = inputTotal − sum(payouts) − fee
 *
 * Throws `FeeError` (policy) when inputs cannot cover the payouts + fee.
 */
export function computeFee(input: FeeInput): FeeResult {
  if (!Number.isSafeInteger(input.mass) || input.mass < 0) {
    throw new FeeError(`mass ${input.mass} is invalid`);
  }
  if (!Number.isSafeInteger(input.feerateSompiPerGram) || input.feerateSompiPerGram < 0) {
    throw new FeeError(`feerate ${input.feerateSompiPerGram} is invalid`);
  }
  if (!Number.isSafeInteger(input.inputTotal) || input.inputTotal < 0) {
    throw new FeeError(`input total ${input.inputTotal} is invalid`);
  }
  const payoutsTotal = input.payouts.reduce((acc, value) => {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new FeeError(`payout ${value} is invalid`);
    }
    return acc + value;
  }, 0);

  const floor = relayFloor({
    mass: input.computeMass ?? input.mass,
    sizeBytes: input.sizeBytes,
  });
  const estimated = input.feerateSompiPerGram * input.mass;
  const fee = Math.max(estimated, floor);

  const change = input.inputTotal - payoutsTotal - fee;
  if (change < 0) {
    throw new FeeError(
      `inputs ${input.inputTotal} cannot cover payouts ${payoutsTotal} + fee ${fee}`,
    );
  }

  return { fee, change, floor };
}

/** Total value an organizer/buyer must supply so that payouts + fee are covered. */
export function requiredInput(payouts: readonly number[], fee: number): number {
  return payouts.reduce((acc, value) => acc + value, 0) + fee;
}
