// Shared in-memory chain + app harness for whole-flow API tests (door flow,
// resale). External dependencies are mocked: chain reads come from a seeded
// FakeKaspa, the wRPC broadcast is mocked, and "wallets" are simulated as
// 65-byte signature pushes — only kticket's own code is exercised end to end.

import {
  buildBuy,
  buildDeploy,
  p2pkAddress,
  type UnsignedTransaction,
} from "@kticket/kit";
import { hexToBytes } from "@noble/hashes/utils.js";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { EventStore } from "./eventstore";
import { ListingStoreFile } from "./listings";
import type { KaspaClientLike } from "./kaspa-client";
import type {
  FeeEstimateResponse,
  SubmitTransactionResponse,
  TxMass,
  TxModel,
  UtxoResponse,
} from "./kaspa-types";
import { cannedBurnTemplateHash, cannedEventArtifact } from "./test-artifacts";
import { VerifiedEventCache } from "./verified-cache";

export const TXID_BYTE_LENGTH = 32;
export const NETWORK = "testnet10" as const;

export const G_ID = "aa".repeat(TXID_BYTE_LENGTH);
export const B0_ID = "bb".repeat(TXID_BYTE_LENGTH);
export const AUTH_TXID = "ab".repeat(TXID_BYTE_LENGTH);
/** The canned txid every mocked broadcast returns. */
export const USED_TXID = "ee".repeat(TXID_BYTE_LENGTH);

export const ORG_PKH_HEX = "01".repeat(TXID_BYTE_LENGTH);
export const ORG_SPK_HEX = `20${ORG_PKH_HEX}ac`;
export const AUTH_TXID_HEX = AUTH_TXID;
export const BURN_TEMPLATE_HASH = cannedBurnTemplateHash;

export const EVENT_NAME = "Testnet Rave";
export const EVENT_DATE = "2026-12-31";
export const EVENT_PRICE = 1_000;
export const EVENT_CAPACITY = 2;

/** The ticket holder — the seller once resale enters the picture. */
export const TICKET_OWNER_HEX = "02".repeat(TXID_BYTE_LENGTH);
export const OWNER_PUBKEY_HEX = `02${TICKET_OWNER_HEX}`;
export const OWNER_ADDRESS = p2pkAddress(hexToBytes(TICKET_OWNER_HEX), NETWORK);
export const OWNER_UTXO_TXID = "dd".repeat(TXID_BYTE_LENGTH);
export const TICKET_ID = `${B0_ID}:0`;

export function eventArtifact() {
  return cannedEventArtifact;
}

function deployArgs() {
  return {
    authorizingOutpoint: { txId: hexToBytes(AUTH_TXID_HEX), index: 0 },
    organizerUtxos: [],
    organizerUtxoValues: [10_000_000_000],
    organizer: hexToBytes(ORG_PKH_HEX),
    capacity: EVENT_CAPACITY,
    eventArtifact: eventArtifact(),
    changeScript: { version: 0, script: "51" },
    fee: 1_000,
    network: NETWORK,
  };
}

let cachedCovenantId: string | undefined;

export function eventCovenantId(): string {
  cachedCovenantId ??= buildDeploy(deployArgs()).eventCovenantId;
  return cachedCovenantId;
}

export const TEST_COVENANT_ID = eventCovenantId();

