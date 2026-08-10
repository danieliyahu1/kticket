import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { EVENT_ARTIFACT } from "../contracts/artifacts";
import type { AddressNetwork } from "./address";
import {
  addressFor,
  addressFromScriptHash,
  availableTicketAddress,
  buildRedeemScript,
  encodeAddress,
  injectState,
  pushData,
  readStateFromRedeem,
  scriptHash,
} from "./address";

const HASH_LENGTH = 32;
const SCRIPT_HASH_VERSION_BYTE = 8;
const OVERLONG_HASH = HASH_LENGTH + 1;
const OWNER_FILL = 0x42;
const OTHER_OWNER_FILL = 0x01;
const ZERO_BYTE = 0x00;

const OWNER = new Uint8Array(HASH_LENGTH).fill(OWNER_FILL);
const ZERO_OWNER = new Uint8Array(HASH_LENGTH);

const ticketState = (owner: Uint8Array = ZERO_OWNER) => ({
  owner,
  identifierType: 0 as const,
  amount: 1,
  isMinter: false,
});

const eventState = (owner: Uint8Array = ZERO_OWNER) => ({
  owner,
  identifierType: 0 as const,
  amount: 100,
  isMinter: false,
});

describe("bech32 address encoding (vectors from crypto/addresses/src/lib.rs)", () => {
  it("matches the Rust reference vectors", () => {
    expect(encodeAddress("a", Uint8Array.from([SCRIPT_HASH_VERSION_BYTE]))).toBe("a:pq99546ray");
    expect(encodeAddress("a", Uint8Array.from([0]))).toBe("a:qqeq69uvrh");
  });
});

describe("redeem script assembly (bytecode with state injected into the slot)", () => {
  it("injects the push-encoded state into the artifact's state slot (KTK-88 A4)", () => {
    const redeem = buildRedeemScript(EVENT_ARTIFACT, ticketState(OWNER));
    const { start, len } = EVENT_ARTIFACT.state_layout;
    const bytecode = Uint8Array.from(EVENT_ARTIFACT.bytecode);

    // prefix + suffix preserved, slot replaced by the encoded state
    expect([...redeem.subarray(0, start)]).toEqual([...bytecode.subarray(0, start)]);
    expect([...redeem.subarray(start + len)]).toEqual([...bytecode.subarray(start + len)]);
    expect(redeem).toHaveLength(bytecode.length);
  });

  it("the assembled redeem script round-trips via readStateFromRedeem", () => {
    const redeem = buildRedeemScript(EVENT_ARTIFACT, ticketState(OWNER));
    const decoded = readStateFromRedeem(EVENT_ARTIFACT, redeem);
    expect([...decoded.owner]).toEqual([...OWNER]);
    expect(decoded.amount).toBe(1);
    expect(decoded.isMinter).toBe(false);
  });

  it("different state -> different redeem script (the slot differs)", () => {
    const a = injectState(EVENT_ARTIFACT, ticketState(ZERO_OWNER));
    const b = injectState(EVENT_ARTIFACT, ticketState(OWNER));
    expect([...a]).not.toEqual([...b]);
  });

  it("rejects a state slot that does not fit the artifact layout", () => {
    // Simulate a mismatched artifact by copying EVENT_ARTIFACT with a bad layout.
    const bad = { ...EVENT_ARTIFACT, state_layout: { start: 0, len: EVENT_ARTIFACT.state_layout.len + 1 } };
    expect(() => injectState(bad, ticketState(ZERO_OWNER))).toThrow();
  });
});

describe("scriptHash (blake3-32)", () => {
  it("equals BLAKE3 of the redeem script", () => {
    const redeem = buildRedeemScript(EVENT_ARTIFACT, ticketState(ZERO_OWNER));
    expect([...scriptHash(redeem)]).toEqual([...blake3(redeem)]);
    expect(scriptHash(redeem)).toHaveLength(HASH_LENGTH);
  });
});

describe("address derivation", () => {
  const network: AddressNetwork = "testnet10";

  it("addresses are deterministic for the same state", () => {
    const a = addressFor(EVENT_ARTIFACT, ticketState(ZERO_OWNER), network);
    const b = addressFor(EVENT_ARTIFACT, ticketState(ZERO_OWNER), network);
    expect(a).toBe(b);
    expect(a).toMatch(/^kaspatest:/);
  });

  it("ticket (amount 1) address differs from the event covenant (amount capacity)", () => {
    const ticket = addressFor(EVENT_ARTIFACT, ticketState(ZERO_OWNER), network);
    const eventCov = addressFor(EVENT_ARTIFACT, eventState(ZERO_OWNER), network);
    expect(ticket).not.toBe(eventCov);
  });

  it("different owner -> different address", () => {
    const a = addressFor(EVENT_ARTIFACT, ticketState(ZERO_OWNER), network);
    const b = addressFor(EVENT_ARTIFACT, ticketState(OWNER), network);
    expect(a).not.toBe(b);
  });

  it("testnet10 uses the kaspatest prefix", () => {
    expect(availableTicketAddress(EVENT_ARTIFACT, 0, "testnet10")).toMatch(/^kaspatest:/);
  });

  it("payload is the blake3 script hash under the ScriptHash version byte", () => {
    const redeem = buildRedeemScript(EVENT_ARTIFACT, ticketState(ZERO_OWNER));
    const hash = scriptHash(redeem);
    const expected = encodeAddress(
      "kaspatest",
      Uint8Array.from([SCRIPT_HASH_VERSION_BYTE, ...hash]),
    );
    expect(addressFor(EVENT_ARTIFACT, ticketState(ZERO_OWNER), network)).toBe(expected);
  });
});

describe("addressFromScriptHash (the reader's on-chain address derivation)", () => {
  const network: AddressNetwork = "testnet10";

  it("derives the same address as addressFor from the on-chain script hash", () => {
    const redeem = buildRedeemScript(EVENT_ARTIFACT, ticketState(ZERO_OWNER));
    const onChainScript = bytesToHex(scriptHash(redeem));
    expect(addressFromScriptHash(onChainScript, network)).toBe(
      addressFor(EVENT_ARTIFACT, ticketState(ZERO_OWNER), network),
    );
  });

  it("is stable under an uppercase script hex input", () => {
    const redeem = buildRedeemScript(EVENT_ARTIFACT, ticketState(OWNER));
    const onChainScript = bytesToHex(scriptHash(redeem)).toUpperCase();
    expect(addressFromScriptHash(onChainScript, network)).toBe(
      addressFor(EVENT_ARTIFACT, ticketState(OWNER), network),
    );
  });

  it("rejects a script that is not a 32-byte hash", () => {
    expect(() => addressFromScriptHash("00", network)).toThrow();
    expect(() => addressFromScriptHash("00".repeat(OVERLONG_HASH), network)).toThrow();
  });
});
