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

const HASH_LENGTH = 32;
const EVENT_ID_SEED = 0xab;
const ORG_FILL = 0x01;
const BUYER_FILL = 0x02;
const BURN_HASH_FILL = 0x77;
const NEW_OWNER_FILL = 0x99;
const ZERO_BYTE = 0x00;
const ONE_BYTE = 0x01;
const TWO_BYTE = 0x02;
const PUSH_33 = 0x21;
const OP_1 = 0x51;
const FUNDED_UTXO_VALUE = 10_000_000_000;
const TINY_UTXO_VALUE = 1_000;
const INSUFFICIENT_BUYER_UTXO_VALUE = 500;
const DEPLOY_FEE = 1_000;
const BUY_FEE = 1_000;
const TRANSFER_FEE = 700;
const HANDOVER_FEE = 400;
const BUY_OUTPUT_COUNT = 4;
const FREE_TICKET_OUTPUT_COUNT = 3;
const TRANSFER_TICKET_INDEX = 3;
const HANDOVER_TICKET_INDEX = 4;

const NETWORK: AddressNetwork = "testnet10";
const COVENANT_CODE = new Uint8Array([ZERO_BYTE, OP_1]);
const BURN_CODE = new Uint8Array([ZERO_BYTE, ZERO_BYTE]);

const EVENT_ID = new Uint8Array(HASH_LENGTH).map((_, i) => (i === 0 ? EVENT_ID_SEED : i));
const ORG_SPK = new Uint8Array([PUSH_33, TWO_BYTE, ZERO_BYTE, ONE_BYTE]);
const BURN_HASH = new Uint8Array(HASH_LENGTH).fill(BURN_HASH_FILL);
const CONSTANTS: DecodedConstants = {
  eventId: EVENT_ID,
  price: 1_000,
  orgSpk: ORG_SPK,
  burnTemplateHash: BURN_HASH,
};

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
const HOLDER_UTXO = outpoint("cc".repeat(HASH_LENGTH), 0);
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
    constants: CONSTANTS,
    covenantCode: COVENANT_CODE,
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
    constants: CONSTANTS,
    buyer: BUYER,
    buyerUtxos: [BUYER_UTXO],
    buyerUtxoValues: [FUNDED_UTXO_VALUE],
    orgScript,
    changeScript,
    covenantCode: COVENANT_CODE,
    remaining: 100,
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
    expect(payout).toEqual({ value: CONSTANTS.price, scriptPublicKey: orgScript, covenant: null });
    expect(change?.value).toBe(FUNDED_UTXO_VALUE - CONSTANTS.price - TICKET_DUST - BUY_FEE);
  });
});

describe("buildBuy: free tickets", () => {
  it("free ticket (price 0) has no payout output", () => {
    const tx = buildBuy(buyArgs({ constants: { ...CONSTANTS, price: 0 }, fee: 500 }));
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

describe("buildTransfer", () => {
  it("spends the ticket to a new owner with the same covenant id, holder pays the fee", () => {
    const tx = buildTransfer({
      ticketOutpoint: outpoint("ee".repeat(HASH_LENGTH), TRANSFER_TICKET_INDEX),
      eventCovenantId: EVENT_COVENANT_ID,
      constants: CONSTANTS,
      newOwner: new Uint8Array(HASH_LENGTH).fill(NEW_OWNER_FILL),
      holderUtxos: [HOLDER_UTXO],
      holderUtxoValues: [FUNDED_UTXO_VALUE],
      changeScript,
      covenantCode: COVENANT_CODE,
      network: NETWORK,
      fee: TRANSFER_FEE,
    });
    expect(tx.outputs).toHaveLength(2);
    expect(tx.outputs[0]?.value).toBe(TICKET_DUST);
    expect(tx.outputs[0]?.covenant).toEqual({
      authorizingInput: 0,
      covenantId: EVENT_COVENANT_ID,
    });
    expect(tx.outputs[1]?.value).toBe(FUNDED_UTXO_VALUE - TRANSFER_FEE);
  });
});

describe("buildHandover", () => {
  it("successor is the event burn-owner covenant bound to the same covenant id (FR-9)", () => {
    const tx = buildHandover({
      ticketOutpoint: outpoint("ee".repeat(HASH_LENGTH), HANDOVER_TICKET_INDEX),
      eventCovenantId: EVENT_COVENANT_ID,
      constants: CONSTANTS,
      burnCode: BURN_CODE,
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
    expect(burn?.scriptPublicKey).toEqual(burnScript(CONSTANTS, BURN_CODE));
    expect(tx.outputs[1]?.value).toBe(FUNDED_UTXO_VALUE - HANDOVER_FEE);
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
    const otherEvent = bytesToHex(new Uint8Array(HASH_LENGTH).fill(NEW_OWNER_FILL));
    expect(burnTemplateHash(bytesToHex(EVENT_ID), "0000")).toBe(
      burnTemplateHash(bytesToHex(EVENT_ID), "0000"),
    );
    expect(burnTemplateHash(bytesToHex(EVENT_ID), "0000")).not.toBe(
      burnTemplateHash(otherEvent, "0000"),
    );
  });
});
