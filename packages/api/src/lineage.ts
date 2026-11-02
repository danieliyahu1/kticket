// Covenant lineage walk helpers, shared by the event availability walk and any
// future ticket reader: find the transaction that spends an outpoint.

import type { TxInput, TxModel } from "./kaspa-types.js";

/** Max covenant lineage hops a walk follows before giving up. */
export const MAX_LINEAGE_DEPTH = 16;

export interface OutpointRef {
  transactionId: string;
  index: number;
}

export interface SpendRef {
  tx: TxModel;
  input: TxInput;
}

/** Find the first transaction (in a full-transaction list) that spends `outpoint`. */
export function findSpend(txs: readonly TxModel[], outpoint: OutpointRef): SpendRef | undefined {
  for (const tx of txs) {
    for (const input of tx.inputs ?? []) {
      if (references(input, outpoint)) return { tx, input };
    }
  }
  return undefined;
}

function references(input: TxInput, outpoint: OutpointRef): boolean {
  return (
    input.previous_outpoint_hash?.toLowerCase() === outpoint.transactionId.toLowerCase() &&
    Number(input.previous_outpoint_index) === outpoint.index
  );
}