export function deployTx(): TxModel {
  const { tx } = buildDeploy({
    ...deployArgs(),
    metadata: {
      name: EVENT_NAME,
      date: EVENT_DATE,
      priceKAS: EVENT_PRICE / 100_000_000,
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

export function fundingTx(): TxModel {
  return {
    transaction_id: AUTH_TXID,
    inputs: [],
    outputs: [
      {
        transaction_id: AUTH_TXID,
        index: 0,
        amount: 10_000_000_000,
        script_public_key: ORG_SPK_HEX,
      },
    ],
  };
}

/** The mint tx: the event covenant splits into the owner's ticket + remainder. */
export function buyTx(): TxModel {
  const tx: UnsignedTransaction = buildBuy({
    eventOutpoint: { txId: hexToBytes(G_ID), index: 0 },
    eventCovenantId: TEST_COVENANT_ID,
    eventOwner: hexToBytes(ORG_PKH_HEX),
    eventArtifact: eventArtifact(),
    buyer: hexToBytes(TICKET_OWNER_HEX),
    buyerUtxos: [{ txId: new Uint8Array(TXID_BYTE_LENGTH).fill(0x03), index: 0 }],
    buyerUtxoValues: [10_000_000_000],
    orgScript: { version: 0, script: ORG_SPK_HEX },
    changeScript: { version: 0, script: "51" },
    remaining: EVENT_CAPACITY,
    price: EVENT_PRICE,
    network: NETWORK,
    fee: 400,
  });
  return {
    transaction_id: B0_ID,
    inputs: tx.inputs.map((input, index) => ({
      transaction_id: input.previousOutpoint.txId,
      index,
      previous_outpoint_hash: input.previousOutpoint.txId,
      previous_outpoint_index: String(input.previousOutpoint.index),
      signature_script: input.signatureScript,
    })),
    outputs: tx.outputs.map((output, index) => ({
      transaction_id: B0_ID,
      index,
      amount: output.value,
      script_public_key: output.scriptPublicKey.script,
      covenant_authorizing_input: output.covenant?.authorizingInput ?? null,
      covenant_id: output.covenant?.covenantId ?? null,
    })),
  };
}

export class FakeKaspa implements KaspaClientLike {
  utxoMap = new Map<string, UtxoResponse[]>();
  transactions = new Map<string, TxModel>();
  feeEstimate: FeeEstimateResponse = {
    priorityBucket: { feerate: 200, estimatedSeconds: 1 },
    normalBuckets: [],
    lowBuckets: [],
  };
  mass: TxMass = { mass: 1_000, storage_mass: 0, compute_mass: 1_000 };
  clearCalls = 0;

  clearCache(): void {
    this.clearCalls += 1;
  }
  async getUtxos(address: string): Promise<UtxoResponse[]> {
    return this.utxoMap.get(address) ?? [];
  }
  async getUtxosForAddresses(addresses: string[]): Promise<UtxoResponse[]> {
    return addresses.flatMap((a) => this.utxoMap.get(a) ?? []);
  }
  async getFullTransactions(address: string): Promise<TxModel[]> {
    return [this.transactions.get(address.toLowerCase()) ?? []].flat();
  }
  async getTransaction(txId: string): Promise<TxModel | null> {
    return this.transactions.get(txId.toLowerCase()) ?? null;
  }
  async getFeeEstimate(): Promise<FeeEstimateResponse> {
    return this.feeEstimate;
  }
  async computeMass(): Promise<TxMass> {
    return this.mass;
  }
  async broadcastTransaction(): Promise<SubmitTransactionResponse> {
    return { transactionId: USED_TXID };
  }
}

/** The deployed-event chain with a minted, unlisted ticket and its owner funded. */
export function seedBaseChain(kaspa: FakeKaspa): void {
  kaspa.transactions.set(AUTH_TXID, fundingTx());
  kaspa.transactions.set(G_ID, deployTx());
  kaspa.transactions.set(B0_ID, buyTx());
  kaspa.transactions.set(OWNER_UTXO_TXID, {
    transaction_id: OWNER_UTXO_TXID,
    accepting_block_blue_score: 100,
    inputs: [],
    outputs: [
      {
        transaction_id: OWNER_UTXO_TXID,
        index: 0,
        amount: 1_000_000_000,
        script_public_key: `20${TICKET_OWNER_HEX}ac`,
      },
    ],
  });
  kaspa.utxoMap.set(OWNER_ADDRESS, [
    {
      address: OWNER_ADDRESS,
      outpoint: { transactionId: OWNER_UTXO_TXID, index: 0 },
      utxoEntry: {
        amount: String(1_000_000_000),
        scriptPublicKey: { scriptPublicKey: `20${TICKET_OWNER_HEX}ac` },
        blockDaaScore: "100",
        isCoinbase: false,
      },
    },
  ]);
}

export async function buildAppWith(kaspa: FakeKaspa, listings = new ListingStoreFile()) {
  const events = new EventStore();
  await events.register({
    covenantId: TEST_COVENANT_ID,
    deployTxId: G_ID,
    organizerAddress: p2pkAddress(hexToBytes(ORG_PKH_HEX), NETWORK),
  });
  return buildApp(loadConfig({ KASPANET: NETWORK, AUTH_SECRET: "test-secret-for-kticket-api" }), {
    kaspa,
    events,
    listings,
    network: NETWORK,
    networkId: "testnet-10",
    verified: new VerifiedEventCache(),
  });
}
