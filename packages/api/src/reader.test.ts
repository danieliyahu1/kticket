import {
  addressFromScriptHash,
  buildBuy,
  buildDeploy,
  buildHandover,
  buildTransfer,
  type DecodedConstants,
  type UnsignedTransaction,
} from "@kticket/kit";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { EventRegistry } from "./events";
import type { KaspaClientLike } from "./kaspa-client";
import type { TxModel, UtxoResponse } from "./kaspa-types";
import { MAX_LINEAGE_DEPTH, parseTicketId, verifyTicket } from "./reader";

const NETWORK = "testnet10" as const;
const TXID_BYTE_LENGTH = 32;
const TXID_HEX_LENGTH = 64;
const TICKET_PRICE = 1_000;
const UTXO_VALUE = 10_000_000_000;
const HEX_BASE = 16;
const TXID_INDEX_OFFSET = 3;

const COVENANT_CODE_VERSION_BYTE = 0x00;
const COVENANT_CODE_OP_BYTE = 0x51;
const BURN_CODE_BYTE = 0x00;
const EVENT_ID_FIRST_BYTE = 0xab;
const ORG_SPK_VERSION_BYTE = 0x21;
const ORG_SPK_FLAG_BYTE = 0x02;
const ORG_SPK_ZERO_BYTE = 0x00;
const ORG_SPK_ONE_BYTE = 0x01;
const ORG_PKH_BYTE = 0x01;
const BURN_TEMPLATE_BYTE = 0x77;
const BUYER_BYTE = 0x01;
const NEW_OWNER_BYTE = 0x02;
const DEPTH_BUYER_BYTE = 0x11;
const OWNER_START_BYTE = 0x22;

const COVENANT_CODE = new Uint8Array([COVENANT_CODE_VERSION_BYTE, COVENANT_CODE_OP_BYTE]);
const BURN_CODE = new Uint8Array([BURN_CODE_BYTE, BURN_CODE_BYTE]);

const EVENT_ID = new Uint8Array(TXID_BYTE_LENGTH).map((_, i) =>
  i === 0 ? EVENT_ID_FIRST_BYTE : i,
);
const ORG_SPK = new Uint8Array([
  ORG_SPK_VERSION_BYTE,
  ORG_SPK_FLAG_BYTE,
  ORG_SPK_ZERO_BYTE,
  ORG_SPK_ONE_BYTE,
]);
const ORG_PKH = new Uint8Array(TXID_BYTE_LENGTH).fill(ORG_PKH_BYTE);
const CONSTANTS: DecodedConstants = {
  eventId: EVENT_ID,
  price: 1_000,
  orgSpk: ORG_SPK,
  burnTemplateHash: new Uint8Array(TXID_BYTE_LENGTH).fill(BURN_TEMPLATE_BYTE),
};
const ORG_SCRIPT = { version: 0, script: "51" };
const CHANGE_SCRIPT = { version: 0, script: "51" };

const G_ID = "aa".repeat(TXID_BYTE_LENGTH);
const B0_ID = "bb".repeat(TXID_BYTE_LENGTH);
const T1_ID = "cc".repeat(TXID_BYTE_LENGTH);
const T2_ID = "dd".repeat(TXID_BYTE_LENGTH);

function outpointBytes(txIdHex: string, index: number) {
  return { txId: hexToBytes(txIdHex), index };
}

function outpointWithFill(byte: number) {
  return outpointBytes(bytesToHex(new Uint8Array(TXID_BYTE_LENGTH).fill(byte)), 0);
}

function ticketScriptHash(
  outputs: { scriptPublicKey: { script: string } }[],
  index: number,
): string {
  const output = outputs[index];
  if (!output) throw new Error(`fixture missing output ${index}`);
  return output.scriptPublicKey.script;
}

function toTxModel(tx: UnsignedTransaction, txId: string): TxModel {
  return {
    transaction_id: txId,
    inputs: tx.inputs.map((input, index) => ({
      transaction_id: input.previousOutpoint.txId,
      index,
      previous_outpoint_hash: input.previousOutpoint.txId,
      previous_outpoint_index: String(input.previousOutpoint.index),
      signature_script: input.signatureScript,
      covenant_id: input.previousOutpoint.txId,
    })),
    outputs: tx.outputs.map((output, index) => ({
      transaction_id: txId,
      index,
      amount: output.value,
      script_public_key: output.scriptPublicKey.script,
      covenant_authorizing_input: output.covenant?.authorizingInput ?? null,
      covenant_id: output.covenant?.covenantId ?? null,
    })),
  };
}

