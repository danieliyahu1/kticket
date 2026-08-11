import {
  addressFromScriptHash,
  buildBuy,
  buildDeploy,
  p2pkAddress,
  type UnsignedTransaction,
} from "@kticket/kit";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { compileBurnArtifact, compileEventArtifact } from "./compiler";
import { eventAvailability } from "./events";
import type { KaspaClientLike } from "./kaspa-client";
import type { TxModel, UtxoResponse } from "./kaspa-types";
import { verifyEventFromChain } from "./provenance";

const TXID_BYTE_LENGTH = 32;
const ORG_PKH = new Uint8Array(TXID_BYTE_LENGTH).fill(0x01);
const BUYER_BYTE = 0x02;
const UTXO_VALUE = 10_000_000_000;

const NETWORK = "testnet10";
const AUTH_TXID = "ab".repeat(TXID_BYTE_LENGTH);
const G_ID = "aa".repeat(TXID_BYTE_LENGTH);
const ORG_PKH_HEX = bytesToHex(ORG_PKH);
const ORG_SPK_HEX = `20${ORG_PKH_HEX}ac`;
const BURN_TEMPLATE_HASH = bytesToHex(
  Uint8Array.from(compileBurnArtifact(AUTH_TXID).template_hash),
);

const NAME = "Testnet Rave";
const DATE = "2026-12-31";
const TIME = "20:00";
const PRICE = 1_000;
const CAPACITY = 3;

function outpointBytes(txIdHex: string, index: number) {
  return { txId: hexToBytes(txIdHex), index };
}

function eventArtifact() {
  return compileEventArtifact({
    authorizingTxId: AUTH_TXID,
    price: PRICE,
    orgSpk: ORG_SPK_HEX,
    burnTemplateHash: BURN_TEMPLATE_HASH,
  });
}

