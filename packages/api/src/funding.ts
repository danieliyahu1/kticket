// Buyer funding selection for covenant transactions.
//
// Two network rules constrain the choice:
//   1. The covenant scans at most `MAX_ITEMS` inputs, so a buy can join only a
//      bounded number of buyer UTXOs.
//   2. KIP-9 storage mass is `C / amount` per output, so a dust change output
//      makes the transaction invalid. The selection therefore stops only when
//      the change is zero or above the dust floor.

import { MIN_CHANGE_SOMPI } from "@kticket/kit";
import { policyError } from "./errors.js";
import type { UtxoResponse } from "./kaspa-types.js";

export function selectFundingUtxos(
  utxos: readonly UtxoResponse[],
  required: number,
  maxInputs: number,
): UtxoResponse[] {
  const selected: UtxoResponse[] = [];
  let covered = 0;
  for (const utxo of utxos) {
    if (selected.length >= maxInputs) break;
    if (covered >= required && leavesCleanChange(covered, required)) break;
    selected.push(utxo);
    covered += Number(utxo.utxoEntry.amount);
  }
  if (covered < required) {
    throw policyError("You don't have enough funds to buy this ticket.", {
      covered,
      required,
      maxInputs,
    });
  }
  if (!leavesCleanChange(covered, required)) {
    throw policyError(
      "The selected funds would leave too small a change. Add funds or use a different coin.",
      { change: covered - required, minimum: MIN_CHANGE_SOMPI },
    );
  }
  return selected;
}

/** True when the leftover is either nothing or large enough not to be dust. */
function leavesCleanChange(covered: number, required: number): boolean {
  const change = covered - required;
  return change === 0 || change >= MIN_CHANGE_SOMPI;
}
