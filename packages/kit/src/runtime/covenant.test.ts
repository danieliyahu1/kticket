import { describe, expect, it } from "vitest";
import type { AuthorizedOutput } from "./covenant";
import { CovenantIdError, covenantId } from "./covenant";

const HASH_LENGTH = 32;
const SHORT_HASH_LENGTH = 31;
const TXID_SEED = 0xaa;
const OTHER_FAMILY_SEED = 0xbb;
const OP_1 = 0x51;
const OP_2 = 0x52;
const OP_3 = 0x53;

const TXID = new Uint8Array(HASH_LENGTH).map((_, i) => (i === 0 ? TXID_SEED : i));

function script(bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes);
}

const OUTPOINT = { txId: TXID, index: 0 };
const OUTPUTS = [
  { index: 0, value: 0, version: 0, script: script([OP_1]) },
  { index: 1, value: 0, version: 0, script: script([OP_2]) },
];

describe("KIP-20 covenant_id (per-family)", () => {
  it("produces a stable 32-byte id for a genesis group", () => {
    const a = covenantId(OUTPOINT, OUTPUTS);
    const b = covenantId(OUTPOINT, OUTPUTS);
    expect(a).toHaveLength(HASH_LENGTH);
    expect([...a]).toEqual([...b]);
  });

  it("is per-family: all genesis outputs share one id, distinct from other families", () => {
    const familyA = covenantId(OUTPOINT, OUTPUTS);
    const familyB = covenantId(
      { txId: new Uint8Array(HASH_LENGTH).fill(OTHER_FAMILY_SEED), index: 0 },
      OUTPUTS,
    );
    expect(familyA).not.toEqual(familyB);
  });
});

describe("KIP-20 covenant_id (golden, matches vendored kaspa-wasm)", () => {
  it("reproduces the on-chain genesis covenant id for a real deploy", () => {
    // Golden computed from the vendored kaspa-wasm `covenantId` (rusty-kaspa
    // consensus). The script length is hashed as le_u64 — KTK-102: the kit used
    // a LEB128 varint here and produced a different (wrong) id, which the node
    // rejected when the buy tx spent the event covenant.
    const GOLDEN = "c7f6b3f20a72474ceee1847ba87d1177f457019996c32327fc0576dd667f4bfb";
    const DEPLOY_TXID = Uint8Array.from(
      Buffer.from("aa0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex"),
    );
    const EVENT_SCRIPT = Uint8Array.from(
      Buffer.from(`aa20${"ab".repeat(32)}87`, "hex"),
    );

    const id = covenantId(
      { txId: DEPLOY_TXID, index: 0 },
      [
        {
          index: 0,
          value: 50_000_000,
          version: 0,
          script: EVENT_SCRIPT,
        },
      ],
    );
    expect(Buffer.from(id).toString("hex")).toBe(GOLDEN);
  });
});

describe("KIP-20 covenant_id (sensitivity and validation)", () => {
  it("is sensitive to the output order (index), the script, and the value", () => {
    const base = covenantId(OUTPOINT, OUTPUTS);
    expect(
      covenantId(OUTPOINT, [
        { index: 0, value: 1, version: 0, script: script([OP_1]) },
        { index: 1, value: 0, version: 0, script: script([OP_2]) },
      ]),
    ).not.toEqual(base);
    expect(
      covenantId(OUTPOINT, [
        { index: 0, value: 0, version: 0, script: script([OP_3]) },
        { index: 1, value: 0, version: 0, script: script([OP_2]) },
      ]),
    ).not.toEqual(base);
  });

  it("is independent of the auth-output input order (sorted by index)", () => {
    const sorted = covenantId(OUTPOINT, OUTPUTS);
    expect(covenantId(OUTPOINT, [...OUTPUTS].reverse())).toEqual(sorted);
  });

  it("validates inputs", () => {
    expect(() =>
      covenantId({ txId: new Uint8Array(SHORT_HASH_LENGTH), index: 0 }, OUTPUTS),
    ).toThrow(CovenantIdError);
    const negativeValue: AuthorizedOutput = {
      index: 0,
      value: -1,
      version: 0,
      script: script([OP_1]),
    };
    expect(() => covenantId(OUTPOINT, [negativeValue])).toThrow(CovenantIdError);
  });
});
