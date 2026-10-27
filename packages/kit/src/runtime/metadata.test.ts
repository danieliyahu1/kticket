import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  decodeMetadataFromPayload,
  encodeMetadataPayload,
  isKcc23Payload,
  type EventMetadata,
  type MetadataDeclaration,
} from "./builder";

const ORG_SPK = `20${"01".repeat(32)}ac`;
const IMAGE_HASH_UPPER = "3B8C4E0F2A1D6B9C7E5F4A2D8B0C1E3F6A9D2C5B8E1F4A7D0C3B6E9F2A5D8C1B";
const IMAGE_HASH_LOWER = IMAGE_HASH_UPPER.toLowerCase();
const IMAGE_IPFS = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

function utf8Hex(value: string): string {
  return bytesToHex(new TextEncoder().encode(value));
}

function jsonHex(value: unknown): string {
  return utf8Hex(JSON.stringify(value));
}

/** A KCC-23 payload: the `0x00` codec byte followed by the JSON object. */
function declarationHex(value: unknown): string {
  return `00${jsonHex(value)}`;
}

function baseMeta(overrides: Partial<MetadataDeclaration> = {}): MetadataDeclaration {
  return {
    name: "Testnet Rave",
    date: "2026-12-31",
    time: "20:00",
    priceKAS: 0.00001,
    orgSpk: ORG_SPK,
    ...overrides,
  };
}

describe("encodeMetadataPayload (KCC-23)", () => {
  it("prefixes the payload with the 0x00 JSON codec byte", () => {
    const payload = encodeMetadataPayload(baseMeta());
    expect(payload.startsWith("00")).toBe(true);
    expect(isKcc23Payload(payload)).toBe(true);
    // The rest is exactly the UTF-8 JSON object (spec example: `{}` → `007b7d`).
    expect(payload.slice(2)).toBe(
      utf8Hex(JSON.stringify({
        name: "Testnet Rave",
        date: "2026-12-31",
        time: "20:00",
        priceKAS: 0.00001,
        orgSpk: ORG_SPK,
      })),
    );
    expect(isKcc23Payload("007b7d")).toBe(true);
  });

  it("emits the ecosystem token keys alongside the kticket event fields", () => {
    const payload = encodeMetadataPayload(
      baseMeta({
        ticker: "RAVE",
        decimals: 0,
        image: IMAGE_IPFS,
        image_hash: IMAGE_HASH_UPPER,
      }),
    );
    const parsed = JSON.parse(new TextDecoder().decode(Buffer.from(payload.slice(2), "hex")));
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
    });
    // The burn template hash is derived from the prep txid — never declared.
    expect(parsed).not.toHaveProperty("burnTemplateHash");
  });

  it("omits the token keys when they are not set", () => {
    const parsed = JSON.parse(
      new TextDecoder().decode(Buffer.from(encodeMetadataPayload(baseMeta()).slice(2), "hex")),
    );
    expect(parsed).not.toHaveProperty("ticker");
    expect(parsed).not.toHaveProperty("decimals");
    expect(parsed).not.toHaveProperty("image");
    expect(parsed).not.toHaveProperty("image_hash");
  });

  it("refuses a non-finite number (I-JSON)", () => {
    expect(() => encodeMetadataPayload(baseMeta({ priceKAS: Number.POSITIVE_INFINITY }))).toThrow(
      /finite/,
    );
    expect(() => encodeMetadataPayload(baseMeta({ priceKAS: Number.NaN }))).toThrow(/finite/);
  });
});

describe("decodeMetadataFromPayload (KCC-23 payload)", () => {
  it("round-trips the full declaration including the token keys", () => {
    const meta = baseMeta({
      ticker: "RAVE",
      decimals: 0,
      image: IMAGE_IPFS,
      image_hash: IMAGE_HASH_LOWER,
    });
    expect(decodeMetadataFromPayload(encodeMetadataPayload(meta))).toEqual(meta);
  });

  it("normalizes an uppercase image_hash to lowercase", () => {
    const decoded = decodeMetadataFromPayload(
      encodeMetadataPayload(baseMeta({ image_hash: IMAGE_HASH_UPPER })),
    );
    expect(decoded?.image_hash).toBe(IMAGE_HASH_LOWER);
  });

  it("accepts a KCC-23 payload with only the kticket fields", () => {
    const meta = baseMeta();
    expect(decodeMetadataFromPayload(encodeMetadataPayload(meta))).toEqual(meta);
  });

  it("still reads a burn template hash when a payload carries one (advisory)", () => {
    const decoded = decodeMetadataFromPayload(
      declarationHex({ ...baseMeta(), burnTemplateHash: "ab".repeat(32) }),
    );
    expect(decoded?.burnTemplateHash).toBe("ab".repeat(32));
  });
});

