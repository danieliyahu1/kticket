import {
  addressFromScriptHash,
  buildBuy,
  buildDeploy,
  type UnsignedTransaction,
} from "@kticket/kit";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { compileBurnArtifact, compileEventArtifact } from "./compiler";
import { eventAvailability, parseRegisterEventBody } from "./events";
import type { StoredEventInternal } from "./eventstore";
import type { KaspaClientLike } from "./kaspa-client";
import type { TxModel, UtxoResponse } from "./kaspa-types";

const TXID_BYTE_LENGTH = 32;
const EVENT_ID_FIRST_BYTE = 0xab;
const ORG_SPK_VERSION = 0x21;
const ORG_SPK_FLAG = 0x02;
const ORG_SPK_ZERO_BYTE = 0x00;
const ORG_SPK_LENGTH_BYTE = 0x01;
const ORG_PKH_BYTE = 0x01;
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

const EVENT_ID_HEX = bytesToHex(EVENT_ID);
const ORG_SPK_HEX = bytesToHex(ORG_SPK);
const ORG_PKH_HEX = bytesToHex(ORG_PKH);
const BURN_TEMPLATE_HASH = bytesToHex(
  Uint8Array.from(compileBurnArtifact(EVENT_ID_HEX).template_hash),
);

const EVENT: StoredEventInternal = {
  covenantId: "cc".repeat(TXID_BYTE_LENGTH),
  genesisTxId: G_ID,
  orgPkh: ORG_PKH_HEX,
  orgSpk: ORG_SPK_HEX,
  burnTemplateHash: BURN_TEMPLATE_HASH,
  name: "Testnet Rave",
  date: "2026-12-31",
  price: 1_000,
  capacity: 3,
  authorizingTxId: EVENT_ID_HEX,
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

function eventArtifact() {
  return compileEventArtifact({
    authorizingTxId: EVENT_ID_HEX,
    price: 1_000,
    orgSpk: ORG_SPK_HEX,
    burnTemplateHash: BURN_TEMPLATE_HASH,
  });
}

function deployModel(capacity: number): TxModel {
  const { tx } = buildDeploy({
    authorizingOutpoint: outpointBytes("11".repeat(TXID_BYTE_LENGTH), 0),
    organizerUtxos: [outpointBytes("22".repeat(TXID_BYTE_LENGTH), 0)],
    organizerUtxoValues: [UTXO_VALUE, UTXO_VALUE],
    organizer: ORG_PKH,
    capacity,
    eventArtifact: eventArtifact(),
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

describe("parseRegisterEventBody (POST /v1/events)", () => {
  it("parses a valid registration body", () => {
    const parsed = parseRegisterEventBody({
      genesis_txid: G_ID,
      org_pkh: bytesToHex(ORG_PKH),
      name: "Testnet Rave",
      date: "2026-12-31",
      price: 1_000,
      capacity: 3,
      org_spk: bytesToHex(ORG_SPK),
      burn_template_hash: "77".repeat(TXID_BYTE_LENGTH),
      authorizing_txid: bytesToHex(EVENT_ID),
    });
    expect(parsed).toEqual({
      genesisTxId: G_ID,
      orgPkh: bytesToHex(ORG_PKH),
      name: "Testnet Rave",
      date: "2026-12-31",
      price: 1_000,
      capacity: 3,
      orgSpk: bytesToHex(ORG_SPK),
      burnTemplateHash: "77".repeat(TXID_BYTE_LENGTH),
      authorizingTxId: bytesToHex(EVENT_ID),
    });
  });

  it("rejects missing fields", () => {
    const base = {
      genesis_txid: G_ID,
      org_pkh: bytesToHex(ORG_PKH),
      name: "x",
      date: "d",
      price: 1,
      capacity: 2,
      org_spk: bytesToHex(ORG_SPK),
      burn_template_hash: "77".repeat(TXID_BYTE_LENGTH),
      authorizing_txid: bytesToHex(EVENT_ID),
    };
    expect(() => parseRegisterEventBody({ ...base, genesis_txid: "short" })).toThrow(
      /genesis_txid/,
    );
    expect(() => parseRegisterEventBody({ ...base, org_pkh: "short" })).toThrow(
      /org_pkh/,
    );
    expect(() => parseRegisterEventBody({ ...base, capacity: 200 })).toThrow(
      /capacity/,
    );
    expect(() => parseRegisterEventBody({ ...base, price: -1 })).toThrow(/price/);
    expect(() => parseRegisterEventBody({ ...base, name: "" })).toThrow(/name/);
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
    eventArtifact: eventArtifact(),
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
    eventArtifact: eventArtifact(),
    buyer: new Uint8Array(TXID_BYTE_LENGTH).fill(BUYER_BYTE),
    buyerUtxos: [outpointBytes("33".repeat(TXID_BYTE_LENGTH), 0)],
    buyerUtxoValues: [UTXO_VALUE],
    orgScript: { version: 0, script: "51" },
    changeScript: { version: 0, script: "51" },
    remaining: 3,
    price: 1_000,
    network: NETWORK,
    fee: 400,
  });
  return buyTxModel(buy, G_ID);
}

describe("eventAvailability (GET /v1/events/{covenant_id})", () => {
  it("reports sold 0 / left capacity when the event covenant is unspent", async () => {
    const deploy = deployModel(EVENT.capacity);
    const kaspa = new FakeKaspa(deploy);
    kaspa.utxosAt(addressFromScriptHash(deploySpk(deploy), NETWORK), {
      transactionId: G_ID,
      index: 0,
    });
    const availability = await eventAvailability(EVENT, kaspa, NETWORK);
    expect(availability).toMatchObject({ capacity: 3, sold: 0, left: 3 });
  });

  it("walks the event covenant lineage and counts mints as sold", async () => {
    const deploy = deployModel(EVENT.capacity);
    const kaspa = new FakeKaspa(deploy);
    const buy = buyModel();
    const oldAddress = addressFromScriptHash(deploySpk(deploy), NETWORK);
    kaspa.addressTxs.set(oldAddress, [buy]);
    const newAddress = addressFromScriptHash(
      buy.outputs?.[1]?.script_public_key as string,
      NETWORK,
    );
    kaspa.utxosAt(newAddress, { transactionId: G_ID, index: 0 });

    const availability = await eventAvailability(EVENT, kaspa, NETWORK);
    expect(availability).toMatchObject({ capacity: 3, sold: 1, left: 2 });
  });
});

describe("eventAvailability (edge cases)", () => {
  it("handles a capacity-0 event", async () => {
    const deploy = deployModel(0);
    const kaspa = new FakeKaspa(deploy);
    const availability = await eventAvailability(
      { ...EVENT, capacity: 0 },
      kaspa,
      NETWORK,
    );
    expect(availability).toMatchObject({ capacity: 0, sold: 0, left: 0 });
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
