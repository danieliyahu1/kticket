import { describe, expect, it } from "vitest";
import {
  decodeConstants,
  decodePreimage,
  decodeState,
  decodeVarint,
  encodeConstants,
  encodePreimage,
  encodeState,
  encodeVarint,
  PreimageError,
} from "./preimage";

const EVENT_ID = new Uint8Array(32).map((_, i) => (i === 0 ? 0xab : i));
const ORG_SPK = new Uint8Array([0x21, 0x02, 0x00, 0x01]);
const BURN_HASH = new Uint8Array(32).fill(0x77);

const CONSTANTS = {
  eventId: EVENT_ID,
  price: 123_456_789,
  orgSpk: ORG_SPK,
  burnTemplateHash: BURN_HASH,
};

describe("state_bytes layout (owner | identifier_type | amount | is_minter)", () => {
  it("encodes owner, identifier type, amount and is_minter in the pinned order", () => {
    const owner = new Uint8Array(32).fill(0x42);
    const state = encodeState(owner, 0, 10, false);
    expect(state).toHaveLength(42);
    expect([...state.slice(0, 32)]).toEqual([...owner]);
    expect(state[32]).toBe(0);
    expect(new DataView(state.buffer).getBigUint64(33, true)).toBe(10n);
    expect(state[41]).toBe(0);
  });

  it("round-trips event covenant and ticket covenant states", () => {
    const owner = new Uint8Array(32).fill(0x42);
    expect(decodeState(encodeState(owner, 0, 10))).toEqual({
      owner: expect.any(Uint8Array),
      identifierType: 0,
      amount: 10,
      isMinter: false,
    });
    expect(decodeState(encodeState(owner, 0, 1)).amount).toBe(1);
    expect([...decodeState(encodeState(owner, 0, 5)).owner]).toEqual([...owner]);
  });

  it("rejects an owner that is not 32 bytes and a negative amount", () => {
    expect(() => encodeState(new Uint8Array(31), 0, 1)).toThrow(PreimageError);
    expect(() => encodeState(new Uint8Array(32), 0, -1)).toThrow(PreimageError);
    expect(() => decodeState(new Uint8Array(41))).toThrow(PreimageError);
  });
});

describe("varint (LEB128) prefix", () => {
  it("encodes small values in one byte", () => {
    expect([...encodeVarint(0)]).toEqual([0x00]);
    expect([...encodeVarint(127)]).toEqual([0x7f]);
    expect([...encodeVarint(128)]).toEqual([0x80, 0x01]);
    expect([...encodeVarint(300)]).toEqual([0xac, 0x02]);
  });

  it("round-trips through decodeVarint", () => {
    for (const value of [0, 1, 127, 128, 255, 256, 65_535, 1_048_576]) {
      const encoded = encodeVarint(value);
      expect(decodeVarint(encoded, 0)).toEqual({ value, bytesRead: encoded.length });
    }
  });

  it("rejects a truncated varint", () => {
    expect(() => decodeVarint(new Uint8Array([0x80]), 0)).toThrow(PreimageError);
  });
});

describe("constants_bytes layout (HLD v0.22 §2.1)", () => {
  it("encodes the pinned field order and endianness", () => {
    const bytes = encodeConstants(CONSTANTS);
    // event_id[32] | price u64 LE | varbytes org_spk | burn_tmpl_hash[32]
    expect([...bytes.subarray(0, 32)]).toEqual([...EVENT_ID]);
    expect(new DataView(bytes.buffer).getBigUint64(32, true)).toBe(123_456_789n);
    // org_spk varbytes: LEB128 length 4 then the bytes
    expect(bytes[40]).toBe(4);
    expect([...bytes.subarray(41, 41 + ORG_SPK.length)]).toEqual([...ORG_SPK]);
    expect([...bytes.subarray(45, 77)]).toEqual([...BURN_HASH]);
    expect(bytes).toHaveLength(32 + 8 + 1 + ORG_SPK.length + 32);
  });

  it("round-trips constants", () => {
    const decoded = decodeConstants(encodeConstants(CONSTANTS));
    expect([...decoded.eventId]).toEqual([...EVENT_ID]);
    expect(decoded.price).toBe(123_456_789);
    expect([...decoded.orgSpk]).toEqual([...ORG_SPK]);
    expect([...decoded.burnTemplateHash]).toEqual([...BURN_HASH]);
  });

  it("supports empty org_spk", () => {
    const c = { ...CONSTANTS, orgSpk: new Uint8Array(0) };
    const decoded = decodeConstants(encodeConstants(c));
    expect(decoded.orgSpk).toHaveLength(0);
  });

  it("rejects malformed constants", () => {
    expect(() => decodeConstants(new Uint8Array(40))).toThrow(PreimageError);
    expect(() => encodeConstants({ ...CONSTANTS, eventId: new Uint8Array(31) })).toThrow(
      PreimageError,
    );
    expect(() => encodeConstants({ ...CONSTANTS, burnTemplateHash: new Uint8Array(31) })).toThrow(
      PreimageError,
    );
    expect(() => encodeConstants({ ...CONSTANTS, price: -1 })).toThrow(PreimageError);
  });
});

describe("decodePreimage", () => {
  it("recovers state + constants from an encoded preimage", () => {
    const owner = new Uint8Array(32).fill(0x42);
    const preimage = encodePreimage(
      { owner, identifierType: 0, amount: 1, isMinter: false },
      CONSTANTS,
    );
    const decoded = decodePreimage(new Uint8Array([...preimage.state, ...preimage.constants]));
    expect(decoded.state.amount).toBe(1);
    expect([...decoded.state.owner]).toEqual([...owner]);
    expect([...decoded.constants.eventId]).toEqual([...EVENT_ID]);
    expect(decoded.constants.price).toBe(123_456_789);
  });

  it("throws on a truncated preimage rather than guessing (DEC-12)", () => {
    const preimage = encodePreimage(
      { owner: new Uint8Array(32), identifierType: 0, amount: 1, isMinter: false },
      CONSTANTS,
    );
    expect(() => decodePreimage(preimage.state)).toThrow(PreimageError);
    expect(() => decodePreimage(new Uint8Array(10))).toThrow(PreimageError);
  });
});