class FakeKaspa implements KaspaClientLike {
  utxos = new Map<string, UtxoResponse[]>();
  addressTxs = new Map<string, TxModel[]>();
  transactions = new Map<string, TxModel>();

  utxo(address: string, outpoint: { transactionId: string; index: number }): void {
    const list = this.utxos.get(address) ?? [];
    list.push({
      address,
      outpoint,
      utxoEntry: {
        amount: "0",
        scriptPublicKey: { scriptPublicKey: "" },
        blockDaaScore: "0",
        isCoinbase: false,
      },
    });
    this.utxos.set(address, list);
  }

  txAt(address: string, tx: TxModel): void {
    const list = this.addressTxs.get(address) ?? [];
    list.push(tx);
    this.addressTxs.set(address, list);
  }

  async getUtxos(address: string): Promise<UtxoResponse[]> {
    return this.utxos.get(address) ?? [];
  }

  async getUtxosForAddresses(addresses: string[]): Promise<UtxoResponse[]> {
    return addresses.flatMap((a) => this.utxos.get(a) ?? []);
  }

  async getFullTransactions(address: string): Promise<TxModel[]> {
    return this.addressTxs.get(address) ?? [];
  }

  async getTransaction(txId: string): Promise<TxModel | null> {
    return this.transactions.get(txId.toLowerCase()) ?? null;
  }

  async getFeeEstimate(): Promise<never> {
    throw new Error("getFeeEstimate not used by the reader");
  }

  async computeMass(): Promise<never> {
    throw new Error("computeMass not used by the reader");
  }

  async broadcastTransaction(): Promise<never> {
    throw new Error("broadcastTransaction not used by the reader");
  }
}

interface Fixtures {
  kaspa: FakeKaspa;
  registry: EventRegistry;
  event: {
    eventId: string;
    genesisTxId: string;
    orgPkh: string;
    orgSpk: string;
    burnTemplateHash: string;
    name: string;
    date: string;
    price: number;
    capacity: number;
  };
  address: (k: number) => string;
}

function buildDeployResult(capacity: number) {
  return buildDeploy({
    authorizingOutpoint: outpointBytes("11".repeat(TXID_BYTE_LENGTH), 0),
    organizerUtxos: [outpointBytes("22".repeat(TXID_BYTE_LENGTH), 0)],
    organizerUtxoValues: [UTXO_VALUE, UTXO_VALUE],
    organizer: ORG_PKH,
    capacity,
    constants: CONSTANTS,
    covenantCode: COVENANT_CODE,
    changeScript: CHANGE_SCRIPT,
    fee: 1_000,
    network: NETWORK,
  });
}

function makeRegistry(capacity: number): EventRegistry {
  return new EventRegistry([
    {
      eventId: bytesToHex(EVENT_ID),
      genesisTxId: B0_ID,
      orgPkh: bytesToHex(ORG_PKH),
      orgSpk: bytesToHex(ORG_SPK),
      burnTemplateHash: "77".repeat(TXID_BYTE_LENGTH),
      name: "Testnet Rave",
      date: "2026-12-31",
      price: 1_000,
      capacity,
    },
  ]);
}

function makeEvent(capacity: number): Fixtures["event"] {
  return {
    eventId: bytesToHex(EVENT_ID),
    genesisTxId: G_ID,
    orgPkh: bytesToHex(ORG_PKH),
    orgSpk: bytesToHex(ORG_SPK),
    burnTemplateHash: "77".repeat(TXID_BYTE_LENGTH),
    name: "Testnet Rave",
    date: "2026-12-31",
    price: 1_000,
    capacity,
  };
}

function buildBuyTx(capacity: number): UnsignedTransaction {
  const deploy = buildDeployResult(capacity);
  return buildBuy({
    eventOutpoint: outpointBytes(G_ID, 0),
    eventCovenantId: deploy.eventCovenantId,
    eventOwner: ORG_PKH,
    constants: CONSTANTS,
    buyer: new Uint8Array(TXID_BYTE_LENGTH).fill(BUYER_BYTE),
    buyerUtxos: [outpointBytes("33".repeat(TXID_BYTE_LENGTH), 0)],
    buyerUtxoValues: [UTXO_VALUE],
    orgScript: ORG_SCRIPT,
    changeScript: CHANGE_SCRIPT,
    covenantCode: COVENANT_CODE,
    remaining: capacity,
    network: NETWORK,
    fee: 400,
  });
}

