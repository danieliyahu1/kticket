// KIP-9 mass model, mirroring rusty-kaspa `consensus/core/src/mass/mod.rs`.
//
// The node prices a transaction on its *effective* mass:
//
//   compute   = size + 10·spk bytes + 100·Σ compute budget   (v1)
//   transient = 4·size
//   storage   = C·(Σ p²/amount_out − input term),  C = 10^12
//
// and rejects a transaction whose storage mass exceeds the mempool lane limit.
// A dust output is therefore not just expensive — it makes the transaction
// invalid, which is why the builder has to keep change either zero or above a
// floor.

import { decodeSigOpCount, estimatedSerializedSize } from "./serialize.js";
import type { UnsignedTransaction } from "./tx.js";

const HASH_BYTES = 32;
const STORAGE_UNIT_BYTES = 100;
/** Fixed bytes of a UTXO entry, excluding its script (KIP-9). */
const UTXO_CONST_BYTES = 63;

const MASS_PER_TX_BYTE = 1;
const MASS_PER_SCRIPT_PUB_KEY_BYTE = 10;
const GRAMS_PER_COMPUTE_BUDGET_UNIT = 100;
const GRAMS_PER_SIGOP = 1_000;
const TRANSIENT_BYTE_TO_MASS_FACTOR = 4;

/** KIP-9 storm parameter: 10,000 KAS in sompi. */
const STORAGE_MASS_PARAMETER = 100_000_000 * 10_000;

/** The mempool lane limit (`BlockMassLimits::with_shared_limit(500_000)`). */
export const MAX_STORAGE_MASS = 500_000;

/** A previous output the transaction spends, as the mass model needs it. */
export interface MassInput {
  /** Previous-output value in sompi. */
  value: number;
  /** Previous-output script, hex, without the 2-byte version prefix. */
  script: string;
  /** True when the previous output carries a covenant binding. */
  covenant: boolean;
}

export interface MassBreakdown {
  /** What the node prices: `max(compute, transient, storage)`. */
  mass: number;
  computeMass: number;
  transientMass: number;
  storageMass: number;
}

interface UtxoCell {
  plurality: number;
  amount: number;
}

/**
 * How many 100-byte storage units a UTXO occupies. Standard P2PK outputs are
 * 1; covenant outputs add the 32-byte covenant id and usually become 2.
 */
export function utxoPlurality(scriptHex: string, covenant: boolean): number {
  const bytes =
    UTXO_CONST_BYTES + scriptHex.length / 2 + (covenant ? HASH_BYTES : 0);
  return Math.ceil(bytes / STORAGE_UNIT_BYTES);
}

export function computeMass(
  tx: UnsignedTransaction,
  inputs: readonly MassInput[],
): MassBreakdown {
  const size = estimatedSerializedSize(tx);
  const compute = computeMassOf(tx, size);
  const transient = size * TRANSIENT_BYTE_TO_MASS_FACTOR;
  const storage = storageMassOf(tx, inputs);
  return {
    mass: Math.max(compute, transient, storage),
    computeMass: compute,
    transientMass: transient,
    storageMass: storage,
  };
}

function computeMassOf(tx: UnsignedTransaction, size: number): number {
  const sizeMass = size * MASS_PER_TX_BYTE;
  const spkMass =
    MASS_PER_SCRIPT_PUB_KEY_BYTE *
    tx.outputs.reduce(
      (total, output) => total + 2 + output.scriptPublicKey.script.length / 2,
      0,
    );
  const scriptMass =
    tx.version >= 1
      ? GRAMS_PER_COMPUTE_BUDGET_UNIT * sum(tx.inputs.map((input) => input.sigOpCount))
      : GRAMS_PER_SIGOP *
        sum(tx.inputs.map((input) => decodeSigOpCount(tx.version, input.sigOpCount)));
  return sizeMass + spkMass + scriptMass;
}

export function storageMassOf(
  tx: UnsignedTransaction,
  inputs: readonly MassInput[],
): number {
  const outputs = tx.outputs.map((output) => ({
    plurality: utxoPlurality(
      output.scriptPublicKey.script,
      output.covenant !== null,
    ),
    amount: output.value,
  }));
  const inputCells = inputs.map((input) => ({
    plurality: utxoPlurality(input.script, input.covenant),
    amount: input.value,
  }));
  assertPositiveAmounts([...outputs, ...inputCells]);

  const harmonicOut = sum(outputs.map(harmonicTerm));
  return Math.max(0, harmonicOut - inputStorageTerm(inputCells, outputs));
}

/**
 * KIP-9's input side. For one output, one input, or a 2-in/2-out transaction
 * the harmonic form applies; otherwise the network uses the arithmetic mean.
 */
function inputStorageTerm(
  inputs: readonly UtxoCell[],
  outputs: readonly UtxoCell[],
): number {
  const outputPlurality = sum(outputs.map((cell) => cell.plurality));
  const inputPlurality = sum(inputs.map((cell) => cell.plurality));
  const useHarmonic =
    outputPlurality === 1 ||
    (inputs.length <= 2 &&
      (inputPlurality === 1 ||
        (outputPlurality === 2 && inputPlurality === 2)));
  if (useHarmonic) {
    return sum(inputs.map(harmonicTerm));
  }
  const total = sum(inputs.map((cell) => cell.amount));
  const mean = Math.max(1, Math.floor(total / inputPlurality));
  return inputPlurality * Math.floor(STORAGE_MASS_PARAMETER / mean);
}

function harmonicTerm(cell: UtxoCell): number {
  return Math.floor(
    (STORAGE_MASS_PARAMETER * cell.plurality * cell.plurality) / cell.amount,
  );
}

function assertPositiveAmounts(cells: readonly UtxoCell[]): void {
  for (const cell of cells) {
    if (!Number.isSafeInteger(cell.amount) || cell.amount <= 0) {
      throw new Error(
        `mass: every UTXO amount must be a positive integer, got ${cell.amount}`,
      );
    }
  }
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
