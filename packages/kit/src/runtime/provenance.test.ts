import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { EVENT_ARTIFACT } from "../contracts/artifacts";
import type { AddressNetwork } from "./address";
import { p2pkAddress, p2pkAddressFromScript, pubkeyFromP2pkScript } from "./address";
import {
  eventCommitmentMatches,
  eventOutputScript,
  recoverEventCapacity,
} from "./provenance";

const HASH_LENGTH = 32;
const OWNER_FILL = 0x42;

const NETWORK: AddressNetwork = "testnet10";
const OWNER = new Uint8Array(HASH_LENGTH).fill(OWNER_FILL);

function p2pkScript(pubkey: Uint8Array): string {
  return `20${bytesToHex(pubkey)}ac`;
}

describe("P2PK address derivation (organizer trust anchor)", () => {
  it("derives a kaspatest address from a 32-byte pubkey", () => {
    expect(p2pkAddress(OWNER, NETWORK)).toMatch(/^kaspatest:/);
  });

  it("round-trips a P2PK output script back to its address", () => {
    const script = p2pkScript(OWNER);
    expect(p2pkAddressFromScript(script, NETWORK)).toBe(p2pkAddress(OWNER, NETWORK));
  });

  it("pubkeyFromP2pkScript returns the 32-byte x-coordinate", () => {
    const pubkey = pubkeyFromP2pkScript(p2pkScript(OWNER));
    expect(pubkey).not.toBeNull();
    expect(bytesToHex(pubkey as Uint8Array)).toBe(bytesToHex(OWNER));
  });

  it("pubkeyFromP2pkScript rejects non-P2PK scripts", () => {
    expect(pubkeyFromP2pkScript("51")).toBeNull();
    expect(pubkeyFromP2pkScript("76a91400".repeat(10))).toBeNull();
    expect(pubkeyFromP2pkScript("aa20" + "00".repeat(HASH_LENGTH) + "87")).toBeNull();
  });
});

describe("event provenance commitment (KTK-89)", () => {
  it("eventOutputScript produces the on-chain P2SH form", () => {
    const script = eventOutputScript(EVENT_ARTIFACT, { owner: OWNER, amount: 3 });
    expect(script).toMatch(/^aa20[0-9a-f]{64}87$/);
  });

  it("the deploy covenant output matches the reconstructed script", () => {
    const onChain = eventOutputScript(EVENT_ARTIFACT, { owner: OWNER, amount: 3 });
    expect(
      eventCommitmentMatches(EVENT_ARTIFACT, { owner: OWNER, amount: 3 }, onChain),
    ).toBe(true);
  });

  it("a different state does not satisfy the commitment", () => {
    const onChain = eventOutputScript(EVENT_ARTIFACT, { owner: OWNER, amount: 3 });
    expect(
      eventCommitmentMatches(EVENT_ARTIFACT, { owner: OWNER, amount: 4 }, onChain),
    ).toBe(false);
    expect(
      eventCommitmentMatches(
        EVENT_ARTIFACT,
        { owner: new Uint8Array(HASH_LENGTH).fill(0x01), amount: 3 },
        onChain,
      ),
    ).toBe(false);
  });

  it("recoverEventCapacity finds the deployed capacity from the on-chain script", () => {
    const capacity = 3;
    const onChain = eventOutputScript(EVENT_ARTIFACT, { owner: OWNER, amount: capacity });
    expect(recoverEventCapacity(EVENT_ARTIFACT, OWNER, onChain)).toBe(capacity);
  });

  it("recoverEventCapacity scans up to MAX_EVENT_CAPACITY", () => {
    const capacity = 100;
    const onChain = eventOutputScript(EVENT_ARTIFACT, { owner: OWNER, amount: capacity });
    expect(recoverEventCapacity(EVENT_ARTIFACT, OWNER, onChain)).toBe(capacity);
  });

  it("recoverEventCapacity returns null when nothing matches", () => {
    const onChain = eventOutputScript(EVENT_ARTIFACT, { owner: OWNER, amount: 3 });
    const other = new Uint8Array(HASH_LENGTH).fill(0x07);
    expect(recoverEventCapacity(EVENT_ARTIFACT, other, onChain)).toBeNull();
  });

  it("treats a P2PK script hash as a distinct on-chain script", () => {
    const script = hexToBytes(p2pkScript(OWNER));
    const redeem = Uint8Array.from(EVENT_ARTIFACT.bytecode);
    expect(bytesToHex(script)).not.toBe(bytesToHex(redeem));
  });
});