function buildTransferModel(
  kaspa: FakeKaspa,
  eventCovenantId: string,
  fromAddress: string,
): string {
  const transfer = buildTransfer({
    ticketOutpoint: outpointBytes(B0_ID, 0),
    eventCovenantId,
    constants: CONSTANTS,
    newOwner: new Uint8Array(TXID_BYTE_LENGTH).fill(NEW_OWNER_BYTE),
    holderUtxos: [outpointBytes("44".repeat(TXID_BYTE_LENGTH), 0)],
    holderUtxoValues: [UTXO_VALUE],
    changeScript: CHANGE_SCRIPT,
    covenantCode: COVENANT_CODE,
    network: NETWORK,
    fee: 100,
  });
  const transferModel = toTxModel(transfer, T1_ID);
  kaspa.transactions.set(T1_ID, transferModel);
  kaspa.txAt(fromAddress, transferModel); // spent the ticket
  const owner2Address = addressFromScriptHash(ticketScriptHash(transfer.outputs, 0), NETWORK);
  kaspa.txAt(owner2Address, transferModel); // created owner2
  return owner2Address;
}

function buildHandoverModel(kaspa: FakeKaspa, eventCovenantId: string, fromAddress: string): void {
  const handover = buildHandover({
    ticketOutpoint: outpointBytes(T1_ID, 0),
    eventCovenantId,
    constants: CONSTANTS,
    burnCode: BURN_CODE,
    attendeeUtxos: [outpointBytes("55".repeat(TXID_BYTE_LENGTH), 0)],
    attendeeUtxoValues: [UTXO_VALUE],
    changeScript: CHANGE_SCRIPT,
    network: NETWORK,
    fee: 100,
  });
  const handoverModel = toTxModel(handover, T2_ID);
  kaspa.transactions.set(T2_ID, handoverModel);
  kaspa.txAt(fromAddress, handoverModel); // spent owner2
  kaspa.utxo(addressFromScriptHash(ticketScriptHash(handover.outputs, 0), NETWORK), {
    transactionId: T2_ID,
    index: 0,
  }); // burn UTXO lives forever
}

function buildFixtures(capacity = 3, chain = true): Fixtures {
  const deploy = buildDeployResult(capacity);
  const kaspa = new FakeKaspa();
  kaspa.transactions.set(G_ID, toTxModel(deploy.tx, G_ID));

  // In the mint model a ticket is created on sale, so the "address of ticket k"
  // is the buyer's minted ticket. We model one ticket minted at output 0 of a
  // buy that also re-creates the event covenant.
  const buy = buildBuyTx(capacity);
  const buyModel = toTxModel(buy, B0_ID);
  kaspa.transactions.set(B0_ID, buyModel);
  const ticketAddress = addressFromScriptHash(ticketScriptHash(buy.outputs, 0), NETWORK);
  const eventCovenantAddress = addressFromScriptHash(ticketScriptHash(buy.outputs, 1), NETWORK);
  kaspa.txAt(ticketAddress, buyModel);

  const address = (k: number) => (k === 0 ? ticketAddress : eventCovenantAddress);

  if (chain) {
    const owner2Address = buildTransferModel(kaspa, deploy.eventCovenantId, ticketAddress);
    buildHandoverModel(kaspa, deploy.eventCovenantId, owner2Address);
  }

  return {
    kaspa,
    registry: makeRegistry(capacity),
    event: makeEvent(capacity),
    address,
  };
}

const ctx = (f: Fixtures, overrides: Partial<Parameters<typeof verifyTicket>[1]> = {}) => ({
  kaspa: f.kaspa,
  events: f.registry,
  network: NETWORK,
  ...overrides,
});

describe("parseTicketId", () => {
  it("parses '<gtxid>:<index>'", () => {
    expect(parseTicketId(`${G_ID}:3`)).toEqual({ txId: G_ID, index: 3 });
  });

  it("normalises the txid to lowercase", () => {
    expect(parseTicketId(`${G_ID.toUpperCase()}:0`).txId).toBe(G_ID);
  });

  it("rejects malformed ticket ids", () => {
    for (const bad of [
      "",
      G_ID,
      "nope:0",
      `${G_ID}:`,
      `${G_ID}:x`,
      `${"z".repeat(TXID_HEX_LENGTH)}:1`,
    ]) {
      expect(() => parseTicketId(bad)).toThrow();
    }
  });
});

