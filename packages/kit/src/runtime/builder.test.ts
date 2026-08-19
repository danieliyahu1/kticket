import { bytesToHex } from "@noble/hashes/utils.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { describe, expect, it } from "vitest";
import { BURN_ARTIFACT, EVENT_ARTIFACT } from "../contracts/artifacts";
import type { AddressNetwork } from "./address";
import {
  buildBuy,
  buildDeploy,
  buildHandover,
  burnScript,
  burnTemplateHash,
  EVENT_DUST,
  TICKET_DUST,
} from "./builder";
import type { Outpoint } from "./covenant";
import { covenantId } from "./covenant";
import type { ScriptPublicKey } from "./tx";

const HASH_LENGTH = 32;
const EVENT_ID_SEED = 0xab;
const ORG_FILL = 0x01;
const BUYER_FILL = 0x02;
const FUNDED_UTXO_VALUE = 10_000_000_000;
const TINY_UTXO_VALUE = 1_000;
const INSUFFICIENT_BUYER_UTXO_VALUE = 500;
const DEPLOY_FEE = 1_000;
const BUY_FEE = 1_000;
const HANDOVER_FEE = 400;
const BUY_OUTPUT_COUNT = 4;
const FREE_TICKET_OUTPUT_COUNT = 3;
const HANDOVER_TICKET_INDEX = 4;
const PRICE = 1_000;

const NETWORK: AddressNetwork = "testnet10";

const orgScript: ScriptPublicKey = { version: 0, script: "51" };
const changeScript: ScriptPublicKey = { version: 0, script: "51" };

function outpoint(txIdHex: string, index: number): Outpoint {
  const txId = new Uint8Array(HASH_LENGTH);
  const bytes = Uint8Array.from(Buffer.from(txIdHex, "hex"));
  txId.set(bytes.subarray(0, HASH_LENGTH));
  return { txId, index };
}

const EVENT_COVENANT_ID = "ab".repeat(HASH_LENGTH);
const AUTHORIZING = outpoint("ab".repeat(HASH_LENGTH), 0);
const EVENT_UTXO = outpoint("ab".repeat(HASH_LENGTH), 0);
const BUYER_UTXO = outpoint("bb".repeat(HASH_LENGTH), 0);
const ATTENDEE_UTXO = outpoint("dd".repeat(HASH_LENGTH), 0);

const ORG = new Uint8Array(HASH_LENGTH).fill(ORG_FILL);
const BUYER = new Uint8Array(HASH_LENGTH).fill(BUYER_FILL);

function deployArgs(
  overrides: Partial<Parameters<typeof buildDeploy>[0]> = {},
): Parameters<typeof buildDeploy>[0] {
  return {
    authorizingOutpoint: AUTHORIZING,
    organizerUtxos: [],
    organizerUtxoValues: [FUNDED_UTXO_VALUE],
    organizer: ORG,
    capacity: 100,
    eventArtifact: EVENT_ARTIFACT,
    changeScript,
    fee: DEPLOY_FEE,
    network: NETWORK,
    ...overrides,
  };
}

function buyArgs(
  overrides: Partial<Parameters<typeof buildBuy>[0]> = {},
): Parameters<typeof buildBuy>[0] {
  return {
    eventOutpoint: EVENT_UTXO,
    eventCovenantId: EVENT_COVENANT_ID,
    eventOwner: ORG,
    eventArtifact: EVENT_ARTIFACT,
    buyer: BUYER,
    buyerUtxos: [BUYER_UTXO],
    buyerUtxoValues: [FUNDED_UTXO_VALUE],
    orgScript,
    changeScript,
    remaining: 100,
    price: PRICE,
    network: NETWORK,
    fee: BUY_FEE,
    ...overrides,
  };
}

