// Event availability (KTK-89 — GET /v1/events/{covenant_id}).
//
// The blockDAG stores only `P2SH(blake3(redeem_script))`, not the decoded
// preimage, so there is no on-chain index to discover events from. Availability
// (sold/left) is derived from the event covenant's `remaining` state by walking
// its spend lineage: each mint (buy) spends the event covenant and re-creates it
// with `remaining − 1`, so the walk reconstructs each successor's script hash
// and counts until a live covenant output is found.
//
// This module is stateless: it consumes a `VerifiedEvent` (produced by
// `verifyEventFromChain`) and never reads rich fields from the identifier
// registry — the chain is the source of truth.

import { addressFromScriptHash, type KaspaNetwork } from "@kticket/kit";
import { invalidError } from "./errors.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import { findSpend, type OutpointRef } from "./lineage.js";
import { MAX_LINEAGE_DEPTH } from "./reader.js";
import { eventScriptFor, type VerifiedEvent } from "./provenance.js";
import { P2SH_SCRIPT } from "./validate.js";

export interface Availability {
  capacity: number;
  sold: number;
  left: number;
  event_txid: string;
  event_index: number;
  event_address: string;
  event_covenant_id: string;
}

type AvailabilityWalkOutcome =
  | { done: true; left: number }
  | { done: false; address: string; outpoint: OutpointRef; nextRemaining: number };

async function advanceAvailabilityWalk(
  kaspa: KaspaClientLike,
  network: KaspaNetwork,
  verified: VerifiedEvent,
  address: string,
  outpoint: OutpointRef,
  remaining: number,
): Promise<AvailabilityWalkOutcome> {
  const utxos = await kaspa.getUtxos(address);
  if (utxos.length > 0) return { done: true, left: remaining };

  const txs = await kaspa.getFullTransactions(address);
  const spender = findSpend(txs, outpoint);
  if (!spender) return { done: true, left: remaining };

  const expected = eventScriptFor(verified.artifact, verified.owner_pkh, remaining - 1);
  const successor = (spender.tx.outputs ?? []).find(
    (o) => o.script_public_key?.toLowerCase() === expected,
  );
  if (!successor) return { done: true, left: remaining };

  return {
    done: false,
    address: addressFromScriptHash(successor.script_public_key as string, network),
    outpoint: { transactionId: spender.tx.transaction_id, index: successor.index },
    nextRemaining: remaining - 1,
  };
}

export async function eventAvailability(
  verified: VerifiedEvent,
  kaspa: KaspaClientLike,
  network: KaspaNetwork,
): Promise<Availability> {
  const deploy = await kaspa.getTransaction(verified.deploy_txid);
  if (!deploy) {
    throw invalidError(`deploy transaction ${verified.deploy_txid} not found on chain`);
  }

  const output = deploy.outputs?.[0];
  const spk = output?.script_public_key;
  if (typeof spk !== "string" || !P2SH_SCRIPT.test(spk)) {
    throw invalidError(`deploy transaction ${verified.deploy_txid} has no covenant output`);
  }

  let remaining = verified.capacity;
  let address = addressFromScriptHash(spk, network);
  let outpoint: OutpointRef = { transactionId: verified.deploy_txid, index: 0 };

  for (let depth = 0; depth <= MAX_LINEAGE_DEPTH; depth++) {
    const outcome = await advanceAvailabilityWalk(
      kaspa,
      network,
      verified,
      address,
      outpoint,
      remaining,
    );
    if (outcome.done) {
      remaining = outcome.left;
      break;
    }
    remaining = outcome.nextRemaining;
    address = outcome.address;
    outpoint = outcome.outpoint;
  }

  return {
    capacity: verified.capacity,
    sold: verified.capacity - remaining,
    left: remaining,
    event_txid: outpoint.transactionId.toLowerCase(),
    event_index: outpoint.index,
    event_address: address,
    event_covenant_id: verified.covenant_id,
  };
}
