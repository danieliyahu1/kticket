import { readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface StoredEvent {
  covenantId: string;
  genesisTxId: string;
  orgPkh: string;
  name: string;
  date: string;
}

const EXTENDED_FIELDS = [
  "price",
  "capacity",
  "org_spk",
  "burn_template_hash",
  "authorizing_txid",
] as const;

export interface StoredEventInternal extends StoredEvent {
  price: number;
  capacity: number;
  orgSpk: string;
  burnTemplateHash: string;
  authorizingTxId: string;
}

type EventStoreJSON = Record<string, unknown>[];

function normalizeHex(s: string): string {
  return s.toLowerCase();
}

export class EventStore {
  readonly #filePath: string;
  #byCovenantId: Map<string, StoredEventInternal>;
  #byGenesisTxId: Map<string, StoredEventInternal>;
  #events: StoredEventInternal[];

  constructor(filePath: string) {
    this.#filePath = resolve(filePath);
    this.#byCovenantId = new Map();
    this.#byGenesisTxId = new Map();
    this.#events = [];
    this.#load();
  }

  #load(): void {
    if (!existsSync(this.#filePath)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.#filePath, "utf-8"));
    } catch {
      return;
    }
    if (!Array.isArray(raw)) return;

    const events = raw.map((entry, i) => {
      if (typeof entry !== "object" || entry === null) {
        throw new Error(`events.json[${i}] must be an object`);
      }
      const e = entry as Record<string, unknown>;
      return {
        covenantId: normalizeHex(requireString(e.covenant_id, "covenant_id")),
        genesisTxId: normalizeHex(requireString(e.genesis_txid, "genesis_txid")),
        orgPkh: normalizeHex(requireString(e.org_pkh, "org_pkh")),
        name: requireString(e.name, "name"),
        date: requireString(e.date, "date"),
        price: requireNonNegativeNumber(e.price, "price"),
        capacity: requireNonNegativeInt(e.capacity, "capacity"),
        orgSpk: normalizeHex(requireString(e.org_spk, "org_spk")),
        burnTemplateHash: normalizeHex(requireString(e.burn_template_hash, "burn_template_hash")),
        authorizingTxId: normalizeHex(requireString(e.authorizing_txid, "authorizing_txid")),
      };
    });

    this.#events = events;
    this.#rebuildIndexes();
  }

  #rebuildIndexes(): void {
    this.#byCovenantId = new Map(eventsToPairs(this.#events, (e) => e.covenantId));
    this.#byGenesisTxId = new Map(eventsToPairs(this.#events, (e) => e.genesisTxId));
  }

  register(event: StoredEventInternal): void {
    const normalized = normalizeStoredEvent(event);
    const existing = this.#byCovenantId.get(normalized.covenantId);
    if (existing) {
      existing.genesisTxId = normalized.genesisTxId;
      existing.orgPkh = normalized.orgPkh;
      existing.name = normalized.name;
      existing.date = normalized.date;
      existing.price = normalized.price;
      existing.capacity = normalized.capacity;
      existing.orgSpk = normalized.orgSpk;
      existing.burnTemplateHash = normalized.burnTemplateHash;
      existing.authorizingTxId = normalized.authorizingTxId;
      this.#byGenesisTxId.delete(existing.genesisTxId.toLowerCase());
      this.#byGenesisTxId.set(normalized.genesisTxId, existing);
    } else {
      this.#events.push(normalized);
      this.#byCovenantId.set(normalized.covenantId, normalized);
      this.#byGenesisTxId.set(normalized.genesisTxId, normalized);
    }
    this.#persist();
  }

  byCovenantId(covenantId: string): StoredEventInternal | undefined {
    return this.#byCovenantId.get(covenantId.toLowerCase());
  }

  byGenesisTxId(genesisTxId: string): StoredEventInternal | undefined {
    return this.#byGenesisTxId.get(genesisTxId.toLowerCase());
  }

  list(orgPkh?: string): readonly StoredEvent[] {
    if (!orgPkh) return this.#events.map(toPublic);
    const normalized = orgPkh.toLowerCase();
    return this.#events.filter((e) => e.orgPkh === normalized).map(toPublic);
  }

  #persist(): void {
    const json: EventStoreJSON = this.#events.map((e) => ({
      covenant_id: e.covenantId,
      genesis_txid: e.genesisTxId,
      org_pkh: e.orgPkh,
      name: e.name,
      date: e.date,
      price: e.price,
      capacity: e.capacity,
      org_spk: e.orgSpk,
      burn_template_hash: e.burnTemplateHash,
      authorizing_txid: e.authorizingTxId,
    }));
    writeFileSync(this.#filePath, JSON.stringify(json, null, 2) + "\n", "utf-8");
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireNonNegativeNumber(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return n;
}

function requireNonNegativeInt(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return n;
}

function eventsToPairs(
  events: StoredEventInternal[],
  key: (e: StoredEventInternal) => string,
): [string, StoredEventInternal][] {
  return events.map((e) => [key(e), e] as [string, StoredEventInternal]);
}

function normalizeStoredEvent(event: StoredEventInternal): StoredEventInternal {
  return {
    ...event,
    covenantId: normalizeHex(event.covenantId),
    genesisTxId: normalizeHex(event.genesisTxId),
    orgPkh: normalizeHex(event.orgPkh),
    orgSpk: normalizeHex(event.orgSpk),
    burnTemplateHash: normalizeHex(event.burnTemplateHash),
    authorizingTxId: normalizeHex(event.authorizingTxId),
  };
}

function toPublic(event: StoredEventInternal): StoredEvent {
  return {
    covenantId: event.covenantId,
    genesisTxId: event.genesisTxId,
    orgPkh: event.orgPkh,
    name: event.name,
    date: event.date,
  };
}
