import {
  addressFromScriptHash,
  buildBuy,
  buildDeploy,
  type DecodedConstants,
  EVENT_ARTIFACT,
  type UnsignedTransaction,
} from "@kticket/kit";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  EventRegistry,
  eventAvailability,
  parseRegisteredEvents,
  type RegisteredEvent,
} from "./events";
import type { KaspaClientLike } from "./kaspa-client";
import type { TxModel, UtxoResponse } from "./kaspa-types";

const TXID_BYTE_LENGTH = 32;
const EVENT_ID_FIRST_BYTE = 0xab;
const ORG_SPK_VERSION = 0x21;
const ORG_SPK_FLAG = 0x02;
const ORG_SPK_ZERO_BYTE = 0x00;
const ORG_SPK_LENGTH_BYTE = 0x01;
const ORG_PKH_BYTE = 0x01;
const BURN_TEMPLATE_BYTE = 0x77;
const BUYER_BYTE = 0x02;
const UTXO_VALUE = 10_000_000_000;

const NETWORK = "testnet10";
const EVENT_ID = new Uint8Array(TXID_BYTE_LENGTH).map((_, i) =>
  i === 0 ? EVENT_ID_FIRST_BYTE : i,
);
const ORG_SPK = new Uint8Array([
  ORG_SPK_VERSION,
  ORG_SPK_FLAG,
  ORG_SPK_ZERO_BYTE,
  ORG_SPK_LENGTH_BYTE,
]);
const ORG_PKH = new Uint8Array(TXID_BYTE_LENGTH).fill(ORG_PKH_BYTE);
const G_ID = "aa".repeat(TXID_BYTE_LENGTH);

const CONSTANTS: DecodedConstants = {
  eventId: EVENT_ID,
  price: 1_000,
  orgSpk: ORG_SPK,
  burnTemplateHash: new Uint8Array(TXID_BYTE_LENGTH).fill(BURN_TEMPLATE_BYTE),
};

const EVENT: RegisteredEvent = {
  eventId: bytesToHex(EVENT_ID),
  genesisTxId: G_ID,
  orgPkh: bytesToHex(ORG_PKH),
  orgSpk: bytesToHex(ORG_SPK),
  burnTemplateHash: "77".repeat(TXID_BYTE_LENGTH),
  name: "Testnet Rave",
  date: "2026-12-31",
  price: 1_000,
  capacity: 3,
};

function outpointBytes(txIdHex: string, index: number) {
  return { txId: hexToBytes(txIdHex), index };
}

function buyTxModel(tx: UnsignedTransaction, txId: string): TxModel {
  return {
    transaction_id: txId,
    inputs: tx.inputs.map((input, index) => ({
      transaction_id: input.previousOutpoint.txId,
      index,
      previous_outpoint_hash: input.previousOutpoint.txId,
      previous_outpoint_index: String(input.previousOutpoint.index),
      signature_script: input.signatureScript,
    })),
    outputs: tx.outputs.map((output, index) => ({
      transaction_id: txId,
      index,
      amount: output.value,
      script_public_key: output.scriptPublicKey.script,
      covenant_authorizing_input: output.covenant?.authorizingInput ?? null,
    })),
  };
}

function deployModel(capacity: number): TxModel {
  const { tx } = buildDeploy({
    authorizingOutpoint: outpointBytes("11".repeat(TXID_BYTE_LENGTH), 0),
    organizerUtxos: [outpointBytes("22".repeat(TXID_BYTE_LENGTH), 0)],
    organizerUtxoValues: [UTXO_VALUE, UTXO_VALUE],
    organizer: ORG_PKH,
    capacity,
    constants: CONSTANTS,
    covenantCode: hexToBytes(EVENT_ARTIFACT.code),
    changeScript: { version: 0, script: "51" },
    fee: 1_000,
    network: NETWORK,
  });
  return {
    transaction_id: G_ID,
    inputs: tx.inputs.map((input, index) => ({
      transaction_id: input.previousOutpoint.txId,
      index,
      previous_outpoint_hash: input.previousOutpoint.txId,
      previous_outpoint_index: String(input.previousOutpoint.index),
      signature_script: input.signatureScript,
    })),
    outputs: tx.outputs.map((output, index) => ({
      transaction_id: G_ID,
      index,
      amount: output.value,
      script_public_key: output.scriptPublicKey.script,
      covenant_authorizing_input: output.covenant?.authorizingInput ?? null,
      covenant_id: output.covenant?.covenantId ?? null,
    })),
  };
}

