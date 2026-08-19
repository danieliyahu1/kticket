import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  decodeMetadataFromPayload,
  encodeMetadataPayload,
  type EventMetadata,
} from "./builder";

const ORG_SPK = `20${"01".repeat(32)}ac`;
const BURN_HASH = "ab".repeat(32);
const IMAGE_HASH_UPPER = "3B8C4E0F2A1D6B9C7E5F4A2D8B0C1E3F6A9D2C5B8E1F4A7D0C3B6E9F2A5D8C1B";
const IMAGE_HASH_LOWER = IMAGE_HASH_UPPER.toLowerCase();
const IMAGE_IPFS = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

function jsonHex(value: unknown): string {
  return bytesToHex(new TextEncoder().encode(JSON.stringify(value)));
}

function baseMeta(overrides: Partial<EventMetadata> = {}): EventMetadata {
  return {
    name: "Testnet Rave",
    date: "2026-12-31",
    time: "20:00",
    priceKAS: 0.00001,
    orgSpk: ORG_SPK,
    burnTemplateHash: BURN_HASH,
    ...overrides,
  };
}

describe("encodeMetadataPayload (KCC-0021 keys)", () => {
  it("emits the ecosystem KCC-0021 keys alongside the kticket event fields", () => {
    const payload = encodeMetadataPayload(
      baseMeta({
        ticker: "RAVE",
        decimals: 0,
        image: IMAGE_IPFS,
        image_hash: IMAGE_HASH_UPPER,
      }),
    );
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(Buffer.from(payload, "hex"))));
    expect(parsed).toMatchObject({
      name: "Testnet Rave",
      ticker: "RAVE",
      decimals: 0,
      image: IMAGE_IPFS,
      image_hash: IMAGE_HASH_UPPER,
      date: "2026-12-31",
      time: "20:00",
      priceKAS: 0.00001,
      orgSpk: ORG_SPK,
      burnTemplateHash: BURN_HASH,
    });
  });

  it("omits the KCC-0021 keys when they are not set", () => {
    const payload = encodeMetadataPayload(baseMeta());
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(Buffer.from(payload, "hex"))));
    expect(parsed).not.toHaveProperty("ticker");
    expect(parsed).not.toHaveProperty("decimals");
    expect(parsed).not.toHaveProperty("image");
    expect(parsed).not.toHaveProperty("image_hash");
    expect(parsed).toMatchObject({
      name: "Testnet Rave",
      date: "2026-12-31",
      priceKAS: 0.00001,
    });
  });
});

describe("decodeMetadataFromPayload (KCC-0021-shaped payload)", () => {
  it("round-trips the full metadata including the standard keys", () => {
    const meta = baseMeta({
      ticker: "RAVE",
      decimals: 0,
      image: IMAGE_IPFS,
      image_hash: IMAGE_HASH_LOWER,
    });
    expect(decodeMetadataFromPayload(encodeMetadataPayload(meta))).toEqual(meta);
  });

  it("decodes the current readable format without KCC-0021 keys", () => {
    const meta = baseMeta();
    expect(decodeMetadataFromPayload(encodeMetadataPayload(meta))).toEqual(meta);
  });

  it("normalizes an uppercase image_hash to lowercase", () => {
    const decoded = decodeMetadataFromPayload(
      encodeMetadataPayload(baseMeta({ image_hash: IMAGE_HASH_UPPER })),
    );
    expect(decoded?.image_hash).toBe(IMAGE_HASH_LOWER);
  });
});

describe("decodeMetadataFromPayload (KCC-0021 field validation)", () => {
  it("coerces decimals from an integer or a base-10 string", () => {
    expect(decodeMetadataFromPayload(jsonHex({ ...baseMeta(), decimals: 8 }))?.decimals).toBe(8);
    expect(decodeMetadataFromPayload(jsonHex({ ...baseMeta(), decimals: "8" }))?.decimals).toBe(8);
  });

  it("drops out-of-range decimals (default 0)", () => {
    expect(
      decodeMetadataFromPayload(jsonHex({ ...baseMeta(), decimals: 300 }))?.decimals,
    ).toBeUndefined();
  });

  it("drops a non-https/ipfs image", () => {
    const decoded = decodeMetadataFromPayload(jsonHex({ ...baseMeta(), image: "http://x/a.png" }));
    expect(decoded?.image).toBeUndefined();
  });

  it("accepts an https image regardless of scheme case", () => {
    const decoded = decodeMetadataFromPayload(
      jsonHex({ ...baseMeta(), image: "HTTPS://cdn.example.org/a.png" }),
    );
    expect(decoded?.image).toBe("HTTPS://cdn.example.org/a.png");
  });

  it("falls back from an invalid ticker to the symbol alias", () => {
    const decoded = decodeMetadataFromPayload(
      jsonHex({ ...baseMeta(), ticker: "THIS_TICKER_IS_TOO_LONG", symbol: "OK" }),
    );
    expect(decoded?.ticker).toBe("OK");
  });

  it("reads `symbol` as the ticker alias when ticker is absent", () => {
    const decoded = decodeMetadataFromPayload(jsonHex({ ...baseMeta(), symbol: "RAVE" }));
    expect(decoded?.ticker).toBe("RAVE");
  });

  it("ignores unknown/extra keys (KCC-0021 forward compatibility)", () => {
    const decoded = decodeMetadataFromPayload(
      jsonHex({ ...baseMeta(), description: "extra", p: "kcc-0021", v: "1" }),
    );
    expect(decoded).toMatchObject({ name: "Testnet Rave", date: "2026-12-31" });
  });
});

describe("decodeMetadataFromPayload (legacy + garbage)", () => {
  it("decodes the legacy {n, d, p} format", () => {
    expect(decodeMetadataFromPayload(jsonHex({ n: "Old Rave", d: "2025-06-01", p: 1000 }))).toEqual({
      name: "Old Rave",
      date: "2025-06-01",
      priceKAS: 1000 / 100_000_000,
      orgSpk: "",
      burnTemplateHash: "",
    });
  });

  it("returns null for non-kticket payloads (no name/date/price/org/burn)", () => {
    expect(decodeMetadataFromPayload(jsonHex({ name: "Token Only" }))).toBeNull();
    expect(decodeMetadataFromPayload(jsonHex({ ticker: "TOK", decimals: 0 }))).toBeNull();
  });

  it("returns null for garbage and malformed input", () => {
    expect(decodeMetadataFromPayload(null)).toBeNull();
    expect(decodeMetadataFromPayload(undefined)).toBeNull();
    expect(decodeMetadataFromPayload("")).toBeNull();
    expect(decodeMetadataFromPayload("zzzz")).toBeNull();
    expect(decodeMetadataFromPayload(jsonHex([1, 2, 3]))).toBeNull();
    expect(decodeMetadataFromPayload(jsonHex("not an object"))).toBeNull();
  });
});
