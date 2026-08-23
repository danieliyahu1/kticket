// Turso-backed registry — the durable replacement for the events.json file
// (whose disk is ephemeral on most cloud hosts). Same contract as EventStore
// (see eventstore.ts): the chain stays the source of truth, this is only a
// discovery pointer store, and every read re-verifies against the chain.
//
// Reads are served from an in-memory mirror loaded once at startup; only
// `register` touches the database. The registry is tiny pointer data, so the
// mirror never needs eviction.

import type { Client } from "@libsql/client";
import {
  normalizeStoredEvent,
  REGISTRY_VERSION,
  type EventRegistry,
  type StoredEvent,
} from "./eventstore.js";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    covenant_id       TEXT PRIMARY KEY,
    deploy_txid       TEXT NOT NULL,
    organizer_address TEXT NOT NULL
  )
`;

const META_SCHEMA = `
  CREATE TABLE IF NOT EXISTS registry_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`;

export class TursoEventStore implements EventRegistry {
  readonly #client: Client;
  #byCovenantId: Map<string, StoredEvent> = new Map();
  #byDeployTxId: Map<string, StoredEvent> = new Map();
  #events: StoredEvent[] = [];

  constructor(client: Client) {
    this.#client = client;
  }

  /** Create the schema if missing, wipe stale-contract rows, mirror into memory. */
  async init(): Promise<void> {
    await this.#client.execute(SCHEMA);
    await this.#client.execute(META_SCHEMA);
    await this.#wipeOnVersionMismatch();
    const result = await this.#client.execute(
      "SELECT covenant_id, deploy_txid, organizer_address FROM events ORDER BY rowid",
    );
    for (const row of result.rows) {
      this.#mirror({
        covenantId: String(row.covenant_id),
        deployTxId: String(row.deploy_txid),
        organizerAddress: String(row.organizer_address),
      });
    }
  }

  /**
   * Entries recorded under an older contract version can never re-verify (the
   * artifact's template hash changed), so drop them once per version bump.
   * Same policy as the file store's versioned envelope — discovery pointers
   * only, nothing authoritative is lost.
   */
  async #wipeOnVersionMismatch(): Promise<void> {
    const stored = await this.#client.execute({
      sql: "SELECT value FROM registry_meta WHERE key = 'registry_version'",
      args: [],
    });
    const value = stored.rows[0]?.value;
    if (value !== undefined && Number(value) === REGISTRY_VERSION) return;

    await this.#client.execute("DELETE FROM events");
    await this.#client.execute({
      sql: `INSERT INTO registry_meta (key, value) VALUES ('registry_version', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: [String(REGISTRY_VERSION)],
    });
  }

  /** Release the underlying connection (tests and shutdown). */
  async close(): Promise<void> {
    this.#client.close();
  }

  /**
   * Upsert by covenant id — a re-register points the same covenant at a new
   * deploy txid and drops the old txid mapping (same semantics as EventStore).
   */
  async register(event: StoredEvent): Promise<void> {
    const normalized = normalizeStoredEvent(event);
    await this.#client.execute({
      sql: `INSERT INTO events (covenant_id, deploy_txid, organizer_address)
            VALUES (?, ?, ?)
            ON CONFLICT(covenant_id) DO UPDATE SET
              deploy_txid = excluded.deploy_txid,
              organizer_address = excluded.organizer_address`,
      args: [normalized.covenantId, normalized.deployTxId, normalized.organizerAddress],
    });
    this.#mirror(normalized);
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

  /** Apply one row to the in-memory indexes (insert or re-point). */
  #mirror(event: StoredEvent): void {
    const existing = this.#byCovenantId.get(event.covenantId);
    if (existing) {
      this.#byDeployTxId.delete(existing.deployTxId);
      existing.deployTxId = event.deployTxId;
      existing.organizerAddress = event.organizerAddress;
      this.#byDeployTxId.set(existing.deployTxId, existing);
      return;
    }
    this.#events.push(event);
    this.#byCovenantId.set(event.covenantId, event);
    this.#byDeployTxId.set(event.deployTxId, event);
  }
}
