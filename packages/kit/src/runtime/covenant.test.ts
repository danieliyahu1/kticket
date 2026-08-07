import { describe, expect, it } from "vitest";
import type { AuthorizedOutput } from "./covenant";
import { CovenantIdError, covenantId } from "./covenant";

const TXID = new Uint8Array(32).map((_, i) => (i === 0 ? 0xaa : i));

function script(bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes);
}

describe("KIP-20 covenant_id (per-family)", () => {
  const outpoint = { txId: TXID, index: 0 };
  const outputs = [
    { index: 0, value: 0, version: 0, script: script([0x51]) },
    { index: 1, value: 0, version: 0, script: script([0x52]) },
  ];

  it("produces a stable 32-byte id for a genesis group", () => {
    const a = covenantId(outpoint, outputs);
    const b = covenantId(outpoint, outputs);
    expect(a).toHaveLength(32);
    expect([...a]).toEqual([...b]);
  });

  it("is per-family: all genesis outputs share one id, distinct from other families", () => {
    const familyA = covenantId(outpoint, outputs);
    const familyB = covenantId({ txId: new Uint8Array(32).fill(0xbb), index: 0 }, outputs);
    expect(familyA).not.toEqual(familyB);
  });

  it("is sensitive to the output order (index), the script, and the value", () => {
    const base = covenantId(outpoint, outputs);
    expect(
      covenantId(outpoint, [
        { index: 0, value: 1, version: 0, script: script([0x51]) },
        { index: 1, value: 0, version: 0, script: script([0x52]) },
      ]),
    ).not.toEqual(base);
    expect(
      covenantId(outpoint, [
        { index: 0, value: 0, version: 0, script: script([0x53]) },
        { index: 1, value: 0, version: 0, script: script([0x52]) },
      ]),
    ).not.toEqual(base);
  });

  it("is independent of the auth-output input order (sorted by index)", () => {
    const sorted = covenantId(outpoint, outputs);
    expect(covenantId(outpoint, [...outputs].reverse())).toEqual(sorted);
  });

  it("validates inputs", () => {
    expect(() => covenantId({ txId: new Uint8Array(31), index: 0 }, outputs)).toThrow(
      CovenantIdError,
    );
    const negativeValue: AuthorizedOutput = {
      index: 0,
      value: -1,
      version: 0,
      script: script([0x51]),
    };
    expect(() => covenantId(outpoint, [negativeValue])).toThrow(CovenantIdError);
  });
});
