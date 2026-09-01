import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { EVENT_ARTIFACT } from "../contracts/artifacts.js";
import {
  assembleMarkUsedSigScript,
  dispatchTagBytes,
  markUsedDispatchTag,
  SIG_PUSH_LENGTH,
  usedStateAddress,
} from "./mark-used.js";
import { addressFor, injectState, pushData } from "./address.js";
import { concat } from "./bytes.js";

const OWNER = new Uint8Array(32).fill(0x42);
const SIG_OWNER = new Uint8Array(SIG_PUSH_LENGTH).fill(0x11);
const SIG_GATE = new Uint8Array(SIG_PUSH_LENGTH).fill(0x22);

const ticketRedeem = (used: boolean) =>
  injectState(EVENT_ARTIFACT, {
    owner: OWNER,
    identifierType: 0,
    amount: 1,
    isMinter: false,
    used,
    salePrice: 0,
  });

describe("markUsedDispatchTag", () => {
  it("reads the mark_used dispatch tag from the artifact ABI", () => {
    expect(bytesToHex(markUsedDispatchTag(EVENT_ARTIFACT))).toBe("969d6dc2");
  });
});

describe("dispatchTagBytes", () => {
  it("decodes a four-byte lowercase hex tag", () => {
    expect(bytesToHex(dispatchTagBytes("969d6dc2"))).toBe("969d6dc2");
  });

  it("rejects malformed dispatch tags", () => {
    expect(() => dispatchTagBytes("969d6d")).toThrow("invalid dispatch tag");
    expect(() => dispatchTagBytes("969D6DC2")).toThrow("invalid dispatch tag");
  });
});

describe("assembleMarkUsedSigScript", () => {
  it("assembles push(sig) push(sig) push(dispatch_tag) push(redeem) byte-exactly", () => {
    const redeem = ticketRedeem(false);
    const script = assembleMarkUsedSigScript(EVENT_ARTIFACT, SIG_OWNER, SIG_GATE, redeem);
    // silverc emits the same bytes for mark_used: two 65-byte pushes (0x41),
    // then the four-byte dispatch tag, then the redeem reveal push.
    expect(script).toEqual(
      concat([
        pushData(SIG_OWNER),
        pushData(SIG_GATE),
        pushData(dispatchTagBytes("969d6dc2")),
        pushData(redeem),
      ]),
    );
  });

  it("rejects a non-65-byte owner signature", () => {
    const redeem = ticketRedeem(false);
    expect(() =>
      assembleMarkUsedSigScript(EVENT_ARTIFACT, new Uint8Array(64), SIG_GATE, redeem),
    ).toThrow("sig_owner must be 65 bytes");
  });

  it("rejects a non-65-byte gate signature", () => {
    const redeem = ticketRedeem(false);
    expect(() =>
      assembleMarkUsedSigScript(EVENT_ARTIFACT, SIG_OWNER, new Uint8Array(66), redeem),
    ).toThrow("sig_gate must be 65 bytes");
  });

  it("requires both signatures (never assembles a single-sig script)", () => {
    const redeem = ticketRedeem(false);
    expect(() =>
      assembleMarkUsedSigScript(EVENT_ARTIFACT, SIG_OWNER, new Uint8Array(0), redeem),
    ).toThrow();
  });
});

describe("usedStateAddress", () => {
  const network = "testnet10" as const;

  it("derives distinct addresses for used:false vs used:true tickets", () => {
    const unused = usedStateAddress(EVENT_ARTIFACT, OWNER, false, network);
    const used = usedStateAddress(EVENT_ARTIFACT, OWNER, true, network);
    expect(unused).toMatch(/^kaspatest:/);
    expect(used).toMatch(/^kaspatest:/);
    expect(used).not.toBe(unused);
  });

  it("matches addressFor for the same ticket state (reader equivalence)", () => {
    // The reader compares a live coin's address against these — it must equal
    // the address the owner's ticket output would carry at the same state.
    const address = usedStateAddress(EVENT_ARTIFACT, OWNER, false, network);
    const expected = addressFor(
      EVENT_ARTIFACT,
      { owner: OWNER, identifierType: 0, amount: 1, isMinter: false, used: false, salePrice: 0 },
      network,
    );
    expect(address).toBe(expected);
  });

  it("uses the kaspatest (testnet10) prefix", () => {
    expect(usedStateAddress(EVENT_ARTIFACT, OWNER, false, network).startsWith("kaspatest:")).toBe(true);
  });
});
