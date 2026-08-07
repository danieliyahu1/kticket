import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import type { AddressNetwork } from "./address";
import {
  buildBuy,
  buildDeploy,
  buildHandover,
  buildTransfer,
  burnScript,
  burnTemplateHash,
  EVENT_DUST,
  TICKET_DUST,
} from "./builder";
import type { Outpoint } from "./covenant";
import { covenantId } from "./covenant";
import type { DecodedConstants } from "./preimage";
import type { ScriptPublicKey } from "./tx";

const NETWORK: AddressNetwork = "testnet10";
const COVENANT_CODE = new Uint8Array([0x00, 0x51]);
const BURN_CODE = new Uint8Array([0x00, 0x00]);

const EVENT_ID = new Uint8Array(32).map((_, i) => (i === 0 ? 0xab : i));
const ORG_SPK = new Uint8Array([0x21, 0x02, 0x00, 0x01]);
const BURN_HASH = new Uint8Array(32).fill(0x77);
const CONSTANTS: DecodedConstants = {
  eventId: EVENT_ID,
  price: 1_000,
  orgSpk: ORG_SPK,
  burnTemplateHash: BURN_HASH,
};

const orgScript: ScriptPublicKey = { version: 0, script: "51" };
const changeScript: ScriptPublicKey = { version: 0, script: "51" };

function outpoint(txIdHex: string, index: number): Outpoint {
  const txId = new Uint8Array(32);
  const bytes = Uint8Array.from(Buffer.from(txIdHex, "hex"));
  txId.set(bytes.subarray(0, 32));
  return { txId, index };
}

const AUTHORIZING = outpoint("ab".repeat(32), 0);
const EVENT_UTXO = outpoint("ab".repeat(32), 0);
const BUYER_UTXO = outpoint("bb".repeat(32), 0);
const HOLDER_UTXO = outpoint("cc".repeat(32), 0);
const ATTENDEE_UTXO = outpoint("dd".repeat(32), 0);

const ORG = new Uint8Array(32).fill(0x01);
const BUYER = new Uint8Array(32).fill(0x02);

describe("buildDeploy (HLD v0.22 §2.1)", () => {
  it("creates one event covenant (remaining = capacity) + change, all bound to one covenant id", () => {
    const { tx, eventCovenantId } = buildDeploy({
      authorizingOutpoint: AUTHORIZING,
      organizerUtxos: [],
      organizerUtxoValues: [10_000_000_000],
      organizer: ORG,
      capacity: 100,
      constants: CONSTANTS,
      covenantCode: COVENANT_CODE,
      changeScript,
      fee: 1_000,
      network: NETWORK,
    });

    expect(tx.version).toBe(1);
    expect(tx.inputs).toHaveLength(1);
    expect(tx.outputs).toHaveLength(2); // event covenant + change
    expect(eventCovenantId).toMatch(/^[0-9a-f]{64}$/);

    const [event, change] = tx.outputs;
    expect(event?.value).toBe(EVENT_DUST);
    expect(event?.covenant).toEqual({ authorizingInput: 0, covenantId: eventCovenantId });
    expect(change?.value).toBe(10_000_000_000 - EVENT_DUST - 1_000);
    expect(change?.covenant).toBeNull();
  });

  it("event covenant id is the KIP-20 hash of the authorizing outpoint + event output", () => {
    const { tx, eventCovenantId } = buildDeploy({
      authorizingOutpoint: AUTHORIZING,
      organizerUtxos: [],
      organizerUtxoValues: [10_000_000_000],
      organizer: ORG,
      capacity: 2,
      constants: CONSTANTS,
      covenantCode: COVENANT_CODE,
      changeScript,
      fee: 100,
      network: NETWORK,
    });
    const authOutputs = tx.outputs.slice(0, 1).map((output, index) => ({
      index,
      value: output.value,
      version: output.scriptPublicKey.version,
      script: Uint8Array.from(Buffer.from(output.scriptPublicKey.script, "hex")),
    }));
    expect(Buffer.from(covenantId(AUTHORIZING, authOutputs)).toString("hex")).toBe(eventCovenantId);
  });

  it("rejects capacity > 100 and inputs that cannot cover dust + fee", () => {
    expect(() =>
      buildDeploy({
        authorizingOutpoint: AUTHORIZING,
        organizerUtxos: [],
        organizerUtxoValues: [10_000_000_000],
        organizer: ORG,
        capacity: 101,
        constants: CONSTANTS,
        covenantCode: COVENANT_CODE,
        changeScript,
        fee: 100,
        network: NETWORK,
      }),
    ).toThrow(/capacity/);

    expect(() =>
      buildDeploy({
        authorizingOutpoint: AUTHORIZING,
        organizerUtxos: [],
        organizerUtxoValues: [1_000],
        organizer: ORG,
        capacity: 2,
        constants: CONSTANTS,
        covenantCode: COVENANT_CODE,
        changeScript,
        fee: 100,
        network: NETWORK,
      }),
    ).toThrow(/cannot cover/);
  });
});

