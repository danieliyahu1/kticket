import { readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { decodeMetadataFromTx } from "@kticket/kit";
import type { KaspaClientLike } from "./kaspa-client.js";

export interface StoredEvent {
  covenantId: string;
  genesisTxId: string;
  orgPkh: string;
}

export interface StoredEventInternal extends StoredEvent {
  name: string;
  date: string;
  price: number;
  capacity: number;
  orgSpk: string;
  burnTemplateHash: string;
  authorizingTxId: string;
}

interface StoredEventData {
  name: string;
  date: string;
  price: number;
}

type IdsJSON = Record<string, unknown>[];
type DataJSON = Record<string, StoredEventData>;

function normalizeHex(s: string): string {
  return s.toLowerCase();
}

function dataFilePath(idsPath: string): string {
  const dir = dirname(idsPath);
  const base = basename(idsPath, ".json");
  return resolve(dir, `${base}-data.json`);
}

export class EventStore {
  readonly #idsPath: string;
  readonly #dataPath: string;
  #byCovenantId: Map<string, StoredEventInternal>;
  #byGenesisTxId: Map<string, StoredEventInternal>;
  #events: StoredEventInternal[];

  constructor(idsPath: string) {
    this.#idsPath = resolve(idsPath);
    this.#dataPath = dataFilePath(this.#idsPath);
    this.#byCovenantId = new Map();
    this.#byGenesisTxId = new Map();
    this.#events = [];
    this.#load();
  }

  #load(): void {
    const ids = this.#loadIds();
    if (ids.length === 0) return;
    const data = this.#loadData();

    const events = ids.map((id) => {
      const extra = data.get(id.covenantId);
      return {
        ...id,
        name: extra?.name ?? "",
        date: extra?.date ?? "",
        price: extra?.price ?? 0,
        capacity: 0,
        orgSpk: "",
        burnTemplateHash: "",
        authorizingTxId: "",
      };
    });

    this.#events = events;
    this.#rebuildIndexes();
  }

  #loadIds(): StoredEvent[] {
    if (!existsSync(this.#idsPath)) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.#idsPath, "utf-8"));
    } catch {
      return [];
    }
    if (!Array.isArray(raw)) return [];

    return raw.map((entry, i) => {
      if (typeof entry !== "object" || entry === null) {
        throw new Error(`events.json[${i}] must be an object`);
      }
      const e = entry as Record<string, unknown>;
      return {
        covenantId: normalizeHex(requireString(e.covenant_id, "covenant_id")),
        genesisTxId: normalizeHex(requireString(e.genesis_txid, "genesis_txid")),
        orgPkh: normalizeHex(requireString(e.org_pkh, "org_pkh")),
      };
    });
  }

  #loadData(): Map<string, StoredEventData> {
    const map = new Map<string, StoredEventData>();
    if (!existsSync(this.#dataPath)) return map;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.#dataPath, "utf-8"));
    } catch {
      return map;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return map;
    const obj = raw as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value !== "object" || value === null) continue;
      const v = value as Record<string, unknown>;
      if (typeof v.name !== "string" || typeof v.date !== "string" || typeof v.price !== "number") continue;
      map.set(normalizeHex(key), { name: v.name, date: v.date, price: v.price });
    }
    return map;
  }

  #rebuildIndexes(): void {
    this.#byCovenantId = new Map(eventsToPairs(this.#events, (e) => e.covenantId));
    this.#byGenesisTxId = new Map(eventsToPairs(this.#events, (e) => e.genesisTxId));
  }

  /** Repair tool — rebuilds events-data.json from chain. Not called at startup. */
  async hydrate(kaspa: KaspaClientLike): Promise<void> {
    let changed = false;
    for (const event of this.#events) {
      if (event.name) continue;
      try {
        const deploy = await kaspa.getTransaction(event.genesisTxId);
        if (!deploy) continue;
        const meta = decodeMetadataFromTx(deploy.outputs ?? []);
        if (meta) {
          event.name = meta.name;
          event.date = meta.date;
          event.price = meta.price;
          changed = true;
        }
      } catch {
        continue;
      }
    }
    if (changed) this.#saveData();
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
    this.#saveIds();
    this.#saveData();
  }

  byCovenantId(covenantId: string): StoredEventInternal | undefined {
    return this.#byCovenantId.get(covenantId.toLowerCase());
  }

  byGenesisTxId(genesisTxId: string): StoredEventInternal | undefined {
    return this.#byGenesisTxId.get(genesisTxId.toLowerCase());
  }

  list(orgPkh?: string): readonly StoredEventInternal[] {
    if (!orgPkh) return this.#events;
    const normalized = orgPkh.toLowerCase();
    return this.#events.filter((e) => e.orgPkh === normalized);
  }

  #saveIds(): void {
    const json: IdsJSON = this.#events.map((e) => ({
      covenant_id: e.covenantId,
      genesis_txid: e.genesisTxId,
      org_pkh: e.orgPkh,
    }));
    writeFileSync(this.#idsPath, JSON.stringify(json, null, 2) + "\n", "utf-8");
  }

  #saveData(): void {
    const json: DataJSON = {};
    for (const e of this.#events) {
      json[e.covenantId] = { name: e.name, date: e.date, price: e.price };
    }
    writeFileSync(this.#dataPath, JSON.stringify(json, null, 2) + "\n", "utf-8");
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
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
