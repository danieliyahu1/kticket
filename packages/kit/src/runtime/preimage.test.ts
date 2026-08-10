import { describe, expect, it } from "vitest";
import { EVENT_ARTIFACT } from "../contracts/artifacts";
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

const HASH_LENGTH = 32;
const PRICE_SIZE = 8;
const VARLEN_SIZE = 1;
const ORG_SPK_VARLEN = 4;
const PRICE = 123_456_789;
const PRICE_BIG = 123_456_789n;

const EVENT_ID_SEED = 0xab;
const OWNER_FILL = 0x42;
const BURN_HASH_FILL = 0x77;
const ORG_SPK_PUSH = 0x21;
const ORG_SPK_PREFIX = 0x02;
const ORG_SPK_PAD = 0x00;
const ORG_SPK_TAIL = 0x01;

const ZERO_BYTE = 0x00;
const ONE_BYTE = 0x01;
const TWO_BYTE = 0x02;

const VARINT_127 = 127;
const VARINT_127_BYTE = 0x7f;
const VARINT_128 = 128;
const VARINT_128_HI = 0x80;
const VARINT_128_LO = ONE_BYTE;
const VARINT_300 = 300;
const VARINT_300_HI = 0xac;
const VARINT_300_LO = TWO_BYTE;
const VARINT_255 = 255;
const VARINT_256 = 256;
const VARINT_65535 = 65_535;
const VARINT_1048576 = 1_048_576;

const EVENT_ID = new Uint8Array(HASH_LENGTH).map((_, i) => (i === 0 ? EVENT_ID_SEED : i));
const ORG_SPK = new Uint8Array([ORG_SPK_PUSH, ORG_SPK_PREFIX, ORG_SPK_PAD, ORG_SPK_TAIL]);
const BURN_HASH = new Uint8Array(HASH_LENGTH).fill(BURN_HASH_FILL);

const ORG_SPK_OFFSET = HASH_LENGTH + PRICE_SIZE + VARLEN_SIZE;
const BURN_HASH_OFFSET = ORG_SPK_OFFSET + ORG_SPK.length;

const CONSTANTS = {
  authorizingTxId: EVENT_ID,
  price: PRICE,
  orgSpk: ORG_SPK,
  burnTemplateHash: BURN_HASH,
};

describe("state slot layout (push owner | push identifier_type | push amount | push is_minter)", () => {
  it("encodes each field as its own push, matching the artifact's state_layout length", () => {
    const owner = new Uint8Array(HASH_LENGTH).fill(OWNER_FILL);
    const state = encodeState(owner, 0, 10, false);
    expect(state).toHaveLength(EVENT_ARTIFACT.state_layout.len);
    // first push: 0x20 + 32 owner bytes
    expect(state[0]).toBe(0x20);
    expect([...state.subarray(1, 1 + HASH_LENGTH)]).toEqual([...owner]);
    // second push: 0x01 + identifier_type
    expect(state[33]).toBe(0x01);
    expect(state[34]).toBe(0);
    // third push: 0x08 + u64 LE amount
    expect(state[35]).toBe(0x08);
    expect(new DataView(state.buffer).getBigUint64(36, true)).toBe(10n);
    // fourth push: 0x01 + is_minter
    expect(state[44]).toBe(0x01);
    expect(state[45]).toBe(0);
  });

  it("round-trips event covenant and ticket covenant states", () => {
    const owner = new Uint8Array(HASH_LENGTH).fill(OWNER_FILL);
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
    expect(() => encodeState(new Uint8Array(HASH_LENGTH - 1), 0, 1)).toThrow(PreimageError);
    expect(() => encodeState(new Uint8Array(HASH_LENGTH), 0, -1)).toThrow(PreimageError);
    expect(() => decodeState(new Uint8Array(EVENT_ARTIFACT.state_layout.len - 1))).toThrow(
      PreimageError,
    );
  });
});