describe("buildBuy (mint on sale, HLD v0.22)", () => {
  it("splits the event covenant: ticket + remaining event + payout + change", () => {
    const tx = buildBuy({
      eventOutpoint: EVENT_UTXO,
      eventCovenantId: "ab".repeat(32),
      eventOwner: ORG,
      constants: CONSTANTS,
      buyer: BUYER,
      buyerUtxos: [BUYER_UTXO],
      buyerUtxoValues: [10_000_000_000],
      orgScript,
      changeScript,
      covenantCode: COVENANT_CODE,
      remaining: 100,
      network: NETWORK,
      fee: 1_000,
    });

    expect(tx.inputs).toHaveLength(2); // event covenant + buyer KAS
    expect(tx.outputs).toHaveLength(4); // ticket + remaining event + payout + change
    const [ticket, remainingEvent, payout, change] = tx.outputs;
    expect(ticket?.value).toBe(TICKET_DUST);
    expect(ticket?.covenant).toEqual({ authorizingInput: 0, covenantId: "ab".repeat(32) });
    expect(remainingEvent?.value).toBe(EVENT_DUST);
    expect(remainingEvent?.covenant?.covenantId).toBe("ab".repeat(32));
    expect(payout).toEqual({ value: 1_000, scriptPublicKey: orgScript, covenant: null });
    expect(change?.value).toBe(10_000_000_000 - 1_000 - TICKET_DUST - 1_000);
  });

  it("free ticket (price 0) has no payout output", () => {
    const tx = buildBuy({
      eventOutpoint: EVENT_UTXO,
      eventCovenantId: "ab".repeat(32),
      eventOwner: ORG,
      constants: { ...CONSTANTS, price: 0 },
      buyer: BUYER,
      buyerUtxos: [BUYER_UTXO],
      buyerUtxoValues: [10_000_000_000],
      orgScript,
      changeScript,
      covenantCode: COVENANT_CODE,
      remaining: 100,
      network: NETWORK,
      fee: 500,
    });
    expect(tx.outputs).toHaveLength(3); // ticket + remaining event + change
    expect(tx.outputs[0]?.covenant?.covenantId).toBe("ab".repeat(32));
  });

  it("rejects when the event is exhausted", () => {
    expect(() =>
      buildBuy({
        eventOutpoint: EVENT_UTXO,
        eventCovenantId: "ab".repeat(32),
        eventOwner: ORG,
        constants: CONSTANTS,
        buyer: BUYER,
        buyerUtxos: [BUYER_UTXO],
        buyerUtxoValues: [10_000_000_000],
        orgScript,
        changeScript,
        covenantCode: COVENANT_CODE,
        remaining: 0,
        network: NETWORK,
        fee: 1_000,
      }),
    ).toThrow(/remaining/);
  });

  it("rejects when buyer inputs cannot cover price + ticket dust + fee", () => {
    expect(() =>
      buildBuy({
        eventOutpoint: EVENT_UTXO,
        eventCovenantId: "ab".repeat(32),
        eventOwner: ORG,
        constants: CONSTANTS,
        buyer: BUYER,
        buyerUtxos: [BUYER_UTXO],
        buyerUtxoValues: [500],
        orgScript,
        changeScript,
        covenantCode: COVENANT_CODE,
        remaining: 10,
        network: NETWORK,
        fee: 1_000,
      }),
    ).toThrow(/cannot cover/);
  });
});

describe("buildTransfer", () => {
  it("spends the ticket to a new owner with the same covenant id, holder pays the fee", () => {
    const tx = buildTransfer({
      ticketOutpoint: outpoint("ee".repeat(32), 3),
      eventCovenantId: "ab".repeat(32),
      constants: CONSTANTS,
      newOwner: new Uint8Array(32).fill(0x99),
      holderUtxos: [HOLDER_UTXO],
      holderUtxoValues: [10_000_000_000],
      changeScript,
      covenantCode: COVENANT_CODE,
      network: NETWORK,
      fee: 700,
    });
    expect(tx.outputs).toHaveLength(2);
    expect(tx.outputs[0]?.value).toBe(TICKET_DUST);
    expect(tx.outputs[0]?.covenant).toEqual({ authorizingInput: 0, covenantId: "ab".repeat(32) });
    expect(tx.outputs[1]?.value).toBe(10_000_000_000 - 700);
  });
});

describe("buildHandover", () => {
  it("successor is the event burn-owner covenant bound to the same covenant id (FR-9)", () => {
    const tx = buildHandover({
      ticketOutpoint: outpoint("ee".repeat(32), 4),
      eventCovenantId: "ab".repeat(32),
      constants: CONSTANTS,
      burnCode: BURN_CODE,
      attendeeUtxos: [ATTENDEE_UTXO],
      attendeeUtxoValues: [10_000_000_000],
      changeScript,
      network: NETWORK,
      fee: 400,
    });
    expect(tx.outputs).toHaveLength(2);
    const burn = tx.outputs[0];
    expect(burn?.value).toBe(TICKET_DUST);
    expect(burn?.covenant).toEqual({ authorizingInput: 0, covenantId: "ab".repeat(32) });
    expect(burn?.scriptPublicKey).toEqual(burnScript(CONSTANTS, BURN_CODE));
    expect(tx.outputs[1]?.value).toBe(10_000_000_000 - 400);
  });

  it("burn script is fixed per event", () => {
    expect(burnScript(CONSTANTS, BURN_CODE)).toEqual(burnScript(CONSTANTS, BURN_CODE));
  });
});

describe("burnTemplateHash (reader's GONE check)", () => {
  it("equals the on-chain burn output script hash from the handover builder", () => {
    const eventIdHex = bytesToHex(EVENT_ID);
    expect(burnTemplateHash(eventIdHex, bytesToHex(BURN_CODE))).toBe(
      burnScript(CONSTANTS, BURN_CODE).script,
    );
  });

  it("is deterministic and event-specific", () => {
    const otherEvent = bytesToHex(new Uint8Array(32).fill(0x99));
    expect(burnTemplateHash(bytesToHex(EVENT_ID), "0000")).toBe(
      burnTemplateHash(bytesToHex(EVENT_ID), "0000"),
    );
    expect(burnTemplateHash(bytesToHex(EVENT_ID), "0000")).not.toBe(
      burnTemplateHash(otherEvent, "0000"),
    );
  });
});
