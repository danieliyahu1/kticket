// The listings index (KTK-151) — a discovery store for trustless resale.
//
// The asking price lives in the ticket's covenant state (`sale_price`), and a
// listed ticket's P2SH address commits to it, so the CHAIN is the source of
// truth for any single listing. But the chain cannot answer "which tickets are
// for sale?" — the listed-address space is unbounded — so this store indexes
// `{covenant_id, ticket_id, seller, price}` candidates that readers then verify
// on-chain (address must equal the derived `listedStateAddress`). A stale or
// poisoned entry simply fails verification and is hidden, exactly like the
// event registry.
//
// Written by list-finalize / delist-finalize / purchase-finalize; read by the
// listings directory endpoint.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface StoredListing {
  /** The event's KIP-20 family covenant id. */
  covenantId: string;
  /** `<txid>:<index>` of the listed ticket UTXO (same shape as GET /v1/tickets). */
  ticketId: string;
  /** The seller's 32-byte owner identifier (pubkey x-coordinate), 64-hex. */
  sellerPkh: string;
  /** Asking price in sompi — advisory; the chain-verified value wins. */
  price: number;
}

/** The listings-store contract every backend implements. */
export interface ListingStore {
  upsert(listing: StoredListing): Promise<void>;
  remove(covenantId: string, ticketId: string): Promise<void>;
  get(covenantId: string, ticketId: string): StoredListing | undefined;
  byCovenantId(covenantId: string): readonly StoredListing[];
  list(): readonly StoredListing[];
}

type ListingsJSON = Record<string, unknown>[];

function normalizeHex(s: string): string {
  return s.toLowerCase();
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function normalizeListing(listing: StoredListing): StoredListing {
  return {
    covenantId: normalizeHex(listing.covenantId),
    ticketId: listing.ticketId,
    sellerPkh: normalizeHex(listing.sellerPkh),
    price: listing.price,
  };
}

/** The store row key — a covenant id paired with one ticket outpoint. */
export function listingKey(covenantId: string, ticketId: string): string {
  return `${covenantId.toLowerCase()}|${ticketId}`;
}

export class ListingStoreFile implements ListingStore {
  readonly #path?: string;
  #byKey: Map<string, StoredListing> = new Map();
  #listings: StoredListing[] = [];

  /** Pass a file path to persist the index; omit it for an in-memory store. */
  constructor(path?: string) {
    this.#path = path ? resolve(path) : undefined;
    if (this.#path) this.#load();
  }

  async upsert(listing: StoredListing): Promise<void> {
    const normalized = normalizeListing(listing);
    const key = listingKey(normalized.covenantId, normalized.ticketId);
    const existing = this.#byKey.get(key);
    if (existing) {
      existing.sellerPkh = normalized.sellerPkh;
      existing.price = normalized.price;
    } else {
      this.#listings.push(normalized);
      this.#byKey.set(key, normalized);
    }
    this.#save();
  }

  async remove(covenantId: string, ticketId: string): Promise<void> {
    const key = listingKey(covenantId, ticketId);
    const existing = this.#byKey.get(key);
    if (!existing) return;
    this.#byKey.delete(key);
    this.#listings = this.#listings.filter((l) => l !== existing);
    this.#save();
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

  #load(): void {
    if (this.#path === undefined) return;
    if (!existsSync(this.#path)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.#path, "utf-8"));
    } catch {
      return;
    }
    if (!Array.isArray(raw)) return;
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      try {
        this.#upsertSync({
          covenantId: normalizeHex(requireString(e.covenant_id, "covenant_id")),
          ticketId: requireString(e.ticket_id, "ticket_id"),
          sellerPkh: normalizeHex(requireString(e.seller_pkh, "seller_pkh")),
          price: Number(e.price),
        });
      } catch {
        // A malformed row is dead weight, not truth — skip it.
        continue;
      }
    }
  }

  /** Synchronous twin of upsert for loading (no save per row). */
  #upsertSync(listing: StoredListing): void {
    const key = listingKey(listing.covenantId, listing.ticketId);
    const existing = this.#byKey.get(key);
    if (existing) {
      existing.sellerPkh = listing.sellerPkh;
      existing.price = listing.price;
    } else {
      this.#listings.push(listing);
      this.#byKey.set(key, listing);
    }
  }

  #save(): void {
    if (!this.#path) return;
    const json: ListingsJSON = this.#listings.map((l) => ({
      covenant_id: l.covenantId,
      ticket_id: l.ticketId,
      seller_pkh: l.sellerPkh,
      price: l.price,
    }));
    writeFileSync(this.#path, JSON.stringify(json, null, 2) + "\n", "utf-8");
  }
}
