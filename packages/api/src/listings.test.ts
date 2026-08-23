import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ListingStoreFile, listingKey, normalizeListing, type StoredListing } from "./listings";

const COVENANT = "23".repeat(32);
const OTHER_COVENANT = "45".repeat(32);
const TICKET_ID = "ab".repeat(32) + ":0";

function listing(overrides: Partial<StoredListing> = {}): StoredListing {
  return {
    covenantId: COVENANT,
    ticketId: TICKET_ID,
    sellerPkh: "cd".repeat(32),
    price: 150_000_000,
    ...overrides,
  };
}

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), "kticket-listings-")), "listings.json");
}

function cleanup(path?: string): void {
  if (path) rmSync(join(path, ".."), { recursive: true, force: true });
}

describe("listingKey / normalizeListing", () => {
  it("builds a row key from the lowercase covenant id and ticket id", () => {
    expect(listingKey(COVENANT.toUpperCase(), TICKET_ID)).toBe(`${COVENANT}|${TICKET_ID}`);
  });

  it("normalizes hex ids to lowercase", () => {
    const normalized = normalizeListing({
      covenantId: COVENANT.toUpperCase(),
      ticketId: TICKET_ID.toUpperCase(),
      sellerPkh: "CD".repeat(32),
      price: 1,
    });
    // The txid inside ticketId stays verbatim (the chain is case-insensitive on
    // display but we keep the canonical lowercase form only for indexed hex).
    expect(normalized.covenantId).toBe(COVENANT);
    expect(normalized.sellerPkh).toBe("cd".repeat(32));
  });
});

describe("ListingStoreFile (in-memory)", () => {
  let store: ListingStoreFile;

  beforeEach(() => {
    store = new ListingStoreFile();
  });

  it("upserts and reads listings back", async () => {
    await store.upsert(listing());
    expect(store.get(COVENANT, TICKET_ID)).toEqual(listing());
    expect(store.list()).toHaveLength(1);
  });

  it("indexes by covenant id", async () => {
    await store.upsert(listing());
    await store.upsert(
      listing({ covenantId: OTHER_COVENANT, ticketId: "ef".repeat(32) + ":1" }),
    );
    expect(store.byCovenantId(COVENANT)).toHaveLength(1);
    expect(store.byCovenantId(OTHER_COVENANT)).toHaveLength(1);
    expect(store.byCovenantId("ff".repeat(32))).toHaveLength(0);
  });

  it("upserting twice updates price and seller in place", async () => {
    await store.upsert(listing());
    await store.upsert(listing({ price: 200_000_000 }));
    expect(store.list()).toHaveLength(1);
    expect(store.get(COVENANT, TICKET_ID)?.price).toBe(200_000_000);
  });

  it("removes a listing and tolerates removing an unknown one", async () => {
    await store.upsert(listing());
    await store.remove(COVENANT, TICKET_ID);
    expect(store.get(COVENANT, TICKET_ID)).toBeUndefined();
    expect(store.list()).toHaveLength(0);

    await expect(store.remove(COVENANT, TICKET_ID)).resolves.toBeUndefined();
  });
});

describe("ListingStoreFile (persisted)", () => {
  it("round-trips listings through the file", async () => {
    const path = tempPath();
    try {
      const store = new ListingStoreFile(path);
      await store.upsert(listing());

      const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>[];
      expect(raw).toEqual([
        {
          covenant_id: COVENANT,
          ticket_id: TICKET_ID,
          seller_pkh: "cd".repeat(32),
          price: 150_000_000,
        },
      ]);

      const reloaded = new ListingStoreFile(path);
      expect(reloaded.get(COVENANT, TICKET_ID)).toEqual(listing());
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("ignores a missing file and starts empty", () => {
    const path = tempPath();
    try {
      const store = new ListingStoreFile(path);
      expect(store.list()).toHaveLength(0);
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("tolerates a corrupt file and starts empty", () => {
    const path = tempPath();
    try {
      writeFileSync(path, "{ not json", "utf-8");
      const store = new ListingStoreFile(path);
      expect(store.list()).toHaveLength(0);
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("skips malformed rows but keeps well-formed ones", () => {
    const path = tempPath();
    try {
      writeFileSync(
        path,
        JSON.stringify([
          { covenant_id: COVENANT, ticket_id: TICKET_ID, seller_pkh: "cd".repeat(32), price: 5 },
          { covenant_id: COVENANT }, // missing fields — skipped
          null, // not an object — skipped
          "garbage",
        ]),
        "utf-8",
      );
      const store = new ListingStoreFile(path);
      expect(store.list()).toHaveLength(1);
      expect(store.get(COVENANT, TICKET_ID)?.price).toBe(5);
    } finally {
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });
});