class FakeKaspa implements KaspaClientLike {
  constructor(
    readonly genesis: TxModel,
    readonly live: Map<string, UtxoResponse[]> = new Map(),
    readonly addressTxs: Map<string, TxModel[]> = new Map(),
  ) {}

  utxosAt(address: string, outpoint: { transactionId: string; index: number }): void {
    const list = this.live.get(address) ?? [];
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
    this.live.set(address, list);
  }

  async getTransaction(txId: string): Promise<TxModel | null> {
    return txId.toLowerCase() === this.genesis.transaction_id ? this.genesis : null;
  }

  async getUtxosForAddresses(addresses: string[]): Promise<UtxoResponse[]> {
    return addresses.flatMap((a) => this.live.get(a) ?? []);
  }

  async getUtxos(address: string): Promise<UtxoResponse[]> {
    return this.live.get(address) ?? [];
  }

  async getFullTransactions(address: string): Promise<TxModel[]> {
    return this.addressTxs.get(address) ?? [];
  }

  async getFeeEstimate(): Promise<never> {
    throw new Error("getFeeEstimate not used by the events tests");
  }

  async computeMass(): Promise<never> {
    throw new Error("computeMass not used by the events tests");
  }

  async broadcastTransaction(): Promise<never> {
    throw new Error("broadcastTransaction not used by the events tests");
  }
}

describe("EventRegistry", () => {
  it("indexes by event id and genesis txid", () => {
    const registry = new EventRegistry([EVENT]);
    expect(registry.byEventId(bytesToHex(EVENT_ID))).toEqual(EVENT);
    expect(registry.byGenesisTxId(G_ID)).toEqual(EVENT);
    expect(registry.list()).toHaveLength(1);
  });

  it("lookups are case-insensitive", () => {
    const registry = new EventRegistry([EVENT]);
    expect(registry.byEventId(bytesToHex(EVENT_ID).toUpperCase())?.eventId).toBe(EVENT.eventId);
    expect(registry.byGenesisTxId(G_ID.toUpperCase())?.genesisTxId).toBe(G_ID);
  });

  it("returns undefined for unknown events", () => {
    const registry = new EventRegistry([EVENT]);
    expect(registry.byEventId("ff".repeat(TXID_BYTE_LENGTH))).toBeUndefined();
    expect(registry.byGenesisTxId("ff".repeat(TXID_BYTE_LENGTH))).toBeUndefined();
  });
});

describe("parseRegisteredEvents (KTICKET_EVENTS)", () => {
  it("returns [] for a missing value", () => {
    expect(parseRegisteredEvents(undefined)).toEqual([]);
    expect(parseRegisteredEvents("")).toEqual([]);
  });

  it("parses a valid array", () => {
    const parsed = parseRegisteredEvents(
      JSON.stringify([
        {
          ...EVENT,
          event_id: EVENT.eventId,
          genesis_txid: EVENT.genesisTxId,
          org_pkh: EVENT.orgPkh,
          org_spk: EVENT.orgSpk,
          burn_template_hash: EVENT.burnTemplateHash,
        },
      ]),
    );
    expect(parsed).toEqual([EVENT]);
  });
});

describe("parseRegisteredEvents (validation)", () => {
  it("rejects invalid JSON and non-arrays", () => {
    expect(() => parseRegisteredEvents("{nope")).toThrow();
    expect(() => parseRegisteredEvents('{"a":1}')).toThrow();
  });

  it("rejects malformed entries", () => {
    const base = {
      event_id: EVENT.eventId,
      genesis_txid: G_ID,
      org_pkh: EVENT.orgPkh,
      org_spk: EVENT.orgSpk,
      burn_template_hash: EVENT.burnTemplateHash,
      name: "x",
      date: "d",
      price: 1,
      capacity: 2,
    };
    expect(() => parseRegisteredEvents(JSON.stringify([{ ...base, event_id: "short" }]))).toThrow(
      /event_id/,
    );
    expect(() => parseRegisteredEvents(JSON.stringify([{ ...base, org_pkh: "short" }]))).toThrow(
      /org_pkh/,
    );
    expect(() => parseRegisteredEvents(JSON.stringify([{ ...base, capacity: 200 }]))).toThrow(
      /capacity/,
    );
    expect(() => parseRegisteredEvents(JSON.stringify([{ ...base, price: -1 }]))).toThrow(/price/);
    expect(() => parseRegisteredEvents(JSON.stringify([{ ...base, name: "" }]))).toThrow(/name/);
  });
});

