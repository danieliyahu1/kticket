import { describe, expect, it } from "vitest";
import type { AddressNetwork } from "./address";
import { buildBuy, buildGenesis, buildHandover, buildTransfer, burnScript } from "./builder";
import type { Outpoint } from "./covenant";
import { covenantId } from "./covenant";
import type { ScriptPublicKey } from "./tx";

const NETWORK: AddressNetwork = "testnet10";
const TICKET_CODE = new Uint8Array([0x00, 0x51]);
const BURN_CODE = new Uint8Array([0x00, 0x00]);

const EVENT_ID = new Uint8Array(32).map((_, i) => (i === 0 ? 0xab : i));
const ORG_SPK = new Uint8Array([0x21, 0x02, 0x00, 0x01]);
const BURN_HASH = new Uint8Array(32).fill(0x77);
const CONSTANTS = {
  eventId: EVENT_ID,
  index: 0,
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
const BUYER_UTXO = outpoint("bb".repeat(32), 0);
const HOLDER_UTXO = outpoint("cc".repeat(32), 0);
const ATTENDEE_UTXO = outpoint("dd".repeat(32), 0);

describe("buildGenesis", () => {
  it("creates one phase-0 ticket output per capacity slot, all bound to one event covenant id", () => {
    const { tx, eventCovenantId } = buildGenesis({
      authorizingOutpoint: AUTHORIZING,
      organizerUtxos: [],
      organizerUtxoValues: [50_000],
      constants: CONSTANTS,
      capacity: 3,
      ticketCode: TICKET_CODE,
      changeScript,
      fee: 1_000,
      network: NETWORK,
    });

    expect(tx.version).toBe(1);
    expect(tx.inputs).toHaveLength(1);
    expect(tx.outputs).toHaveLength(4); // 3 tickets + change
    expect(eventCovenantId).toMatch(/^[0-9a-f]{64}$/);

    const tickets = tx.outputs.slice(0, 3);
    for (const output of tickets) {
      expect(output.value).toBe(0);
      expect(output.covenant?.authorizingInput).toBe(0);
      expect(output.covenant?.covenantId).toBe(eventCovenantId);
      expect(output.scriptPublicKey.version).toBe(0);
    }
    // change = input − fee
    expect(tx.outputs[3]).toEqual({ value: 49_000, scriptPublicKey: changeScript, covenant: null });
  });

  it("event covenant id is the KIP-20 hash of the authorizing outpoint + ticket outputs", () => {
    const { tx, eventCovenantId } = buildGenesis({
      authorizingOutpoint: AUTHORIZING,
      organizerUtxos: [],
      organizerUtxoValues: [10_000],
      constants: CONSTANTS,
      capacity: 2,
      ticketCode: TICKET_CODE,
      changeScript,
      fee: 100,
      network: NETWORK,
    });
    const authOutputs = tx.outputs.slice(0, 2).map((output, index) => ({
      index,
      value: output.value,
      version: output.scriptPublicKey.version,
      script: Uint8Array.from(Buffer.from(output.scriptPublicKey.script, "hex")),
    }));
    expect(Buffer.from(covenantId(AUTHORIZING, authOutputs)).toString("hex")).toBe(eventCovenantId);
  });

  it("rejects capacity > 100 and 0..100 validation (HLD / FR-8)", () => {
    expect(() =>
      buildGenesis({
        authorizingOutpoint: AUTHORIZING,
        organizerUtxos: [],
        organizerUtxoValues: [10_000],
        constants: CONSTANTS,
        capacity: 101,
        ticketCode: TICKET_CODE,
        changeScript,
        fee: 100,
        network: NETWORK,
      }),
    ).toThrow(/capacity/);
  });
});

describe("buildBuy", () => {
  it("spends ticket + buyer KAS, creates owned ticket + org payout + change", () => {
    const tx = buildBuy({
      ticketOutpoint: outpoint("ee".repeat(32), 2),
      eventCovenantId: "ab".repeat(32),
      constants: CONSTANTS,
      buyerPkh: new Uint8Array(32).fill(0x42),
      buyerUtxos: [BUYER_UTXO],
      buyerUtxoValues: [10_000],
      orgScript,
      changeScript,
      ticketCode: TICKET_CODE,
      network: NETWORK,
      fee: 1_000,
    });

    expect(tx.inputs).toHaveLength(2);
    expect(tx.outputs).toHaveLength(3); // owned ticket + payout + change
    const [ticket, payout, change] = tx.outputs;
    expect(ticket?.value).toBe(0);
    expect(ticket?.covenant).toEqual({ authorizingInput: 0, covenantId: "ab".repeat(32) });
    expect(payout).toEqual({ value: 1_000, scriptPublicKey: orgScript, covenant: null });
    expect(change?.value).toBe(10_000 - 1_000 - 1_000);
  });

  it("free ticket (price 0) has no payout output", () => {
    const tx = buildBuy({
      ticketOutpoint: outpoint("ee".repeat(32), 2),
      eventCovenantId: "ab".repeat(32),
      constants: { ...CONSTANTS, price: 0 },
      buyerPkh: new Uint8Array(32).fill(0x42),
      buyerUtxos: [BUYER_UTXO],
      buyerUtxoValues: [500],
      orgScript,
      changeScript,
      ticketCode: TICKET_CODE,
      network: NETWORK,
      fee: 500,
    });
    expect(tx.outputs).toHaveLength(2); // owned ticket + change
    expect(tx.outputs[0]?.covenant?.covenantId).toBe("ab".repeat(32));
    expect(tx.outputs[1]?.value).toBe(0);
  });

  it("rejects when buyer inputs cannot cover price + fee (FR-18)", () => {
    expect(() =>
      buildBuy({
        ticketOutpoint: outpoint("ee".repeat(32), 2),
        eventCovenantId: "ab".repeat(32),
        constants: CONSTANTS,
        buyerPkh: new Uint8Array(32).fill(0x42),
        buyerUtxos: [BUYER_UTXO],
        buyerUtxoValues: [500],
        orgScript,
        changeScript,
        ticketCode: TICKET_CODE,
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
      newOwnerPkh: new Uint8Array(32).fill(0x99),
      holderUtxos: [HOLDER_UTXO],
      holderUtxoValues: [2_000],
      changeScript,
      ticketCode: TICKET_CODE,
      network: NETWORK,
      fee: 700,
    });
    expect(tx.outputs).toHaveLength(2);
    expect(tx.outputs[0]?.covenant).toEqual({ authorizingInput: 0, covenantId: "ab".repeat(32) });
    expect(tx.outputs[1]?.value).toBe(2_000 - 700);
  });
});

describe("buildHandover", () => {
  it("successor is the event burn output bound to the same covenant id (FR-9)", () => {
    const tx = buildHandover({
      ticketOutpoint: outpoint("ee".repeat(32), 4),
      eventCovenantId: "ab".repeat(32),
      constants: CONSTANTS,
      burnCode: BURN_CODE,
      attendeeUtxos: [ATTENDEE_UTXO],
      attendeeUtxoValues: [1_500],
      changeScript,
      network: NETWORK,
      fee: 400,
    });
    expect(tx.outputs).toHaveLength(2);
    const burn = tx.outputs[0];
    expect(burn?.value).toBe(0);
    expect(burn?.covenant).toEqual({ authorizingInput: 0, covenantId: "ab".repeat(32) });
    expect(burn?.scriptPublicKey).toEqual(burnScript(CONSTANTS, BURN_CODE));
    expect(tx.outputs[1]?.value).toBe(1_500 - 400);
  });

  it("burn script is fixed per event", () => {
    expect(burnScript(CONSTANTS, BURN_CODE)).toEqual(burnScript(CONSTANTS, BURN_CODE));
  });
});
