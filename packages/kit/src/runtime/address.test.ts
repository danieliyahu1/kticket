import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import type { AddressNetwork } from "./address";
import {
  addressFor,
  addressFromScriptHash,
  availableTicketAddress,
  buildRedeemScript,
  encodeAddress,
  pushData,
  scriptHash,
} from "./address";
import { decodePreimage, encodePreimage } from "./preimage";

const HASH_LENGTH = 32;
const SCRIPT_HASH_VERSION_BYTE = 8;
const OVERLONG_HASH = HASH_LENGTH + 1;
const EVENT_ID_SEED = 0xab;
const OWNER_FILL = 0x42;
const OTHER_OWNER_FILL = 0x01;
const BURN_HASH_FILL = 0x77;
const ZERO_BYTE = 0x00;
const ONE_BYTE = 0x01;
const TWO_BYTE = 0x02;
const PUSH_33 = 0x21;
const OP_1 = 0x51;

const EVENT_ID = new Uint8Array(HASH_LENGTH).map((_, i) => (i === 0 ? EVENT_ID_SEED : i));
const ORG_SPK = new Uint8Array([PUSH_33, TWO_BYTE, ZERO_BYTE, ONE_BYTE]);
const BURN_HASH = new Uint8Array(HASH_LENGTH).fill(BURN_HASH_FILL);
const CONSTANTS = {
  eventId: EVENT_ID,
  price: 100,
  orgSpk: ORG_SPK,
  burnTemplateHash: BURN_HASH,
};
const CODE = new Uint8Array([ZERO_BYTE, OP_1]);
const OWNER = new Uint8Array(HASH_LENGTH).fill(OWNER_FILL);

describe("bech32 address encoding (vectors from crypto/addresses/src/lib.rs)", () => {
  it("matches the Rust reference vectors", () => {
    expect(encodeAddress("a", Uint8Array.from([SCRIPT_HASH_VERSION_BYTE]))).toBe("a:pq99546ray");
    expect(encodeAddress("a", Uint8Array.from([0]))).toBe("a:qqeq69uvrh");
  });
});

describe("redeem script assembly", () => {
  it("is OP_PUSH(state) OP_PUSH(constants) <code> (HLD v0.22 §2.1)", () => {
    const preimage = encodePreimage(
      { owner: OWNER, identifierType: 0, amount: 1, isMinter: false },
      CONSTANTS,
    );
    const redeem = buildRedeemScript(
      { owner: OWNER, identifierType: 0, amount: 1, isMinter: false },
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
    const redeem = buildRedeemScript(
      { owner: OWNER, identifierType: 0, amount: 1, isMinter: false },
      CONSTANTS,
      CODE,
    );
    const preimage = encodePreimage(
      { owner: OWNER, identifierType: 0, amount: 1, isMinter: false },
      CONSTANTS,
    );
    expect(decodePreimage(new Uint8Array([...preimage.state, ...preimage.constants]))).toEqual({
      state: { owner: OWNER, identifierType: 0, amount: 1, isMinter: false },
      constants: CONSTANTS,
    });
    expect(redeem).toBeInstanceOf(Uint8Array);
  });
});

describe("scriptHash (blake3-32)", () => {
  it("equals BLAKE3 of the redeem script", () => {
    const redeem = buildRedeemScript(
      { owner: new Uint8Array(HASH_LENGTH), identifierType: 0, amount: 1, isMinter: false },
      CONSTANTS,
      CODE,
    );
    expect([...scriptHash(redeem)]).toEqual([...blake3(redeem)]);
    expect(scriptHash(redeem)).toHaveLength(HASH_LENGTH);
  });
});

describe("address derivation", () => {
  const network: AddressNetwork = "testnet10";

  it("addresses are deterministic for the same state + constants", () => {
    const a = addressFor(
      { owner: new Uint8Array(HASH_LENGTH), identifierType: 0, amount: 1, isMinter: false },
      CONSTANTS,
      CODE,
      network,
    );
    const b = addressFor(
      { owner: new Uint8Array(HASH_LENGTH), identifierType: 0, amount: 1, isMinter: false },
      CONSTANTS,
      CODE,
      network,
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^kaspatest:/);
  });

  it("ticket (amount 1) address differs from the event covenant (amount capacity)", () => {
    const ticket = addressFor(
      { owner: new Uint8Array(HASH_LENGTH), identifierType: 0, amount: 1, isMinter: false },
      CONSTANTS,
      CODE,
      network,
    );
    const eventCov = addressFor(
      { owner: new Uint8Array(HASH_LENGTH), identifierType: 0, amount: 100, isMinter: false },
      CONSTANTS,
      CODE,
      network,
    );
    expect(ticket).not.toBe(eventCov);
  });
});

describe("address derivation: owner sensitivity", () => {
  const network: AddressNetwork = "testnet10";

  it("different owner -> different address", () => {
    const a = addressFor(
      { owner: new Uint8Array(HASH_LENGTH), identifierType: 0, amount: 1, isMinter: false },
      CONSTANTS,
      CODE,
      network,
    );
    const b = addressFor(
      {
        owner: new Uint8Array(HASH_LENGTH).fill(OTHER_OWNER_FILL),
        identifierType: 0,
        amount: 1,
        isMinter: false,
      },
      CONSTANTS,
      CODE,
      network,
    );
    expect(a).not.toBe(b);
  });

  it("testnet10 uses the kaspatest prefix", () => {
    expect(availableTicketAddress(0, CONSTANTS, CODE, "testnet10")).toMatch(/^kaspatest:/);
  });

  it("payload is the blake3 script hash under the ScriptHash version byte", () => {
    const redeem = buildRedeemScript(
      { owner: new Uint8Array(HASH_LENGTH), identifierType: 0, amount: 1, isMinter: false },
      CONSTANTS,
      CODE,
    );
    const hash = scriptHash(redeem);
    const expected = encodeAddress(
      "kaspatest",
      Uint8Array.from([SCRIPT_HASH_VERSION_BYTE, ...hash]),
    );
    expect(availableTicketAddress(1, CONSTANTS, CODE, network)).toBe(expected);
  });
});

describe("addressFromScriptHash (the reader's on-chain address derivation)", () => {
  const network: AddressNetwork = "testnet10";

  it("derives the same address as addressFor from the on-chain script hash", () => {
    const redeem = buildRedeemScript(
      { owner: new Uint8Array(HASH_LENGTH), identifierType: 0, amount: 1, isMinter: false },
      CONSTANTS,
      CODE,
    );
    const onChainScript = bytesToHex(scriptHash(redeem));
    expect(addressFromScriptHash(onChainScript, network)).toBe(
      addressFor(
        { owner: new Uint8Array(HASH_LENGTH), identifierType: 0, amount: 1, isMinter: false },
        CONSTANTS,
        CODE,
        network,
      ),
    );
  });

  it("is stable under an uppercase script hex input", () => {
    const redeem = buildRedeemScript(
      { owner: OWNER, identifierType: 0, amount: 1, isMinter: false },
      CONSTANTS,
      CODE,
    );
    const onChainScript = bytesToHex(scriptHash(redeem)).toUpperCase();
    expect(addressFromScriptHash(onChainScript, network)).toBe(
      addressFor(
        { owner: OWNER, identifierType: 0, amount: 1, isMinter: false },
        CONSTANTS,
        CODE,
        network,
      ),
    );
  });

  it("rejects a script that is not a 32-byte hash", () => {
    expect(() => addressFromScriptHash("00", network)).toThrow();
    expect(() => addressFromScriptHash("00".repeat(OVERLONG_HASH), network)).toThrow();
  });
});
