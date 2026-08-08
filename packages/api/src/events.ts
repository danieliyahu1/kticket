// Events directory + availability (HLD v0.22 §2.2 — GET /v1/events,
// GET /v1/events/{event_id}).
//
// The blockDAG stores only `P2SH(blake3(redeem_script))`, not the decoded
// preimage, so there is no on-chain index to discover events from. The events
// directory is therefore a config-supplied registry of known events (the
// deploy the organizer created). Availability (sold/left) is derived from the
// event covenant's `remaining` state by walking its spend lineage: each mint
// (buy) spends the event covenant and re-creates it with `remaining − 1`, so
// the walk reconstructs each successor's script hash and counts until a live
// covenant output is found.

import {
  addressFromScriptHash,
  buildRedeemScript,
  covenantId,
  type DecodedConstants,
  EVENT_ARTIFACT,
  type KaspaNetwork,
  MAX_EVENT_CAPACITY,
  p2shScript,
} from "@kticket/kit";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import { invalidError } from "./errors.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import { findSpend, type OutpointRef } from "./lineage.js";
import { MAX_LINEAGE_DEPTH } from "./reader.js";
import { HEX64, hex, hex64, isRecord, P2SH_SCRIPT, str, uint } from "./validate.js";

export interface RegisteredEvent {
  /** Event id as a 64-hex string (the deploy constants' `event_id`). */
  eventId: string;
  /** The event's deploy transaction id (64-hex). */
  genesisTxId: string;
  /** Organizer 32-byte identifier hex (pubkey) — the event covenant's owner. */
  orgPkh: string;
  /** The deploy constants' `org_spk` (organizer payout script), hex. */
  orgSpk: string;
  /** The deploy constants' `burn_template_hash` (burn-owner script hash), 64-hex. */
  burnTemplateHash: string;
  name: string;
  date: string;
  price: number;
  capacity: number;
}

/** Normalize and index a list of registered events. Throws on invalid input. */
export class EventRegistry {
  readonly #byEventId: ReadonlyMap<string, RegisteredEvent>;
  readonly #byGenesisTxId: ReadonlyMap<string, RegisteredEvent>;
  readonly #events: readonly RegisteredEvent[];

  constructor(events: readonly RegisteredEvent[]) {
    const normalized = events.map((event) => ({
      ...event,
      eventId: event.eventId.toLowerCase(),
      genesisTxId: event.genesisTxId.toLowerCase(),
      orgPkh: event.orgPkh.toLowerCase(),
      orgSpk: event.orgSpk.toLowerCase(),
      burnTemplateHash: event.burnTemplateHash.toLowerCase(),
    }));
    this.#events = normalized;
    this.#byEventId = new Map(normalized.map((event) => [event.eventId, event]));
    this.#byGenesisTxId = new Map(normalized.map((event) => [event.genesisTxId, event]));
  }

  list(): readonly RegisteredEvent[] {
    return this.#events;
  }

  byEventId(eventId: string): RegisteredEvent | undefined {
    return this.#byEventId.get(eventId.toLowerCase());
  }

  byGenesisTxId(genesisTxId: string): RegisteredEvent | undefined {
    return this.#byGenesisTxId.get(genesisTxId.toLowerCase());
  }
}

export interface Availability {
  capacity: number;
  sold: number;
  left: number;
  /** Current event covenant outpoint txid (64-hex). */
  event_txid: string;
  /** Current event covenant output index. */
  event_index: number;
  /** Current event covenant address. */
  event_address: string;
  /** Event covenant family id (64-hex). */
  event_covenant_id: string;
}

/** The event covenant's redeem-script hash for a given `remaining`. */
function eventCovenantScriptHash(event: RegisteredEvent, remaining: number): string {
  const constants: DecodedConstants = {
    eventId: hexToBytes(event.eventId),
    price: event.price,
    orgSpk: hexToBytes(event.orgSpk),
    burnTemplateHash: hexToBytes(event.burnTemplateHash),
  };
  const code = hexToBytes(EVENT_ARTIFACT.code);
  const spk = p2shScript(
    buildRedeemScript(
      { owner: hexToBytes(event.orgPkh), identifierType: 0, amount: remaining, isMinter: false },
      constants,
      code,
    ),
  );
  return spk.script;
}

type AvailabilityWalkOutcome =
  | { done: true; left: number }
  | { done: false; address: string; outpoint: OutpointRef; nextRemaining: number };

async function advanceAvailabilityWalk(
  kaspa: KaspaClientLike,
  network: KaspaNetwork,
  event: RegisteredEvent,
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

/**
 * Live remaining tickets for an event, from the event covenant's `remaining`
 * state via the lineage walk (HLD §2.2): `left = remaining`,
 * `sold = capacity − remaining`. The event covenant starts at the deploy
 * output; each mint spends it and re-creates it with `remaining − 1`, so the
 * walk reconstructs successor script hashes and stops at the live one.
 */
export async function eventAvailability(
  event: RegisteredEvent,
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

  const constants: DecodedConstants = {
    eventId: hexToBytes(event.eventId),
    price: event.price,
    orgSpk: hexToBytes(event.orgSpk),
    burnTemplateHash: hexToBytes(event.burnTemplateHash),
  };
  const code = hexToBytes(EVENT_ARTIFACT.code);

  const eventCovenantId = bytesToHex(
    covenantId(
      { txId: hexToBytes(event.genesisTxId), index: 0 },
      [
        {
          index: 0,
          value: 0,
          version: 0,
          script: buildRedeemScript(
            { owner: hexToBytes(event.orgPkh), identifierType: 0, amount: event.capacity, isMinter: false },
            constants,
            code,
          ),
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

/** Parse + validate the `KTICKET_EVENTS` env JSON. Throws on invalid input. */
export function parseRegisteredEvents(raw: string | undefined): RegisteredEvent[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `KTICKET_EVENTS is not valid JSON: ${err instanceof Error ? err.message : err}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("KTICKET_EVENTS must be a JSON array of events");
  }
  return parsed.map((value, i) => validateEvent(value, i));
}

function validateEvent(value: unknown, i: number): RegisteredEvent {
  const label = `KTICKET_EVENTS[${i}]`;
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  const eventId = hex64(value.event_id, `${label}.event_id`);
  const genesisTxId = hex64(value.genesis_txid, `${label}.genesis_txid`);
  const orgPkh = hex64(value.org_pkh, `${label}.org_pkh`);
  const orgSpk = hex(value.org_spk, `${label}.org_spk`);
  const burnTemplateHash = hex64(value.burn_template_hash, `${label}.burn_template_hash`);
  const name = str(value.name, `${label}.name`);
  const date = str(value.date, `${label}.date`);
  const price = num(value.price, `${label}.price`);
  const capacity = uint(value.capacity, `${label}.capacity`);
  if (capacity > MAX_EVENT_CAPACITY) {
    throw new Error(`${label}.capacity must be an integer 0..${MAX_EVENT_CAPACITY}`);
  }

  return { eventId, genesisTxId, orgPkh, orgSpk, burnTemplateHash, name, date, price, capacity };
}

function num(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return n;
}