function deploySpk(genesis: TxModel): string {
  const spk = genesis.outputs?.[0]?.script_public_key;
  if (typeof spk !== "string") throw new Error("fixture missing deploy covenant script");
  return spk;
}

function buyDeploy() {
  return buildDeploy({
    authorizingOutpoint: outpointBytes("11".repeat(TXID_BYTE_LENGTH), 0),
    organizerUtxos: [],
    organizerUtxoValues: [UTXO_VALUE],
    organizer: ORG_PKH,
    capacity: 3,
    constants: CONSTANTS,
    covenantCode: hexToBytes(EVENT_ARTIFACT.code),
    changeScript: { version: 0, script: "51" },
    fee: 1_000,
    network: NETWORK,
  });
}

function buyModel(): TxModel {
  const deploy = buyDeploy();
  const buy = buildBuy({
    eventOutpoint: outpointBytes(G_ID, 0),
    eventCovenantId: deploy.eventCovenantId,
    eventOwner: ORG_PKH,
    constants: CONSTANTS,
    buyer: new Uint8Array(TXID_BYTE_LENGTH).fill(BUYER_BYTE),
    buyerUtxos: [outpointBytes("33".repeat(TXID_BYTE_LENGTH), 0)],
    buyerUtxoValues: [UTXO_VALUE],
    orgScript: { version: 0, script: "51" },
    changeScript: { version: 0, script: "51" },
    covenantCode: hexToBytes(EVENT_ARTIFACT.code),
    remaining: 3,
    network: NETWORK,
    fee: 400,
  });
  return buyTxModel(buy, G_ID);
}

describe("eventAvailability (GET /v1/events/{id})", () => {
  it("reports sold 0 / left capacity when the event covenant is unspent", async () => {
    const deploy = deployModel(EVENT.capacity);
    const kaspa = new FakeKaspa(deploy);
    kaspa.utxosAt(addressFromScriptHash(deploySpk(deploy), NETWORK), {
      transactionId: G_ID,
      index: 0,
    });
    const availability = await eventAvailability(EVENT, kaspa, NETWORK);
    expect(availability).toEqual({ capacity: 3, sold: 0, left: 3 });
  });

  it("walks the event covenant lineage and counts mints as sold", async () => {
    const deploy = deployModel(EVENT.capacity);
    const kaspa = new FakeKaspa(deploy);
    // One mint: a buy tx spends the event covenant (G_ID:0) and re-creates it
    // with remaining 2 (output index 1).
    const buy = buyModel();
    const oldAddress = addressFromScriptHash(deploySpk(deploy), NETWORK);
    kaspa.addressTxs.set(oldAddress, [buy]); // spender visible at deploy address
    const newAddress = addressFromScriptHash(
      buy.outputs?.[1]?.script_public_key as string,
      NETWORK,
    );
    kaspa.utxosAt(newAddress, { transactionId: G_ID, index: 0 });

    const availability = await eventAvailability(EVENT, kaspa, NETWORK);
    expect(availability).toEqual({ capacity: 3, sold: 1, left: 2 });
  });
});

describe("eventAvailability (edge cases)", () => {
  it("handles a capacity-0 event", async () => {
    const deploy = deployModel(0);
    const kaspa = new FakeKaspa(deploy);
    const availability = await eventAvailability({ ...EVENT, capacity: 0 }, kaspa, NETWORK);
    expect(availability).toEqual({ capacity: 0, sold: 0, left: 0 });
  });

  it("treats a missing deploy tx as an invalid event, not an upstream outage", async () => {
    const kaspa = new FakeKaspa({
      transaction_id: "ff".repeat(TXID_BYTE_LENGTH),
      inputs: [],
      outputs: [],
    });
    await expect(eventAvailability(EVENT, kaspa, NETWORK)).rejects.toMatchObject({
      type: "invalid",
      statusCode: 400,
    });
  });
});
