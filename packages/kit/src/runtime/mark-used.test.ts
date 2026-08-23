import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { EVENT_ARTIFACT } from "../contracts/artifacts.js";
import {
  assembleMarkUsedSigScript,
  markUsedSelector,
  pushSelector,
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

describe("markUsedSelector", () => {
  it("derives the mark_used branch index from the artifact ABI", () => {
    // The event contract's auth entrypoints in order: mint (0), mark_used (1),
    // list (2), purchase (3), delist (4). The selector is the branch index the
    // compiler emits — matching silverc's `function_branch_index`.
    expect(markUsedSelector(EVENT_ARTIFACT)).toBe(1);
  });
});

describe("pushSelector", () => {
  it("encodes 0 as OP_0 and 1..16 as OP_1..OP_16 (ScriptBuilder::add_i64)", () => {
    expect(bytesToHex(pushSelector(0))).toBe("00");
    expect(bytesToHex(pushSelector(1))).toBe("51");
    expect(bytesToHex(pushSelector(2))).toBe("52");
    expect(bytesToHex(pushSelector(16))).toBe("60");
  });

  it("rejects selectors outside the OP_N range", () => {
    expect(() => pushSelector(-1)).toThrow("out of the OP_N range");
    expect(() => pushSelector(17)).toThrow("out of the OP_N range");
  });
});

describe("assembleMarkUsedSigScript", () => {
  it("assembles push(sig) push(sig) <selector> push(redeem) byte-exactly", () => {
    const redeem = ticketRedeem(false);
    const script = assembleMarkUsedSigScript(EVENT_ARTIFACT, SIG_OWNER, SIG_GATE, redeem);
    // silverc emits the same bytes for mark_used: two 65-byte pushes (0x41),
    // then OP_1 (selector 1), then the redeem reveal push.
    expect(script).toEqual(
      concat([pushData(SIG_OWNER), pushData(SIG_GATE), pushSelector(1), pushData(redeem)]),
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
