// Turso-backed listings index — the durable counterpart of ListingStoreFile
// (see listings.ts). Same discovery-only contract: rows are candidate listings
// that readers verify against the chain before trusting.

import type { Client } from "@libsql/client";
import {
  listingKey,
  normalizeListing,
  type ListingStore,
  type StoredListing,
} from "./listings.js";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS listings (
    covenant_id TEXT NOT NULL,
    ticket_id   TEXT NOT NULL,
    seller_pkh  TEXT NOT NULL,
    price       INTEGER NOT NULL,
    PRIMARY KEY (covenant_id, ticket_id)
  )
`;

export class TursoListingStore implements ListingStore {
  readonly #client: Client;
  #byKey: Map<string, StoredListing> = new Map();
  #listings: StoredListing[] = [];

  constructor(client: Client) {
    this.#client = client;
  }

  /** Create the schema if missing and mirror existing rows into memory. */
  async init(): Promise<void> {
    await this.#client.execute(SCHEMA);
    const result = await this.#client.execute(
      "SELECT covenant_id, ticket_id, seller_pkh, price FROM listings ORDER BY rowid",
    );
    for (const row of result.rows) {
      this.#mirror(
        normalizeListing({
          covenantId: String(row.covenant_id),
          ticketId: String(row.ticket_id),
          sellerPkh: String(row.seller_pkh),
          price: Number(row.price),
        }),
      );
    }
  }

  async upsert(listing: StoredListing): Promise<void> {
    const normalized = normalizeListing(listing);
    await this.#client.execute({
      sql: `INSERT INTO listings (covenant_id, ticket_id, seller_pkh, price)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(covenant_id, ticket_id) DO UPDATE SET
              seller_pkh = excluded.seller_pkh,
              price = excluded.price`,
      args: [normalized.covenantId, normalized.ticketId, normalized.sellerPkh, normalized.price],
    });
    this.#mirror(normalized);
  }

  async remove(covenantId: string, ticketId: string): Promise<void> {
    const id = covenantId.toLowerCase();
    await this.#client.execute({
      sql: "DELETE FROM listings WHERE covenant_id = ? AND ticket_id = ?",
      args: [id, ticketId],
    });
    const key = listingKey(id, ticketId);
    const existing = this.#byKey.get(key);
    if (!existing) return;
    this.#byKey.delete(key);
    this.#listings = this.#listings.filter((l) => l !== existing);
  }

  get(covenantId: string, ticketId: string): StoredListing | undefined {
    return this.#byKey.get(listingKey(covenantId, ticketId));
  }

  byCovenantId(covenantId: string): readonly StoredListing[] {
    const id = covenantId.toLowerCase();
    return this.#listings.filter((l) => l.covenantId === id);
  }

  list(): readonly StoredListing[] {
    return this.#listings;
  }

  #mirror(listing: StoredListing): void {
    const key = listingKey(listing.covenantId, listing.ticketId);
    const existing = this.#byKey.get(key);
    if (existing) {
      existing.sellerPkh = listing.sellerPkh;
      existing.price = listing.price;
      return;
    }
    this.#listings.push(listing);
    this.#byKey.set(key, listing);
  }
}
