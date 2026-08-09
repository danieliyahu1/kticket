import { readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { decodeMetadataFromPayload } from "@kticket/kit";
import type { KaspaClientLike } from "./kaspa-client.js";

export interface StoredEvent {
  covenantId: string;
  genesisTxId: string;
  orgPkh: string;
}

export interface StoredEventInternal extends StoredEvent {
  name: string;
  date: string;
  /** Price in sompi (covenant native unit). */
  price: number;
  capacity: number;
  orgSpk: string;
  burnTemplateHash: string;
  authorizingTxId: string;
}

type IdsJSON = Record<string, unknown>[];

function normalizeHex(s: string): string {
  return s.toLowerCase();
}

export class EventStore {
  readonly #idsPath: string;
  #byCovenantId: Map<string, StoredEventInternal>;
  #byGenesisTxId: Map<string, StoredEventInternal>;
  #events: StoredEventInternal[];

  constructor(idsPath: string) {
    this.#idsPath = resolve(idsPath);
    this.#byCovenantId = new Map();
    this.#byGenesisTxId = new Map();
    this.#events = [];
    this.#loadIds();
  }

  #loadIds(): void {
    if (!existsSync(this.#idsPath)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.#idsPath, "utf-8"));
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
        name: "",
        date: "",
        price: 0,
        capacity: 0,
        orgSpk: "",
        burnTemplateHash: "",
        authorizingTxId: "",
      } satisfies StoredEventInternal;
    });

    if (events.length > 0) {
      this.#events = events;
      this.#rebuildIndexes();
    }
  }

  #rebuildIndexes(): void {
    this.#byCovenantId = new Map(eventsToPairs(this.#events, (e) => e.covenantId));
    this.#byGenesisTxId = new Map(eventsToPairs(this.#events, (e) => e.genesisTxId));
  }

  /**
   * Populate an event's rich data from its deploy transaction on chain.
   * Call this lazily — once hydrated the event is cached in memory and
   * subsequent calls are no-ops. Data survives until the next restart.
   */
  async ensureHydrated(event: StoredEventInternal, kaspa: KaspaClientLike): Promise<void> {
    if (event.name) return;
    try {
      const deploy = await kaspa.getTransaction(event.genesisTxId);
      if (!deploy) return;

      const meta = decodeMetadataFromPayload(deploy.payload);
      if (meta) {
        event.name = meta.name;
        event.date = meta.date;
        event.price = Math.round(meta.priceKAS * 100_000_000);
        event.orgSpk = meta.orgSpk;
        event.burnTemplateHash = meta.burnTemplateHash;
      }

      event.capacity = deploy.outputs?.[0]?.amount ?? 0;
      event.authorizingTxId = deploy.inputs?.[0]?.previous_outpoint_hash ?? "";
    } catch {
      /* chain fetch failed — leave event blank, retry next time */
    }
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