describe("buildDeploy (HLD v0.22 §2.1)", () => {
  it("creates one event covenant (remaining = capacity) + change, all bound to one covenant id", () => {
    const { tx, eventCovenantId } = buildDeploy(deployArgs());

    expect(tx.version).toBe(1);
    expect(tx.inputs).toHaveLength(1);
    expect(tx.outputs).toHaveLength(2); // event covenant + change
    expect(eventCovenantId).toMatch(/^[0-9a-f]{64}$/);

    const [event, change] = tx.outputs;
    expect(event?.value).toBe(EVENT_DUST);
    expect(event?.covenant).toEqual({ authorizingInput: 0, covenantId: eventCovenantId });
    expect(change?.value).toBe(FUNDED_UTXO_VALUE - EVENT_DUST - DEPLOY_FEE);
    expect(change?.covenant).toBeNull();
  });
});

describe("buildDeploy: covenant id (KIP-20)", () => {
  it("event covenant id is the KIP-20 hash of the authorizing outpoint + event output", () => {
    const { tx, eventCovenantId } = buildDeploy(deployArgs({ capacity: 2, fee: 100 }));
    const authOutputs = tx.outputs.slice(0, 1).map((output, index) => ({
      index,
      value: output.value,
      version: output.scriptPublicKey.version,
      script: Uint8Array.from(Buffer.from(output.scriptPublicKey.script, "hex")),
    }));
    expect(Buffer.from(covenantId(AUTHORIZING, authOutputs)).toString("hex")).toBe(eventCovenantId);
  });
});

describe("buildDeploy: validation", () => {
  it("rejects capacity > 100 and inputs that cannot cover dust + fee", () => {
    expect(() => buildDeploy(deployArgs({ capacity: 101 }))).toThrow(/capacity/);

    expect(() => buildDeploy(deployArgs({ organizerUtxoValues: [TINY_UTXO_VALUE] }))).toThrow(
      /cannot cover/,
    );
  });
});

describe("buildBuy (mint on sale, HLD v0.22)", () => {
  it("splits the event covenant: ticket + remaining event + payout + change", () => {
    const tx = buildBuy(buyArgs());

    expect(tx.inputs).toHaveLength(2); // event covenant + buyer KAS
    expect(tx.outputs).toHaveLength(BUY_OUTPUT_COUNT); // ticket + remaining event + payout + change
    const [ticket, remainingEvent, payout, change] = tx.outputs;
    expect(ticket?.value).toBe(TICKET_DUST);
    expect(ticket?.covenant).toEqual({ authorizingInput: 0, covenantId: EVENT_COVENANT_ID });
    expect(remainingEvent?.value).toBe(EVENT_DUST);
    expect(remainingEvent?.covenant?.covenantId).toBe(EVENT_COVENANT_ID);
    expect(payout).toEqual({ value: PRICE, scriptPublicKey: orgScript, covenant: null });
    expect(change?.value).toBe(FUNDED_UTXO_VALUE - PRICE - TICKET_DUST - BUY_FEE);
  });
});

describe("buildBuy: free tickets", () => {
  it("free ticket (price 0) has no payout output", () => {
    const tx = buildBuy(buyArgs({ price: 0, fee: 500 }));
    expect(tx.outputs).toHaveLength(FREE_TICKET_OUTPUT_COUNT); // ticket + remaining event + change
    expect(tx.outputs[0]?.covenant?.covenantId).toBe(EVENT_COVENANT_ID);
  });
});

describe("buildBuy: validation", () => {
  it("rejects when the event is exhausted", () => {
    expect(() => buildBuy(buyArgs({ remaining: 0 }))).toThrow(/remaining/);
  });

  it("rejects when buyer inputs cannot cover price + ticket dust + fee", () => {
    expect(() =>
      buildBuy(
        buyArgs({
          buyerUtxoValues: [INSUFFICIENT_BUYER_UTXO_VALUE],
          remaining: 10,
        }),
      ),
    ).toThrow(/cannot cover/);
  });
});