describe("verifyTicket — happy paths (HLD v0.22 §2.2)", () => {
  it("returns ALIVE for an unspent ticket with event meta", async () => {
    const f = buildFixtures();
    f.kaspa.utxo(f.address(0), { transactionId: B0_ID, index: 0 });

    const result = await verifyTicket(`${B0_ID}:0`, ctx(f));
    expect(result.state).toBe("alive");
    expect(result.liveOutpoint).toEqual({ transaction_id: B0_ID, index: 0 });
    expect(result.event).toEqual({
      event_id: f.event.eventId,
      name: f.event.name,
      date: f.event.date,
    });
    expect(result.price).toBe(f.event.price);
  });

  it("returns GONE at the handover tx after a full lineage", async () => {
    const f = buildFixtures();
    const result = await verifyTicket(`${B0_ID}:0`, ctx(f));
    expect(result.state).toBe("gone");
    expect(result.atTx).toBe(T2_ID);
    expect(result.event?.event_id).toBe(f.event.eventId);
    expect(result.price).toBe(TICKET_PRICE);
  });
});

describe("verifyTicket — unresolved / depth-exceeded", () => {
  it("returns UNKNOWN unresolved-spend when no spender is visible", async () => {
    const f = buildFixtures();
    // drop the buy tx from the ticket address history -> the spent ticket has
    // no detectable spender
    f.kaspa.addressTxs.delete(f.address(0));

    const result = await verifyTicket(`${B0_ID}:0`, ctx(f));
    expect(result.state).toBe("unknown");
    expect(result.cause).toBe("unresolved-spend");
  });

  it("returns UNKNOWN depth-exceeded after MAX_LINEAGE_DEPTH hops", async () => {
    const kaspa = new FakeKaspa();
    const mintId = buildDepthChain(kaspa);
    const registry = makeDepthRegistry(mintId);

    const result = await verifyTicket(`${mintId}:0`, {
      kaspa,
      events: registry,
      network: NETWORK,
    });
    expect(result.state).toBe("unknown");
    expect(result.cause).toBe("depth-exceeded");
  });
});

describe("verifyTicket — unregistered events", () => {
  it("returns UNKNOWN unknown-event for a spent ticket of an unregistered event", async () => {
    const f = buildFixtures();
    const emptyRegistry = new EventRegistry([]);
    const result = await verifyTicket(`${B0_ID}:0`, ctx(f, { events: emptyRegistry }));
    expect(result.state).toBe("unknown");
    expect(result.cause).toBe("unknown-event");
    expect(result.event).toBeUndefined();
  });

  it("still returns ALIVE for an unspent ticket of an unregistered event", async () => {
    const f = buildFixtures();
    f.kaspa.utxo(f.address(0), { transactionId: B0_ID, index: 0 });
    const emptyRegistry = new EventRegistry([]);
    const result = await verifyTicket(`${B0_ID}:0`, ctx(f, { events: emptyRegistry }));
    expect(result.state).toBe("alive");
    expect(result.event).toBeUndefined();
  });
});

describe("verifyTicket — no-successor walk", () => {
  it("returns UNKNOWN no-successor when the spender has no covenant output", async () => {
    const f = buildFixtures();
    const addr0 = f.address(0);
    const bogus: TxModel = {
      transaction_id: "ff".repeat(TXID_BYTE_LENGTH),
      inputs: [
        {
          transaction_id: B0_ID,
          index: 0,
          previous_outpoint_hash: B0_ID,
          previous_outpoint_index: "0",
          signature_script: "",
        },
      ],
      outputs: [
        {
          transaction_id: "ff".repeat(TXID_BYTE_LENGTH),
          index: 0,
          amount: 5,
          script_public_key: "51",
        },
      ],
    };
    // replace the ticket address history: the mint (creator) + a spender whose
    // outputs carry no covenant -> the walk cannot identify a successor
    const buyModel = f.kaspa.transactions.get(B0_ID);
    if (!buyModel) throw new Error("fixture missing buy");
    f.kaspa.addressTxs.set(addr0, [buyModel, bogus]);

    const result = await verifyTicket(`${B0_ID}:0`, ctx(f));
    expect(result.state).toBe("unknown");
    expect(result.cause).toBe("no-successor");
  });
});

