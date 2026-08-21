// The identifier registry (KTK-89) — replaces the stateful event store.
//
// The backend is stateless: the chain is the source of truth for every event
// field (name, price, date, organizer). This file persists only a lightweight
// identifier pointer store for *discovery*:
//
//   { deploy_txid, covenant_id, organizer_address }
//
// None of these fields are authoritative. Every event read re-fetches the deploy
// transaction from the chain and re-verifies it; a poisoned registry entry simply
// fails on-chain verification and is hidden. The registry is a convenience cache,
// never a source of truth.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface StoredEvent {
  /** The deploy transaction id — the retrieval key for every chain read. */
  deployTxId: string;
  /** KIP-20 covenant id — the canonical event identity (shareable anchor). */
  covenantId: string;
  /** "Who made them" listing + trust-anchor display. Derived, never authoritative. */
  organizerAddress: string;
}

/**
 * The registry contract every backend implements. Reads are synchronous —
 * implementations mirror the rows in memory; only `register` is async.
 */
export interface EventRegistry {
  register(event: StoredEvent): Promise<void>;
  byCovenantId(covenantId: string): StoredEvent | undefined;
  byDeployTxId(deployTxId: string): StoredEvent | undefined;
  list(organizerAddress?: string): readonly StoredEvent[];
}

type IdsJSON = Record<string, unknown>[];

function normalizeHex(s: string): string {
  return s.toLowerCase();
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export class EventStore implements EventRegistry {
  readonly #idsPath?: string;
  #byCovenantId: Map<string, StoredEvent>;
  #byDeployTxId: Map<string, StoredEvent>;
  #events: StoredEvent[];

  /** Pass a file path to persist the registry; omit it for an in-memory store. */
  constructor(idsPath?: string) {
    this.#idsPath = idsPath ? resolve(idsPath) : undefined;
    this.#byCovenantId = new Map();
    this.#byDeployTxId = new Map();
    this.#events = [];
    if (this.#idsPath) this.#loadIds();
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
        deployTxId: normalizeHex(
          requireString(e.deploy_txid ?? e.genesis_txid, "deploy_txid"),
        ),
        organizerAddress: requireString(
          e.organizer_address ?? e.org_pkh,
          "organizer_address",
        ),
      } satisfies StoredEvent;
    });

    if (events.length > 0) {
      this.#events = events;
      this.#rebuildIndexes();
    }
  }

  #rebuildIndexes(): void {
    this.#byCovenantId = new Map(eventsToPairs(this.#events, (e) => e.covenantId));
    this.#byDeployTxId = new Map(eventsToPairs(this.#events, (e) => e.deployTxId));
  }

  async register(event: StoredEvent): Promise<void> {
    const normalized = normalizeStoredEvent(event);
    const existing = this.#byCovenantId.get(normalized.covenantId);
    if (existing) {
      this.#byDeployTxId.delete(existing.deployTxId);
      existing.deployTxId = normalized.deployTxId;
      existing.organizerAddress = normalized.organizerAddress;
      this.#byDeployTxId.set(normalized.deployTxId, existing);
    } else {
      this.#events.push(normalized);
      this.#byCovenantId.set(normalized.covenantId, normalized);
      this.#byDeployTxId.set(normalized.deployTxId, normalized);
    }
    this.#saveIds();
  }

  byCovenantId(covenantId: string): StoredEvent | undefined {
    return this.#byCovenantId.get(covenantId.toLowerCase());
  }

  byDeployTxId(deployTxId: string): StoredEvent | undefined {
    return this.#byDeployTxId.get(deployTxId.toLowerCase());
  }

  list(organizerAddress?: string): readonly StoredEvent[] {
    if (!organizerAddress) return this.#events;
    return this.#events.filter((e) => e.organizerAddress === organizerAddress);
  }

  #saveIds(): void {
    if (!this.#idsPath) return;
    const json: IdsJSON = this.#events.map((e) => ({
      deploy_txid: e.deployTxId,
      covenant_id: e.covenantId,
      organizer_address: e.organizerAddress,
    }));
    writeFileSync(this.#idsPath, JSON.stringify(json, null, 2) + "\n", "utf-8");
  }
}

function eventsToPairs(
  events: readonly StoredEvent[],
  key: (e: StoredEvent) => string,
): [string, StoredEvent][] {
  return events.map((e) => [key(e), e] as [string, StoredEvent]);
}

export function normalizeStoredEvent(event: StoredEvent): StoredEvent {
  return {
    covenantId: normalizeHex(event.covenantId),
    deployTxId: normalizeHex(event.deployTxId),
    organizerAddress: event.organizerAddress,
  };
}