describe("decodeMetadataFromPayload (KCC-23 codec rules)", () => {
  it("rejects a payload without the codec prefix when it is not legacy JSON", () => {
    // A bare JSON object is still accepted as the legacy kticket format …
    expect(decodeMetadataFromPayload(jsonHex(baseMeta()))?.name).toBe("Testnet Rave");
    // … but an unknown codec byte makes the declaration invalid.
    expect(decodeMetadataFromPayload(`01${jsonHex(baseMeta())}`)).toBeNull();
  });

  it("rejects a byte-order mark", () => {
    expect(decodeMetadataFromPayload(`00efbbbf${jsonHex(baseMeta())}`)).toBeNull();
    expect(decodeMetadataFromPayload(`efbbbf${jsonHex(baseMeta())}`)).toBeNull();
  });

  it("rejects JSON that is not an object", () => {
    expect(decodeMetadataFromPayload(declarationHex([1, 2, 3]))).toBeNull();
    expect(decodeMetadataFromPayload(declarationHex("not an object"))).toBeNull();
    expect(decodeMetadataFromPayload("005b5d")).toBeNull();
  });

  it("rejects invalid UTF-8", () => {
    expect(decodeMetadataFromPayload("007b2278223a22ff227d")).toBeNull();
  });

  it("rejects nesting beyond 64 levels (root object is depth 1)", () => {
    const nested = (depth: number): unknown => {
      let value: unknown = 1;
      for (let i = 0; i < depth; i++) value = { nested: value };
      return value;
    };
    // 62 wrappers put the deepest value at depth 64 — still valid.
    expect(decodeMetadataFromPayload(declarationHex({ ...baseMeta(), extra: nested(62) }))).not.toBeNull();
    // 63 wrappers reach depth 65 — invalid.
    expect(decodeMetadataFromPayload(declarationHex({ ...baseMeta(), extra: nested(63) }))).toBeNull();
  });

  it("rejects numbers that do not fit a finite IEEE-754 binary64 value", () => {
    const raw = `{"name":"Testnet Rave","date":"2026-12-31","priceKAS":1e999,"orgSpk":"${ORG_SPK}"}`;
    expect(decodeMetadataFromPayload(`00${utf8Hex(raw)}`)).toBeNull();
  });
});

describe("decodeMetadataFromPayload (field validation)", () => {
  it("coerces decimals from an integer or a base-10 string", () => {
    expect(decodeMetadataFromPayload(declarationHex({ ...baseMeta(), decimals: 8 }))?.decimals).toBe(8);
    expect(decodeMetadataFromPayload(declarationHex({ ...baseMeta(), decimals: "8" }))?.decimals).toBe(8);
  });

  it("drops out-of-range decimals (default 0)", () => {
    expect(
      decodeMetadataFromPayload(declarationHex({ ...baseMeta(), decimals: 300 }))?.decimals,
    ).toBeUndefined();
  });

  it("drops a non-https/ipfs image", () => {
    const decoded = decodeMetadataFromPayload(declarationHex({ ...baseMeta(), image: "http://x/a.png" }));
    expect(decoded?.image).toBeUndefined();
  });

  it("accepts an https image regardless of scheme case", () => {
    const decoded = decodeMetadataFromPayload(
      declarationHex({ ...baseMeta(), image: "HTTPS://cdn.example.org/a.png" }),
    );
    expect(decoded?.image).toBe("HTTPS://cdn.example.org/a.png");
  });

  it("falls back from an invalid ticker to the symbol alias", () => {
    const decoded = decodeMetadataFromPayload(
      declarationHex({ ...baseMeta(), ticker: "THIS_TICKER_IS_TOO_LONG", symbol: "OK" }),
    );
    expect(decoded?.ticker).toBe("OK");
  });

  it("reads `symbol` as the ticker alias when ticker is absent", () => {
    const decoded = decodeMetadataFromPayload(declarationHex({ ...baseMeta(), symbol: "RAVE" }));
    expect(decoded?.ticker).toBe("RAVE");
  });

  it("ignores unknown/extra keys (KCC-23 forward compatibility)", () => {
    const decoded = decodeMetadataFromPayload(
      declarationHex({ ...baseMeta(), description: "extra", v: "1" }),
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
    });
  });

  it("decodes a legacy readable payload without a codec prefix", () => {
    const legacy: EventMetadata = {
      name: "Legacy Rave",
      date: "2025-06-01",
      priceKAS: 0.00001,
      orgSpk: ORG_SPK,
      burnTemplateHash: "ab".repeat(32),
    };
    expect(decodeMetadataFromPayload(jsonHex(legacy))).toEqual(legacy);
  });

  it("returns null for non-kticket payloads (no name/date/price/org/burn)", () => {
    expect(decodeMetadataFromPayload(declarationHex({ name: "Token Only" }))).toBeNull();
    expect(decodeMetadataFromPayload(declarationHex({ ticker: "TOK", decimals: 0 }))).toBeNull();
  });

  it("returns null for garbage and malformed input", () => {
    expect(decodeMetadataFromPayload(null)).toBeNull();
    expect(decodeMetadataFromPayload(undefined)).toBeNull();
    expect(decodeMetadataFromPayload("")).toBeNull();
    expect(decodeMetadataFromPayload("00")).toBeNull();
    expect(decodeMetadataFromPayload("zzzz")).toBeNull();
    expect(decodeMetadataFromPayload(jsonHex([1, 2, 3]))).toBeNull();
    expect(decodeMetadataFromPayload(jsonHex("not an object"))).toBeNull();
  });
});
