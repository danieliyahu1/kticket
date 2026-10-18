import { describe, expect, it } from "vitest";
import {
  buildEventMeta,
  buildGenericMeta,
  eventPriceLabel,
  eventWhenLabel,
  GENERIC_DESCRIPTION,
  GENERIC_TITLE,
  SITE_NAME,
} from "./event-meta.js";

const ORIGIN = "https://kticket.example.com";
const COVENANT_ID = "ab".repeat(32);

function facts(overrides: Partial<Parameters<typeof buildEventMeta>[0]> = {}) {
  return {
    covenant_id: COVENANT_ID,
    name: "Testnet Rave",
    date: "2026-12-31",
    time: "20:00",
    price: 5_000_000_000,
    image: "https://cdn.example.com/rave.png",
    ...overrides,
  };
}

describe("buildEventMeta (KTK-160)", () => {
  it("builds a complete preview from verified facts", () => {
    const meta = buildEventMeta(facts(), ORIGIN);

    expect(meta.title).toBe(`Testnet Rave — ${SITE_NAME}`);
    expect(meta.description).toBe(
      "Testnet Rave — 31 December 2026, 20:00. 50 KAS per ticket. Verified on-chain on Kaspa.",
    );
    expect(meta.canonicalUrl).toBe(`${ORIGIN}/events/${COVENANT_ID}`);
    expect(meta.imageUrl).toBe("https://cdn.example.com/rave.png");
    expect(meta.twitterCard).toBe("summary_large_image");
  });

  it("omits image tags when the event has no image", () => {
    const meta = buildEventMeta(facts({ image: "" }), ORIGIN);

    expect(meta.title).toContain("Testnet Rave");
    expect(meta.imageUrl).toBeUndefined();
    expect(meta.twitterCard).toBe("summary");
    expect(meta.description).toContain("Verified on-chain");
  });

  it("treats a zero price as free entry", () => {
    expect(buildEventMeta(facts({ price: 0 }), ORIGIN).description).toContain("Free entry");
  });

  it("resolves IPFS images through a gateway and drops unusable ones", () => {
    expect(buildEventMeta(facts({ image: "ipfs://ipfs/bafy123" }), ORIGIN).imageUrl).toBe(
      "https://ipfs.io/ipfs/bafy123",
    );
    expect(buildEventMeta(facts({ image: "data:image/png;base64,abc" }), ORIGIN).imageUrl).toBeUndefined();
    expect(buildEventMeta(facts({ image: "javascript:alert(1)" }), ORIGIN).imageUrl).toBeUndefined();
  });

  it("falls back to generic metadata when there is no verified name", () => {
    expect(buildEventMeta(facts({ name: "   " }), ORIGIN)).toEqual(buildGenericMeta(ORIGIN));
  });

  it("never emits an unescaped value into the preview fields", () => {
    // The values are data here; the renderer escapes them. This test pins the
    // builder's contract: it passes the verified value through unchanged.
    const meta = buildEventMeta(facts({ name: "<script>alert(1)</script> & Co" }), ORIGIN);
    expect(meta.title).toBe("<script>alert(1)</script> & Co — kticket");
  });

  it("normalizes origins with trailing slashes", () => {
    expect(buildEventMeta(facts(), `${ORIGIN}/`).canonicalUrl).toBe(
      `${ORIGIN}/events/${COVENANT_ID}`,
    );
  });

  it("encodes the covenant id in the path", () => {
    expect(buildEventMeta(facts({ covenant_id: "a/b c" }), ORIGIN).canonicalUrl).toBe(
      `${ORIGIN}/events/a%2Fb%20c`,
    );
  });

  it("exposes stable generic metadata for the site", () => {
    const generic = buildGenericMeta(ORIGIN);
    expect(generic.title).toBe(GENERIC_TITLE);
    expect(generic.description).toBe(GENERIC_DESCRIPTION);
    expect(generic.canonicalUrl).toBe(`${ORIGIN}/`);
    expect(generic.imageUrl).toBeUndefined();
  });
});

describe("eventWhenLabel", () => {
  it("formats a date and time deterministically", () => {
    expect(eventWhenLabel("2026-12-31", "20:00")).toBe("31 December 2026, 20:00");
  });

  it("formats a date without a time", () => {
    expect(eventWhenLabel("2026-01-05", "")).toBe("5 January 2026");
  });

  it("passes through an unrecognised date instead of inventing one", () => {
    expect(eventWhenLabel("next saturday")).toBe("next saturday");
    expect(eventWhenLabel("2026-13-01")).toBe("2026-13-01");
    expect(eventWhenLabel("2026-02-30")).toBe("2026-02-30");
  });
});

describe("eventPriceLabel", () => {
  it("formats sompi as KAS without trailing zeros", () => {
    expect(eventPriceLabel(5_000_000_000)).toBe("50 KAS");
    expect(eventPriceLabel(1_250_000_000)).toBe("12.5 KAS");
    expect(eventPriceLabel(1)).toBe("0.00000001 KAS");
  });

  it("handles free and invalid prices", () => {
    expect(eventPriceLabel(0)).toBe("Free");
    expect(eventPriceLabel(-1)).toBe("");
    expect(eventPriceLabel(Number.NaN)).toBe("");
  });
});