describe("varint (LEB128) prefix", () => {
  it("encodes small values in one byte", () => {
    expect([...encodeVarint(0)]).toEqual([ZERO_BYTE]);
    expect([...encodeVarint(VARINT_127)]).toEqual([VARINT_127_BYTE]);
    expect([...encodeVarint(VARINT_128)]).toEqual([VARINT_128_HI, VARINT_128_LO]);
    expect([...encodeVarint(VARINT_300)]).toEqual([VARINT_300_HI, VARINT_300_LO]);
  });

  it("round-trips through decodeVarint", () => {
    for (const value of [
      0,
      1,
      VARINT_127,
      VARINT_128,
      VARINT_255,
      VARINT_256,
      VARINT_65535,
      VARINT_1048576,
    ]) {
      const encoded = encodeVarint(value);
      expect(decodeVarint(encoded, 0)).toEqual({ value, bytesRead: encoded.length });
    }
  });

  it("rejects a truncated varint", () => {
    expect(() => decodeVarint(new Uint8Array([VARINT_128_HI]), 0)).toThrow(PreimageError);
  });
});

describe("constants_bytes layout (compile-time constructor args)", () => {
  it("encodes the pinned field order and endianness", () => {
    const bytes = encodeConstants(CONSTANTS);
    // authorizing_txid[32] | price u64 LE | varbytes org_spk | burn_tmpl_hash[32]
    expect([...bytes.subarray(0, HASH_LENGTH)]).toEqual([...EVENT_ID]);
    expect(new DataView(bytes.buffer).getBigUint64(HASH_LENGTH, true)).toBe(PRICE_BIG);
    // org_spk varbytes: LEB128 length 4 then the bytes
    expect(bytes[40]).toBe(ORG_SPK_VARLEN);
    expect([...bytes.subarray(ORG_SPK_OFFSET, ORG_SPK_OFFSET + ORG_SPK.length)]).toEqual([
      ...ORG_SPK,
    ]);
    expect([...bytes.subarray(BURN_HASH_OFFSET, BURN_HASH_OFFSET + HASH_LENGTH)]).toEqual([
      ...BURN_HASH,
    ]);
    expect(bytes).toHaveLength(
      HASH_LENGTH + PRICE_SIZE + VARLEN_SIZE + ORG_SPK.length + HASH_LENGTH,
    );
  });

  it("round-trips constants", () => {
    const decoded = decodeConstants(encodeConstants(CONSTANTS));
    expect([...decoded.authorizingTxId]).toEqual([...EVENT_ID]);
    expect(decoded.price).toBe(PRICE);
    expect([...decoded.orgSpk]).toEqual([...ORG_SPK]);
    expect([...decoded.burnTemplateHash]).toEqual([...BURN_HASH]);
  });

  it("supports empty org_spk", () => {
    const c = { ...CONSTANTS, orgSpk: new Uint8Array(0) };
    const decoded = decodeConstants(encodeConstants(c));
    expect(decoded.orgSpk).toHaveLength(0);
  });
});

describe("constants_bytes validation", () => {
  it("rejects malformed constants", () => {
    expect(() => decodeConstants(new Uint8Array(HASH_LENGTH + PRICE_SIZE))).toThrow(PreimageError);
    expect(() =>
      encodeConstants({ ...CONSTANTS, authorizingTxId: new Uint8Array(HASH_LENGTH - 1) }),
    ).toThrow(PreimageError);
    expect(() =>
      encodeConstants({ ...CONSTANTS, burnTemplateHash: new Uint8Array(HASH_LENGTH - 1) }),
    ).toThrow(PreimageError);
    expect(() => encodeConstants({ ...CONSTANTS, price: -1 })).toThrow(PreimageError);
  });
});

describe("decodePreimage", () => {
  it("recovers state + constants from an encoded preimage", () => {
    const owner = new Uint8Array(HASH_LENGTH).fill(OWNER_FILL);
    const preimage = encodePreimage(
      { owner, identifierType: 0, amount: 1, isMinter: false },
      CONSTANTS,
    );
    const decoded = decodePreimage(new Uint8Array([...preimage.state, ...preimage.constants]));
    expect(decoded.state.amount).toBe(1);
    expect([...decoded.state.owner]).toEqual([...owner]);
    expect([...decoded.constants.authorizingTxId]).toEqual([...EVENT_ID]);
    expect(decoded.constants.price).toBe(PRICE);
  });

  it("throws on a truncated preimage rather than guessing (DEC-12)", () => {
    const preimage = encodePreimage(
      { owner: new Uint8Array(HASH_LENGTH), identifierType: 0, amount: 1, isMinter: false },
      CONSTANTS,
    );
    expect(() => decodePreimage(new Uint8Array(10))).toThrow(PreimageError);
  });
});
