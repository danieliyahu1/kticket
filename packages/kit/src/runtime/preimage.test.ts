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
  index: 7,
  price: 123_456_789,
  orgSpk: ORG_SPK,
  burnTemplateHash: BURN_HASH,
};

describe("state_bytes layout (phase | owner)", () => {
  it("encodes phase and owner in the pinned order", () => {
    const owner = new Uint8Array(32).fill(0x42);
    const state = encodeState(1, owner);
    expect(state).toHaveLength(33);
    expect(state[0]).toBe(1);
    expect([...state.slice(1)]).toEqual([...owner]);
  });

  it("round-trips available / owned / gone phases", () => {
    const owner = new Uint8Array(32).fill(0x42);
    for (const phase of [0, 1, 2] as const) {
      expect(decodeState(encodeState(phase, owner))).toEqual({
        phase,
        owner: expect.any(Uint8Array),
      });
      expect([...decodeState(encodeState(phase, owner)).owner]).toEqual([...owner]);
    }
  });

  it("rejects an owner that is not 32 bytes", () => {
    expect(() => encodeState(1, new Uint8Array(31))).toThrow(PreimageError);
    expect(() => decodeState(new Uint8Array(32))).toThrow(PreimageError);
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

describe("constants_bytes layout (HLD §2.1)", () => {
  it("encodes the pinned field order and endianness", () => {
    const bytes = encodeConstants(CONSTANTS);
    // event_id[32] | index u32 LE | price u64 LE | varbytes org_spk | burn_tmpl_hash[32]
    expect([...bytes.subarray(0, 32)]).toEqual([...EVENT_ID]);
    expect(new DataView(bytes.buffer).getUint32(32, true)).toBe(7);
    expect(new DataView(bytes.buffer).getBigUint64(36, true)).toBe(123_456_789n);
    // org_spk varbytes: LEB128 length 4 then the bytes
    expect(bytes[44]).toBe(4);
    expect([...bytes.subarray(45, 45 + ORG_SPK.length)]).toEqual([...ORG_SPK]);
    expect([...bytes.subarray(49, 81)]).toEqual([...BURN_HASH]);
    expect(bytes).toHaveLength(32 + 4 + 8 + 1 + ORG_SPK.length + 32);
  });

  it("round-trips constants", () => {
    const decoded = decodeConstants(encodeConstants(CONSTANTS));
    expect([...decoded.eventId]).toEqual([...EVENT_ID]);
    expect(decoded.index).toBe(7);
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
    expect(() => encodeConstants({ ...CONSTANTS, index: 2 ** 32 })).toThrow(PreimageError);
  });
});

describe("decodePreimage", () => {
  it("recovers state + constants from an encoded preimage", () => {
    const owner = new Uint8Array(32).fill(0x42);
    const preimage = encodePreimage({ phase: 1, owner }, CONSTANTS);
    const decoded = decodePreimage(new Uint8Array([...preimage.state, ...preimage.constants]));
    expect(decoded.state.phase).toBe(1);
    expect([...decoded.state.owner]).toEqual([...owner]);
    expect([...decoded.constants.eventId]).toEqual([...EVENT_ID]);
    expect(decoded.constants.price).toBe(123_456_789);
  });

  it("throws on a truncated preimage rather than guessing (DEC-12)", () => {
    const preimage = encodePreimage({ phase: 0, owner: new Uint8Array(32) }, CONSTANTS);
    expect(() => decodePreimage(preimage.state)).toThrow(PreimageError);
    expect(() => decodePreimage(new Uint8Array(10))).toThrow(PreimageError);
  });
});
