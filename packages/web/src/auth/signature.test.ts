import { describe, expect, it } from "vitest";
import { normalizeSignature } from "./signature";

const HEX = "ab".repeat(64);

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

describe("normalizeSignature", () => {
  it("keeps an already-hex signature and lowercases it", () => {
    expect(normalizeSignature(HEX.toUpperCase())).toBe(HEX);
  });

  it("ignores surrounding whitespace", () => {
    expect(normalizeSignature(`  ${HEX}  `)).toBe(HEX);
  });

  it("decodes a base64 signature to the 128-hex form the API verifies", () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => i);
    expect(normalizeSignature(base64(bytes))).toBe(Buffer.from(bytes).toString("hex"));
  });

  it("returns a non-signature untouched", () => {
    expect(normalizeSignature("not-a-signature")).toBe("not-a-signature");
  });

  it("returns base64 of the wrong length untouched", () => {
    const short = base64(new Uint8Array(10));
    expect(normalizeSignature(short)).toBe(short);
  });
});
