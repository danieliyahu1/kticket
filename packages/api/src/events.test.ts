import {
  addressFromScriptHash,
  buildBuy,
  buildDeploy,
  type DecodedConstants,
  EVENT_ARTIFACT,
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

const NETWORK = "testnet10";
const EVENT_ID = new Uint8Array(32).map((_, i) => (i === 0 ? 0xab : i));
const ORG_SPK = new Uint8Array([0x21, 0x02, 0x00, 0x01]);
const ORG_PKH = new Uint8Array(32).fill(0x01);
const G_ID = "aa".repeat(32);

const CONSTANTS: DecodedConstants = {
  eventId: EVENT_ID,
  price: 1_000,
  orgSpk: ORG_SPK,
  burnTemplateHash: new Uint8Array(32).fill(0x77),
};

const EVENT: RegisteredEvent = {
  eventId: bytesToHex(EVENT_ID),
  genesisTxId: G_ID,
  orgPkh: bytesToHex(ORG_PKH),
  orgSpk: bytesToHex(ORG_SPK),
  burnTemplateHash: "77".repeat(32),
  name: "Testnet Rave",
  date: "2026-12-31",
  price: 1_000,
  capacity: 3,
};

function outpointBytes(txIdHex: string, index: number) {
  return { txId: hexToBytes(txIdHex), index };
}

function deployModel(capacity: number): TxModel {
  const { tx } = buildDeploy({
    authorizingOutpoint: outpointBytes("11".repeat(32), 0),
    organizerUtxos: [outpointBytes("22".repeat(32), 0)],
    organizerUtxoValues: [10_000_000_000, 10_000_000_000],
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
    expect(registry.byEventId("ff".repeat(32))).toBeUndefined();
    expect(registry.byGenesisTxId("ff".repeat(32))).toBeUndefined();
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

function buyModel(): TxModel {
  const deploy = buildDeploy({
    authorizingOutpoint: outpointBytes("11".repeat(32), 0),
    organizerUtxos: [],
    organizerUtxoValues: [10_000_000_000],
    organizer: ORG_PKH,
    capacity: 3,
    constants: CONSTANTS,
    covenantCode: hexToBytes(EVENT_ARTIFACT.code),
    changeScript: { version: 0, script: "51" },
    fee: 1_000,
    network: NETWORK,
  });
  const buy = buildBuy({
    eventOutpoint: outpointBytes(G_ID, 0),
    eventCovenantId: deploy.eventCovenantId,
    eventOwner: ORG_PKH,
    constants: CONSTANTS,
    buyer: new Uint8Array(32).fill(0x02),
    buyerUtxos: [outpointBytes("33".repeat(32), 0)],
    buyerUtxoValues: [10_000_000_000],
    orgScript: { version: 0, script: "51" },
    changeScript: { version: 0, script: "51" },
    covenantCode: hexToBytes(EVENT_ARTIFACT.code),
    remaining: 3,
    network: NETWORK,
    fee: 400,
  });
  return {
    transaction_id: G_ID,
    inputs: buy.inputs.map((input, index) => ({
      transaction_id: input.previousOutpoint.txId,
      index,
      previous_outpoint_hash: input.previousOutpoint.txId,
      previous_outpoint_index: String(input.previousOutpoint.index),
      signature_script: input.signatureScript,
    })),
    outputs: buy.outputs.map((output, index) => ({
      transaction_id: G_ID,
      index,
      amount: output.value,
      script_public_key: output.scriptPublicKey.script,
      covenant_authorizing_input: output.covenant?.authorizingInput ?? null,
    })),
  };
}

describe("eventAvailability (GET /v1/events/{id})", () => {
  it("reports sold 0 / left capacity when the event covenant is unspent", async () => {
    const deploy = deployModel(3);
    const kaspa = new FakeKaspa(deploy);
    kaspa.utxosAt(addressFromScriptHash(deploySpk(deploy), NETWORK), {
      transactionId: G_ID,
      index: 0,
    });
    const availability = await eventAvailability(EVENT, kaspa, NETWORK);
    expect(availability).toEqual({ capacity: 3, sold: 0, left: 3 });
  });

  it("walks the event covenant lineage and counts mints as sold", async () => {
    const deploy = deployModel(3);
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

  it("handles a capacity-0 event", async () => {
    const deploy = deployModel(0);
    const kaspa = new FakeKaspa(deploy);
    const availability = await eventAvailability({ ...EVENT, capacity: 0 }, kaspa, NETWORK);
    expect(availability).toEqual({ capacity: 0, sold: 0, left: 0 });
  });

  it("surfaces an upstream error when the deploy tx is missing", async () => {
    const kaspa = new FakeKaspa({ transaction_id: "ff".repeat(32), inputs: [], outputs: [] });
    await expect(eventAvailability(EVENT, kaspa, NETWORK)).rejects.toMatchObject({
      type: "upstream",
      statusCode: 503,
    });
  });
});