describe("verifyTicket — rejections", () => {
  it("rejects a missing genesis transaction as invalid", async () => {
    const f = buildFixtures();
    f.kaspa.transactions.delete(G_ID);
    await expect(verifyTicket(`${G_ID}:0`, ctx(f))).rejects.toMatchObject({ type: "invalid" });
  });

  it("rejects a ticket index beyond the deploy outputs", async () => {
    const f = buildFixtures(2);
    await expect(verifyTicket(`${G_ID}:5`, ctx(f))).rejects.toMatchObject({ type: "invalid" });
  });

  it("rejects a non-covenant output (the deploy change output)", async () => {
    const f = buildFixtures(2);
    // change output sits at index == capacity on the deploy
    await expect(verifyTicket(`${G_ID}:2`, ctx(f))).rejects.toMatchObject({ type: "invalid" });
  });
});

function buildDepthChain(kaspa: FakeKaspa): string {
  const deploy = buildDeployResult(1);
  const gid = "e1".repeat(TXID_BYTE_LENGTH);
  kaspa.transactions.set(gid, toTxModel(deploy.tx, gid));

  const mintId = "e2".repeat(TXID_BYTE_LENGTH);
  const mint = buildBuy({
    eventOutpoint: outpointBytes(gid, 0),
    eventCovenantId: deploy.eventCovenantId,
    eventOwner: ORG_PKH,
    constants: CONSTANTS,
    buyer: new Uint8Array(TXID_BYTE_LENGTH).fill(DEPTH_BUYER_BYTE),
    buyerUtxos: [outpointBytes("33".repeat(TXID_BYTE_LENGTH), 0)],
    buyerUtxoValues: [UTXO_VALUE],
    orgScript: ORG_SCRIPT,
    changeScript: CHANGE_SCRIPT,
    covenantCode: COVENANT_CODE,
    remaining: 1,
    network: NETWORK,
    fee: 400,
  });
  const mintModel = toTxModel(mint, mintId);
  kaspa.transactions.set(mintId, mintModel);
  const addr0 = addressFromScriptHash(ticketScriptHash(mint.outputs, 0), NETWORK);
  kaspa.txAt(addr0, mintModel);

  chainDepthTransfers(kaspa, deploy.eventCovenantId, mintId, addr0);
  return mintId;
}

function depthTransfer(
  previous: { txId: Uint8Array; index: number },
  eventCovenantId: string,
  owner: number,
  holderByte: number,
): UnsignedTransaction {
  return buildTransfer({
    ticketOutpoint: previous,
    eventCovenantId,
    constants: CONSTANTS,
    newOwner: new Uint8Array(TXID_BYTE_LENGTH).fill(owner),
    holderUtxos: [outpointWithFill(holderByte)],
    holderUtxoValues: [UTXO_VALUE],
    changeScript: CHANGE_SCRIPT,
    covenantCode: COVENANT_CODE,
    network: NETWORK,
    fee: 100,
  });
}

function chainDepthTransfers(
  kaspa: FakeKaspa,
  eventCovenantId: string,
  mintId: string,
  startAddress: string,
): void {
  let previous = outpointBytes(mintId, 0);
  let previousAddress = startAddress;
  let owner = OWNER_START_BYTE;
  for (let i = 0; i <= MAX_LINEAGE_DEPTH; i++) {
    const transfer = depthTransfer(previous, eventCovenantId, owner++, i + 1);
    const txId = `e${(i + TXID_INDEX_OFFSET).toString(HEX_BASE).padStart(2, "0")}`.repeat(
      TXID_BYTE_LENGTH,
    );
    const model = toTxModel(transfer, txId);
    kaspa.transactions.set(txId, model);
    kaspa.txAt(previousAddress, model); // spent previous owner
    const nextAddress = addressFromScriptHash(ticketScriptHash(transfer.outputs, 0), NETWORK);
    kaspa.txAt(nextAddress, model); // created next owner
    previous = { txId: hexToBytes(txId), index: 0 };
    previousAddress = nextAddress;
  }
}

function makeDepthRegistry(mintId: string): EventRegistry {
  return new EventRegistry([
    {
      eventId: bytesToHex(EVENT_ID),
      genesisTxId: mintId,
      orgPkh: bytesToHex(ORG_PKH),
      orgSpk: bytesToHex(ORG_SPK),
      burnTemplateHash: "77".repeat(TXID_BYTE_LENGTH),
      name: "Long",
      date: "2026-01-01",
      price: 1_000,
      capacity: 1,
    },
  ]);
}
