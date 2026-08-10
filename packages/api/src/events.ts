// Events directory + availability (HLD v0.22 §2.2 — GET /v1/events,
// GET /v1/events/{covenant_id}).
//
// The blockDAG stores only `P2SH(blake3(redeem_script))`, not the decoded
// preimage, so there is no on-chain index to discover events from. The events
// directory is therefore a file-backed store of known events (the deploy the
// organizer created). Availability (sold/left) is derived from the event
// covenant's `remaining` state by walking its spend lineage: each mint (buy)
// spends the event covenant and re-creates it with `remaining − 1`, so the walk
// reconstructs each successor's script hash and counts until a live covenant
// output is found.
//
// NOTE: The route parameter is now the event's `covenant_id` (KIP-20 family
// id), not the `authorizing_txid`. The `event_id` of old routes is retired.

import {
  addressFromScriptHash,
  covenantId,
  type KaspaNetwork,
  MAX_EVENT_CAPACITY,
  p2shScript,
} from "@kticket/kit";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { compileEventArtifact, eventScript } from "./compiler.js";
import { invalidError } from "./errors.js";
import type { StoredEventInternal } from "./eventstore.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import { findSpend, type OutpointRef } from "./lineage.js";
import { MAX_LINEAGE_DEPTH } from "./reader.js";
import { HEX64, hex, hex64, isRecord, P2SH_SCRIPT, str, uint } from "./validate.js";

export interface Availability {
  capacity: number;
  sold: number;
  left: number;
  event_txid: string;
  event_index: number;
  event_address: string;
  event_covenant_id: string;
}

function eventCovenantScriptHash(event: StoredEventInternal, remaining: number): string {
  const artifact = compileEventArtifact({
    authorizingTxId: event.authorizingTxId,
    price: event.price,
    orgSpk: event.orgSpk,
    burnTemplateHash: event.burnTemplateHash,
  });
  return eventScript(artifact, { owner: event.orgPkh, amount: remaining }).script;
}

type AvailabilityWalkOutcome =
  | { done: true; left: number }
  | { done: false; address: string; outpoint: OutpointRef; nextRemaining: number };

async function advanceAvailabilityWalk(
  kaspa: KaspaClientLike,
  network: KaspaNetwork,
  event: StoredEventInternal,
  address: string,
  outpoint: OutpointRef,
  remaining: number,
): Promise<AvailabilityWalkOutcome> {
  const utxos = await kaspa.getUtxos(address);
  if (utxos.length > 0) return { done: true, left: remaining };

  const txs = await kaspa.getFullTransactions(address);
  const spender = findSpend(txs, outpoint);
  if (!spender) return { done: true, left: remaining };

  const expected = eventCovenantScriptHash(event, remaining - 1);
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
  event: StoredEventInternal,
  kaspa: KaspaClientLike,
  network: KaspaNetwork,
): Promise<Availability> {
  const deploy = await kaspa.getTransaction(event.genesisTxId);
  if (!deploy) {
    throw invalidError(`deploy transaction ${event.genesisTxId} not found on chain`);
  }

  const output = deploy.outputs?.[0];
  const spk = output?.script_public_key;
  if (typeof spk !== "string" || !(HEX64.test(spk) || P2SH_SCRIPT.test(spk))) {
    throw invalidError(`deploy transaction ${event.genesisTxId} has no covenant output`);
  }

  let remaining = event.capacity;
  let address = addressFromScriptHash(spk, network);
  let outpoint: OutpointRef = { transactionId: event.genesisTxId, index: 0 };

  for (let depth = 0; depth <= MAX_LINEAGE_DEPTH; depth++) {
    const outcome = await advanceAvailabilityWalk(
      kaspa,
      network,
      event,
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

  const artifact = compileEventArtifact({
    authorizingTxId: event.authorizingTxId,
    price: event.price,
    orgSpk: event.orgSpk,
    burnTemplateHash: event.burnTemplateHash,
  });

  const eventCovenantId = bytesToHex(
    covenantId(
      { txId: hexToBytes(event.genesisTxId), index: 0 },
      [
        {
          index: 0,
          value: 0,
          version: 0,
          script: hexToBytes(eventScript(artifact, { owner: event.orgPkh, amount: event.capacity }).script),
        },
      ],
    ),
  );

  return {
    capacity: event.capacity,
    sold: event.capacity - remaining,
    left: remaining,
    event_txid: outpoint.transactionId.toLowerCase(),
    event_index: outpoint.index,
    event_address: address,
    event_covenant_id: eventCovenantId,
  };
}

export interface RegisterEventPayload {
  genesisTxId: string;
  orgPkh: string;
  name: string;
  date: string;
  price: number;
  capacity: number;
  orgSpk: string;
  burnTemplateHash: string;
  authorizingTxId: string;
}

export function parseRegisterEventBody(raw: unknown): RegisterEventPayload {
  if (!isRecord(raw)) {
    throw invalidError("request body must be an object");
  }
  const genesisTxId = hex64(raw.genesis_txid, "genesis_txid");
  const orgPkh = hex64(raw.org_pkh, "org_pkh");
  const name = str(raw.name, "name");
  const date = str(raw.date, "date");
  const price = num(raw.price, "price");
  const capacity = uint(raw.capacity, "capacity");
  if (capacity > MAX_EVENT_CAPACITY) {
    throw invalidError(`capacity must be an integer 0..${MAX_EVENT_CAPACITY}`);
  }
  const orgSpk = hex(raw.org_spk, "org_spk");
  const burnTemplateHash = hex64(raw.burn_template_hash, "burn_template_hash");
  const authorizingTxId = hex64(raw.authorizing_txid, "authorizing_txid");

  return { genesisTxId, orgPkh, name, date, price, capacity, orgSpk, burnTemplateHash, authorizingTxId };
}

function num(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw invalidError(`${label} must be a non-negative number`);
  }
  return n;
}