describe("buildHandover", () => {
  it("successor is the event burn-owner covenant bound to the same covenant id (FR-9)", () => {
    const tx = buildHandover({
      ticketOutpoint: outpoint("ee".repeat(HASH_LENGTH), HANDOVER_TICKET_INDEX),
      eventCovenantId: EVENT_COVENANT_ID,
      burnArtifact: BURN_ARTIFACT,
      attendeeUtxos: [ATTENDEE_UTXO],
      attendeeUtxoValues: [FUNDED_UTXO_VALUE],
      changeScript,
      network: NETWORK,
      fee: HANDOVER_FEE,
    });
    expect(tx.outputs).toHaveLength(2);
    const burn = tx.outputs[0];
    expect(burn?.value).toBe(TICKET_DUST);
    expect(burn?.covenant).toEqual({ authorizingInput: 0, covenantId: EVENT_COVENANT_ID });
    expect(burn?.scriptPublicKey).toEqual(burnScript(BURN_ARTIFACT));
    expect(tx.outputs[1]?.value).toBe(FUNDED_UTXO_VALUE - HANDOVER_FEE);
  });

  it("burn script is fixed per event", () => {
    expect(burnScript(BURN_ARTIFACT)).toEqual(burnScript(BURN_ARTIFACT));
  });
});

describe("burnTemplateHash (reader's GONE check)", () => {
  it("equals the on-chain burn output script hash from the handover builder", () => {
    const burnScriptHash = burnScript(BURN_ARTIFACT).script;
    const p2shPrefixHexLen = 4;
    const p2shSuffixHexLen = 2;
    expect(burnTemplateHash(BURN_ARTIFACT)).toBe(
      burnScriptHash.slice(p2shPrefixHexLen, burnScriptHash.length - p2shSuffixHexLen),
    );
  });
});

describe("golden template_hash (KTK-88 A6)", () => {
  it("the event artifact's template_hash is the pinned golden value (silverscript rev 80d715f7)", () => {
    expect(bytesToHex(Uint8Array.from(EVENT_ARTIFACT.template_hash))).toBe(
      "c4bc6a6b516df42e210490f8da2e816b5824b0eb9952191013ae6e3b9f5d6fda",
    );
  });

  it("the burn artifact's template_hash is the pinned golden value (silverscript rev 80d715f7)", () => {
    expect(bytesToHex(Uint8Array.from(BURN_ARTIFACT.template_hash))).toBe(
      "d1c7d27d615b2d41183eee7bc02b259896e5b14638b6f0fd682bcdc171e7827c",
    );
  });

  it("template_hash commits to the prefix/suffix boundary (blake2b length-prefixed)", () => {
    const { start, len } = EVENT_ARTIFACT.state_layout;
    const prefix = Uint8Array.from(EVENT_ARTIFACT.bytecode.slice(0, start));
    const suffix = Uint8Array.from(EVENT_ARTIFACT.bytecode.slice(start + len));

    const TEMPLATE_PART_LENGTH_BYTES = 8;
    const le64 = (value: number) => {
      const out = new Uint8Array(TEMPLATE_PART_LENGTH_BYTES);
      new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
      return out;
    };
    const preimage = new Uint8Array(
      TEMPLATE_PART_LENGTH_BYTES + prefix.length + TEMPLATE_PART_LENGTH_BYTES + suffix.length,
    );
    preimage.set(le64(prefix.length), 0);
    preimage.set(prefix, TEMPLATE_PART_LENGTH_BYTES);
    preimage.set(
      le64(suffix.length),
      TEMPLATE_PART_LENGTH_BYTES + prefix.length,
    );
    preimage.set(
      suffix,
      TEMPLATE_PART_LENGTH_BYTES + prefix.length + TEMPLATE_PART_LENGTH_BYTES,
    );
    expect(bytesToHex(blake2b(preimage, { dkLen: 32 }))).toBe(
      bytesToHex(Uint8Array.from(EVENT_ARTIFACT.template_hash)),
    );
  });
});
