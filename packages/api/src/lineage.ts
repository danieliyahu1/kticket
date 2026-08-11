// Covenant lineage walk helpers, shared by the event availability walk and any
// future ticket reader. Both derive the successor of a covenant output the same
// way: find the transaction that spends the outpoint, then the continuation
// output it authorizes.

import type { TxInput, TxModel, TxOutput } from "./kaspa-types.js";

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

/**
 * The covenant continuation output a spend authorizes: the output bound to the
 * same authorizing input. Buy and handover each produce exactly one such
 * output (the ticket or burn successor); the change output is not a covenant.
 */
export function findSuccessor(tx: TxModel, spent: TxInput): TxOutput | undefined {
  const covenants = (tx.outputs ?? []).filter((o) => o.covenant_authorizing_input != null);
  if (covenants.length === 0) return undefined;
  const byInput = covenants.find((o) => o.covenant_authorizing_input === spent.index);
  if (byInput) return byInput;
  return covenants.length === 1 ? covenants[0] : undefined;
}
