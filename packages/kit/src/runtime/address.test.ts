import { blake3 } from "@noble/hashes/blake3.js";
import { describe, expect, it } from "vitest";
import type { AddressNetwork } from "./address";
import {
  addressFor,
  availableTicketAddress,
  buildRedeemScript,
  encodeAddress,
  pushData,
  scriptHash,
} from "./address";
import { decodePreimage, encodePreimage } from "./preimage";

const EVENT_ID = new Uint8Array(32).map((_, i) => (i === 0 ? 0xab : i));
const ORG_SPK = new Uint8Array([0x21, 0x02, 0x00, 0x01]);
const BURN_HASH = new Uint8Array(32).fill(0x77);
const CONSTANTS = {
  eventId: EVENT_ID,
  index: 3,
  price: 100,
  orgSpk: ORG_SPK,
  burnTemplateHash: BURN_HASH,
};
const CODE = new Uint8Array([0x00, 0x51]);

describe("bech32 address encoding (vectors from crypto/addresses/src/lib.rs)", () => {
  it("matches the Rust reference vectors", () => {
    expect(encodeAddress("a", Uint8Array.from([8]))).toBe("a:pq99546ray");
    expect(encodeAddress("a", Uint8Array.from([0]))).toBe("a:qqeq69uvrh");
  });
});

describe("redeem script assembly", () => {
  it("is OP_PUSH(state) OP_PUSH(constants) <code> (HLD §2.1)", () => {
    const preimage = encodePreimage({ phase: 1, owner: new Uint8Array(32).fill(0x42) }, CONSTANTS);
    const redeem = buildRedeemScript(
      { phase: 1, owner: new Uint8Array(32).fill(0x42) },
      CONSTANTS,
      CODE,
    );
    const statePush = pushData(preimage.state);
    const constantsPush = pushData(preimage.constants);
    expect(redeem).toHaveLength(statePush.length + constantsPush.length + CODE.length);
    expect([...redeem.subarray(0, statePush.length)]).toEqual([...statePush]);
    expect([...redeem.subarray(statePush.length, statePush.length + constantsPush.length)]).toEqual(
      [...constantsPush],
    );
    expect([...redeem.subarray(-CODE.length)]).toEqual([...CODE]);
  });

  it("the assembly is decodable back via the preimage layout", () => {
    const owner = new Uint8Array(32).fill(0x42);
    const redeem = buildRedeemScript({ phase: 1, owner }, CONSTANTS, CODE);
    const preimage = encodePreimage({ phase: 1, owner }, CONSTANTS);
    expect(decodePreimage(new Uint8Array([...preimage.state, ...preimage.constants]))).toEqual({
      state: { phase: 1, owner },
      constants: CONSTANTS,
    });
    expect(redeem).toBeInstanceOf(Uint8Array);
  });
});

describe("scriptHash (blake3-32)", () => {
  it("equals BLAKE3 of the redeem script", () => {
    const redeem = buildRedeemScript({ phase: 0, owner: new Uint8Array(32) }, CONSTANTS, CODE);
    expect([...scriptHash(redeem)]).toEqual([...blake3(redeem)]);
    expect(scriptHash(redeem)).toHaveLength(32);
  });
});

describe("address derivation", () => {
  const network: AddressNetwork = "testnet10";

  it("addresses are deterministic for the same state + constants", () => {
    const a = addressFor({ phase: 0, owner: new Uint8Array(32) }, CONSTANTS, CODE, network);
    const b = addressFor({ phase: 0, owner: new Uint8Array(32) }, CONSTANTS, CODE, network);
    expect(a).toBe(b);
    expect(a).toMatch(/^kaspatest:/);
  });

  it("phase-0 address differs from phase-1 (owner) address", () => {
    const available = availableTicketAddress(3, CONSTANTS, CODE, network);
    const owned = addressFor(
      { phase: 1, owner: new Uint8Array(32).fill(0x42) },
      CONSTANTS,
      CODE,
      network,
    );
    expect(available).not.toBe(owned);
  });

  it("different index -> different address", () => {
    expect(availableTicketAddress(0, CONSTANTS, CODE, network)).not.toBe(
      availableTicketAddress(1, CONSTANTS, CODE, network),
    );
  });

  it("mainnet uses the kaspa prefix", () => {
    expect(availableTicketAddress(0, CONSTANTS, CODE, "mainnet")).toMatch(/^kaspa:/);
  });

  it("payload is the blake3 script hash under the ScriptHash version byte", () => {
    const redeem = buildRedeemScript({ phase: 0, owner: new Uint8Array(32) }, CONSTANTS, CODE);
    const hash = scriptHash(redeem);
    const expected = encodeAddress("kaspatest", Uint8Array.from([8, ...hash]));
    expect(availableTicketAddress(3, CONSTANTS, CODE, network)).toBe(expected);
  });
});