function deployModel(capacity: number): TxModel {
  const artifact = compileEventArtifact({
    authorizingTxId: AUTH_TXID,
    price: PRICE,
    orgSpk: ORG_SPK_HEX,
    burnTemplateHash: BURN_TEMPLATE_HASH,
  });
  const { tx } = buildDeploy({
    authorizingOutpoint: outpointBytes(AUTH_TXID, 0),
    organizerUtxos: [],
    organizerUtxoValues: [UTXO_VALUE],
    organizer: ORG_PKH,
    capacity,
    eventArtifact: artifact,
    changeScript: { version: 0, script: "51" },
    fee: 1_000,
    network: NETWORK,
    metadata: {
      name: NAME,
      date: DATE,
      time: TIME,
      priceKAS: PRICE / 100_000_000,
      orgSpk: ORG_SPK_HEX,
      burnTemplateHash: BURN_TEMPLATE_HASH,
    },
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
    payload: tx.payload,
  };
}

function fundingModel(): TxModel {
  return {
    transaction_id: AUTH_TXID,
    inputs: [],
    outputs: [
      {
        transaction_id: AUTH_TXID,
        index: 0,
        amount: UTXO_VALUE,
        script_public_key: ORG_SPK_HEX,
      },
    ],
  };
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
    const lower = txId.toLowerCase();
    if (lower === this.genesis.transaction_id) return this.genesis;
    if (lower === AUTH_TXID) return fundingModel();
    return this.addressTxs.get(lower)?.find((t) => t.transaction_id === lower) ?? null;
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

function deploySpk(genesis: TxModel): string {
  const spk = genesis.outputs?.[0]?.script_public_key;
  if (typeof spk !== "string") throw new Error("fixture missing deploy covenant script");
  return spk;
}

function buyModel(): TxModel {
  const artifact = compileEventArtifact({
    authorizingTxId: AUTH_TXID,
    price: PRICE,
    orgSpk: ORG_SPK_HEX,
    burnTemplateHash: BURN_TEMPLATE_HASH,
  });
  const deploy = buildDeploy({
    authorizingOutpoint: outpointBytes(AUTH_TXID, 0),
    organizerUtxos: [],
    organizerUtxoValues: [UTXO_VALUE],
    organizer: ORG_PKH,
    capacity: CAPACITY,
    eventArtifact: artifact,
    changeScript: { version: 0, script: "51" },
    fee: 1_000,
    network: NETWORK,
  });
  const buy = buildBuy({
    eventOutpoint: outpointBytes(G_ID, 0),
    eventCovenantId: deploy.eventCovenantId,
    eventOwner: ORG_PKH,
    eventArtifact: artifact,
    buyer: new Uint8Array(TXID_BYTE_LENGTH).fill(BUYER_BYTE),
    buyerUtxos: [outpointBytes("33".repeat(TXID_BYTE_LENGTH), 0)],
    buyerUtxoValues: [UTXO_VALUE],
    orgScript: { version: 0, script: ORG_SPK_HEX },
    changeScript: { version: 0, script: "51" },
    remaining: CAPACITY,
    price: PRICE,
    network: NETWORK,
    fee: 400,
  });
  return buyTxModel(buy, G_ID);
}

describe("verifyEventFromChain (KTK-89 trustless provenance)", () => {
  it("recovers name/date/time/price/owner/capacity from the deploy tx", async () => {
    const deploy = deployModel(CAPACITY);
    const kaspa = new FakeKaspa(deploy);
    const verified = await verifyEventFromChain(kaspa, NETWORK, G_ID);
    expect(verified).toMatchObject({
      deploy_txid: G_ID,
      name: NAME,
      date: DATE,
      time: TIME,
      price: PRICE,
      capacity: CAPACITY,
      organizer_address: p2pkAddress(ORG_PKH, NETWORK),
      owner_pkh: ORG_PKH_HEX,
      org_spk: ORG_SPK_HEX,
      authorizing_txid: AUTH_TXID,
    });
    expect(verified.raw_chain).toMatchObject({
      deploy_txid: G_ID,
      authorizing_txid: AUTH_TXID,
      maker_address: p2pkAddress(ORG_PKH, NETWORK),
      decoded_state: { owner: ORG_PKH_HEX, capacity: CAPACITY },
    });
  });

  it("treats a missing deploy tx as invalid, not an upstream outage", async () => {
    const kaspa = new FakeKaspa({
      transaction_id: "ff".repeat(TXID_BYTE_LENGTH),
      inputs: [],
      outputs: [],
    });
    await expect(verifyEventFromChain(kaspa, NETWORK, G_ID)).rejects.toMatchObject({
      type: "invalid",
      statusCode: 400,
    });
  });

  it("fails verification when the covenant output does not commit to the constants", async () => {
    const deploy = deployModel(CAPACITY);
    const tampered = {
      ...deploy,
      outputs: deploy.outputs?.map((o, i) =>
        i === 0 ? { ...o, script_public_key: "51" } : o,
      ),
    };
    const kaspa = new FakeKaspa(tampered);
    await expect(verifyEventFromChain(kaspa, NETWORK, G_ID)).rejects.toMatchObject({
      type: "invalid",
    });
  });
});

describe("eventAvailability (KTK-89 — chain-derived)", () => {
  it("reports sold 0 / left capacity when the event covenant is unspent", async () => {
    const deploy = deployModel(CAPACITY);
    const kaspa = new FakeKaspa(deploy);
    kaspa.utxosAt(addressFromScriptHash(deploySpk(deploy), NETWORK), {
      transactionId: G_ID,
      index: 0,
    });
    const verified = await verifyEventFromChain(kaspa, NETWORK, G_ID);
    const availability = await eventAvailability(verified, kaspa, NETWORK);
    expect(availability).toMatchObject({ capacity: CAPACITY, sold: 0, left: CAPACITY });
  });

  it("walks the event covenant lineage and counts mints as sold", async () => {
    const deploy = deployModel(CAPACITY);
    const kaspa = new FakeKaspa(deploy);
    const buy = buyModel();
    const oldAddress = addressFromScriptHash(deploySpk(deploy), NETWORK);
    kaspa.addressTxs.set(oldAddress, [buy]);
    const newAddress = addressFromScriptHash(
      buy.outputs?.[1]?.script_public_key as string,
      NETWORK,
    );
    kaspa.utxosAt(newAddress, { transactionId: G_ID, index: 0 });

    const verified = await verifyEventFromChain(kaspa, NETWORK, G_ID);
    const availability = await eventAvailability(verified, kaspa, NETWORK);
    expect(availability).toMatchObject({ capacity: CAPACITY, sold: 1, left: CAPACITY - 1 });
  });
});
