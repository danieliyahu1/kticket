import {
  addressFromScriptHash,
  buildBuy,
  buildDeploy,
  injectState,
  p2pkAddress,
  p2shScript,
  type UnsignedTransaction,
} from "@kticket/kit";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app";
import { compileBurnArtifact, compileEventArtifact } from "./compiler";
import { loadConfig } from "./config";
import { EventStore, type StoredEvent } from "./eventstore";
import { HTTP_BAD_REQUEST, HTTP_NOT_FOUND, HTTP_OK } from "./http-status.js";
import { ListingStoreFile } from "./listings";
import { VerifiedEventCache } from "./verified-cache";

vi.mock("./wrpc-client.js", () => ({
  submitTransactionOverWrpc: vi.fn(),
}));

import { submitTransactionOverWrpc } from "./wrpc-client.js";

const mockedSubmit = vi.mocked(submitTransactionOverWrpc);

import type { KaspaClientLike } from "./kaspa-client";
import type {
  FeeEstimateResponse,
  SubmitTransactionResponse,
  TxMass,
  TxModel,
  UtxoResponse,
} from "./kaspa-types";

const TXID_BYTE_LENGTH = 32;
const SIGNATURE_SCRIPT_BYTE_LENGTH = 70;
const UTXO_VALUE = 10_000_000_000;
const BUYER_BYTE = 0x02;
const BUYER_UTXO_BYTE = 0x03;

const NETWORK = "testnet10";
const G_ID = "aa".repeat(TXID_BYTE_LENGTH);
const B0_ID = "bb".repeat(TXID_BYTE_LENGTH);
const AUTH_TXID = "ab".repeat(TXID_BYTE_LENGTH);

const AUTH_TXID_HEX = AUTH_TXID;
const ORG_PKH_HEX = "01".repeat(TXID_BYTE_LENGTH);
const ORG_SPK_HEX = `20${ORG_PKH_HEX}ac`;
const BURN_TEMPLATE_HASH = bytesToHex(
  Uint8Array.from(compileBurnArtifact(AUTH_TXID_HEX).template_hash),
);

const EVENT_NAME = "Testnet Rave";
const EVENT_DATE = "2026-12-31";
const EVENT_TIME = "20:00";
const EVENT_PRICE = 1_000;
const EVENT_CAPACITY = 2;

function eventArtifact() {
  return compileEventArtifact({
    authorizingTxId: AUTH_TXID_HEX,
    price: EVENT_PRICE,
    orgSpk: ORG_SPK_HEX,
    burnTemplateHash: BURN_TEMPLATE_HASH,
  });
}

function computeTestCovenantId(): string {
  const artifact = eventArtifact();
  const { eventCovenantId } = buildDeploy({
    authorizingOutpoint: { txId: hexToBytes(AUTH_TXID_HEX), index: 0 },
    organizerUtxos: [],
    organizerUtxoValues: [UTXO_VALUE],
    organizer: hexToBytes(ORG_PKH_HEX),
    capacity: EVENT_CAPACITY,
    eventArtifact: artifact,
    changeScript: { version: 0, script: "51" },
    fee: 1_000,
    network: NETWORK,
  });
  return eventCovenantId;
}

const TEST_COVENANT_ID = computeTestCovenantId();

function makeStoredEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    covenantId: TEST_COVENANT_ID,
    deployTxId: G_ID,
    organizerAddress: p2pkAddress(hexToBytes(ORG_PKH_HEX), NETWORK),
    ...overrides,
  };
}

function deployTxWithCapacity(
  capacity: number,
  metaOverrides: Record<string, unknown> = {},
): TxModel {
  const { tx } = buildDeploy({
    authorizingOutpoint: { txId: hexToBytes(AUTH_TXID_HEX), index: 0 },
    organizerUtxos: [],
    organizerUtxoValues: [UTXO_VALUE],
    organizer: hexToBytes(ORG_PKH_HEX),
    capacity,
    eventArtifact: eventArtifact(),
    changeScript: { version: 0, script: "51" },
    fee: 1_000,
    network: NETWORK,
    metadata: {
      name: EVENT_NAME,
      date: EVENT_DATE,
      time: EVENT_TIME,
      priceKAS: EVENT_PRICE / 100_000_000,
      orgSpk: ORG_SPK_HEX,
      burnTemplateHash: BURN_TEMPLATE_HASH,
      ...metaOverrides,
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

function fundingTx(): TxModel {
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

function deployTx(): TxModel {
  return deployTxWithCapacity(EVENT_CAPACITY);
}

function buyTxModelFrom(tx: UnsignedTransaction, txId: string = B0_ID): TxModel {
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

function buyTx(): TxModel {
  const tx = buildBuy({
    eventOutpoint: { txId: hexToBytes(G_ID), index: 0 },
    eventCovenantId: TEST_COVENANT_ID,
    eventOwner: hexToBytes(ORG_PKH_HEX),
    eventArtifact: eventArtifact(),
    buyer: new Uint8Array(TXID_BYTE_LENGTH).fill(BUYER_BYTE),
    buyerUtxos: [{ txId: new Uint8Array(TXID_BYTE_LENGTH).fill(BUYER_UTXO_BYTE), index: 0 }],
    buyerUtxoValues: [UTXO_VALUE],
    orgScript: { version: 0, script: ORG_SPK_HEX },
    changeScript: { version: 0, script: "51" },
    remaining: EVENT_CAPACITY,
    price: EVENT_PRICE,
    network: NETWORK,
    fee: 400,
  });
  return buyTxModelFrom(tx);
}

function config() {
  return loadConfig({ KASPANET: NETWORK });
}

function makeEventStore(): EventStore {
  const store = new EventStore();
  // The in-memory store mutates synchronously; the returned promise carries no work.
  void store.register(makeStoredEvent());
  return store;
}

function readerApp(
  kaspa: KaspaClientLike,
  events: EventStore = makeEventStore(),
  listings: ListingStoreFile = new ListingStoreFile(),
) {
  return buildApp(config(), {
    kaspa,
    events,
    listings,
    network: NETWORK,
    networkId: "testnet-10",
    verified: new VerifiedEventCache(),
  });
}

function seedVerifiedEvent(kaspa: FakeKaspa): void {
  kaspa.transactions.set(AUTH_TXID, fundingTx());
  kaspa.transactions.set(G_ID, deployTx());
}

describe("reader routes (KTK-89 stateless directory)", () => {
  it("GET /v1/events lists chain-verified event facts", async () => {
    const kaspa = new FakeKaspa();
    seedVerifiedEvent(kaspa);
    const app = await readerApp(kaspa);
    const res = await app.inject({ method: "GET", url: "/v1/events" });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json()).toEqual([
      {
        covenant_id: TEST_COVENANT_ID,
        deploy_txid: G_ID,
        organizer_address: p2pkAddress(hexToBytes(ORG_PKH_HEX), NETWORK),
        name: EVENT_NAME,
        date: EVENT_DATE,
        time: EVENT_TIME,
        ticker: "",
        decimals: 0,
        image: "",
        image_hash: "",
        price: EVENT_PRICE,
        capacity: EVENT_CAPACITY,
        verified: true,
      },
    ]);
    await app.close();
  });

  it("GET /v1/events hides registry entries that fail on-chain verification", async () => {
    const app = await readerApp(new FakeKaspa());
    const res = await app.inject({ method: "GET", url: "/v1/events" });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it("GET /v1/events/{id} rejects unknown events (never fabricate)", async () => {
    const app = await readerApp(new FakeKaspa());
    const res = await app.inject({
      method: "GET",
      url: `/v1/events/${"ff".repeat(TXID_BYTE_LENGTH)}`,
    });
    expect(res.statusCode).toBe(HTTP_NOT_FOUND);
    expect(res.json().error.type).toBe("invalid");
    await app.close();
  });
});

describe("reader routes (KTK-89) — event detail", () => {
  it("GET /v1/events/{id} returns verified event facts + raw chain data", async () => {
    const kaspa = new FakeKaspa();
    seedVerifiedEvent(kaspa);
    const app = await readerApp(kaspa);
    const res = await app.inject({ method: "GET", url: `/v1/events/${TEST_COVENANT_ID}` });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json()).toMatchObject({
      event: {
        covenant_id: TEST_COVENANT_ID,
        deploy_txid: G_ID,
        name: EVENT_NAME,
        date: EVENT_DATE,
        time: EVENT_TIME,
        price: EVENT_PRICE,
        capacity: EVENT_CAPACITY,
        verified: true,
      },
      raw_chain: {
        deploy_txid: G_ID,
        authorizing_txid: AUTH_TXID,
        maker_address: p2pkAddress(hexToBytes(ORG_PKH_HEX), NETWORK),
        decoded_state: { owner: ORG_PKH_HEX, capacity: 2 },
      },
    });
    expect(res.json().availability).toBeUndefined();
    expect(res.json().buy_info).toBeUndefined();
    await app.close();
  });

  it("GET /v1/events/{id} surfaces the KCC-0021 standard keys when set", async () => {
    const IMAGE_HASH_UPPER = "3B8C4E0F2A1D6B9C7E5F4A2D8B0C1E3F6A9D2C5B8E1F4A7D0C3B6E9F2A5D8C1B";
    const kaspa = new FakeKaspa();
    kaspa.transactions.set(AUTH_TXID, fundingTx());
    kaspa.transactions.set(
      G_ID,
      deployTxWithCapacity(EVENT_CAPACITY, {
        ticker: "RAVE",
        decimals: 0,
        image: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
        image_hash: IMAGE_HASH_UPPER,
      }),
    );
    const app = await readerApp(kaspa);
    const res = await app.inject({ method: "GET", url: `/v1/events/${TEST_COVENANT_ID}` });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json().event).toMatchObject({
      name: EVENT_NAME,
      date: EVENT_DATE,
      price: EVENT_PRICE,
      ticker: "RAVE",
      decimals: 0,
      image: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
      image_hash: IMAGE_HASH_UPPER.toLowerCase(),
    });
    await app.close();
  });

  it("GET /v1/events/{id} still serves a legacy {n, d, p} payload event", async () => {
    const kaspa = new FakeKaspa();
    const deploy = deployTxWithCapacity(EVENT_CAPACITY);
    deploy.payload = bytesToHex(
      new TextEncoder().encode(JSON.stringify({ n: EVENT_NAME, d: EVENT_DATE, p: EVENT_PRICE })),
    );
    kaspa.transactions.set(AUTH_TXID, fundingTx());
    kaspa.transactions.set(G_ID, deploy);
    const app = await readerApp(kaspa);
    const res = await app.inject({ method: "GET", url: `/v1/events/${TEST_COVENANT_ID}` });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json().event).toMatchObject({
      name: EVENT_NAME,
      date: EVENT_DATE,
      price: EVENT_PRICE,
      ticker: "",
      decimals: 0,
    });
    await app.close();
  });
});

describe("reader routes (KTK-89) — event validation", () => {
  it("GET /v1/events/{id} treats a missing deploy tx as invalid (400)", async () => {
    const app = await readerApp(new FakeKaspa());
    const res = await app.inject({ method: "GET", url: `/v1/events/${TEST_COVENANT_ID}` });
    expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
    expect(res.json().error.type).toBe("invalid");
    expect(res.json().error.retryable).toBe(false);
    await app.close();
  });
});

describe("reader routes (KTK-89) — GET /v1/tickets (my tickets)", () => {
  // buyTx() mints the ticket to owner = 0x02 * 32 (the buyer's x-coordinate).
  const TICKET_OWNER_HEX = "02".repeat(TXID_BYTE_LENGTH);
  const COMPRESSED_PUBKEY_HEX = `02${TICKET_OWNER_HEX}`;

  function seedTicket(kaspa: FakeKaspa): void {
    const buy = buyTx();
    kaspa.transactions.set(B0_ID, buy);
    const ticketScript = buy.outputs?.[0]?.script_public_key as string;
    const ticketAddress = addressFromScriptHash(ticketScript, NETWORK);
    kaspa.utxoMap.set(ticketAddress, [
      {
        address: ticketAddress,
        outpoint: { transactionId: B0_ID, index: 0 },
        utxoEntry: {
          amount: "0",
          scriptPublicKey: { scriptPublicKey: "" },
          blockDaaScore: "0",
          isCoinbase: false,
        },
      },
    ]);
  }

  it("finds tickets for a 66-hex compressed public key (prefix stripped)", async () => {
    const kaspa = new FakeKaspa();
    seedVerifiedEvent(kaspa);
    seedTicket(kaspa);
    const app = await readerApp(kaspa);
    const res = await app.inject({
      method: "GET",
      url: `/v1/tickets?owner_pkh=${COMPRESSED_PUBKEY_HEX}`,
    });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json()).toEqual([
      {
        ticket_id: `${B0_ID}:0`,
        covenant_id: TEST_COVENANT_ID,
        event_name: EVENT_NAME,
        event_date: EVENT_DATE,
        event_time: EVENT_TIME,
      },
    ]);
    await app.close();
  });

  it("finds tickets for a 64-hex x-coordinate (already stripped)", async () => {
    const kaspa = new FakeKaspa();
    seedVerifiedEvent(kaspa);
    seedTicket(kaspa);
    const app = await readerApp(kaspa);
    const res = await app.inject({
      method: "GET",
      url: `/v1/tickets?owner_pkh=${TICKET_OWNER_HEX}`,
    });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json()).toEqual([
      {
        ticket_id: `${B0_ID}:0`,
        covenant_id: TEST_COVENANT_ID,
        event_name: EVENT_NAME,
        event_date: EVENT_DATE,
        event_time: EVENT_TIME,
      },
    ]);
    await app.close();
  });

  it("also walks LISTED tickets the caller owns (index proposes, chain disposes)", async () => {
    const kaspa = new FakeKaspa();
    seedVerifiedEvent(kaspa);
    seedTicket(kaspa);

    // The listed ticket lives at a NEW outpoint whose script commits to the
    // listed state (owner, price) — exactly what a real list tx produces.
    const LIST_TXID = "cc".repeat(TXID_BYTE_LENGTH);
    const LIST_PRICE = 150_000_000;
    const listedScript = p2shScript(
      injectState(eventArtifact(), {
        owner: hexToBytes(TICKET_OWNER_HEX),
        identifierType: 0,
        amount: 1,
        isMinter: false,
        used: false,
        salePrice: LIST_PRICE,
      }),
    ).script;
    const listedAddress = addressFromScriptHash(listedScript, NETWORK);
    kaspa.transactions.set(LIST_TXID, {
      transaction_id: LIST_TXID,
      inputs: [],
      outputs: [
        {
          transaction_id: LIST_TXID,
          index: 0,
          amount: 10_000_000,
          script_public_key: listedScript,
          covenant_authorizing_input: null,
          covenant_id: TEST_COVENANT_ID,
        },
      ],
    });

    const listings = new ListingStoreFile();
    await listings.upsert({
      covenantId: TEST_COVENANT_ID,
      ticketId: `${LIST_TXID}:0`,
      sellerPkh: TICKET_OWNER_HEX,
      price: LIST_PRICE,
    });
    // A stale row (no such coin on chain) and a foreign seller's row must not
    // leak into this caller's walk.
    await listings.upsert({
      covenantId: TEST_COVENANT_ID,
      ticketId: `${LIST_TXID.slice(0, -2)}ff:0`,
      sellerPkh: TICKET_OWNER_HEX,
      price: LIST_PRICE,
    });
    const app = await readerApp(kaspa, makeEventStore(), listings);

    const res = await app.inject({
      method: "GET",
      url: `/v1/tickets?owner_pkh=${TICKET_OWNER_HEX}`,
    });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json()).toEqual([
      {
        ticket_id: `${B0_ID}:0`,
        covenant_id: TEST_COVENANT_ID,
        event_name: EVENT_NAME,
        event_date: EVENT_DATE,
        event_time: EVENT_TIME,
      },
      {
        ticket_id: `${LIST_TXID}:0`,
        covenant_id: TEST_COVENANT_ID,
        event_name: EVENT_NAME,
        event_date: EVENT_DATE,
        event_time: EVENT_TIME,
        listed: true,
        price: LIST_PRICE,
      },
    ]);
    await app.close();
  });
});

function txApp() {
  return buildApp(config(), {
    kaspa: new FakeKaspa(),
    events: makeEventStore(),
    network: NETWORK,
    networkId: "testnet-10",
    verified: new VerifiedEventCache(),
      listings: new ListingStoreFile(),
  });
}

class FakeKaspa implements KaspaClientLike {
  utxoMap = new Map<string, UtxoResponse[]>();
  txMap = new Map<string, TxModel[]>();
  transactions = new Map<string, TxModel>();
  feeEstimate: FeeEstimateResponse = {
    priorityBucket: { feerate: 200, estimatedSeconds: 1 },
    normalBuckets: [],
    lowBuckets: [],
  };
  mass: TxMass = { mass: 1_000, storage_mass: 0, compute_mass: 1_000 };
  broadcastResponse: SubmitTransactionResponse = { transactionId: "dd".repeat(TXID_BYTE_LENGTH) };
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
    return this.txMap.get(address) ?? [];
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
    return this.broadcastResponse;
  }
}

describe("POST /v1/events/{covenantId}/buy/prepare", () => {
  const BUYER_PKH_HEX = "03".repeat(TXID_BYTE_LENGTH);
  const BUYER_PUBKEY_HEX = `02${BUYER_PKH_HEX}`;
  const BUYER_ADDRESS = p2pkAddress(hexToBytes(BUYER_PKH_HEX), NETWORK);

  function fundBuyer(kaspa: FakeKaspa): void {
    kaspa.utxoMap.set(BUYER_ADDRESS, [
      {
        outpoint: { transactionId: "dd".repeat(TXID_BYTE_LENGTH), index: 0 },
        utxoEntry: {
          amount: String(1_000_000_000),
          scriptPublicKey: { scriptPublicKey: ORG_SPK_HEX },
          blockDaaScore: "536453032",
          isCoinbase: false,
        },
      },
    ]);
  }

  it("returns a signing template the wallet can sign", async () => {
    const kaspa = new FakeKaspa();
    seedVerifiedEvent(kaspa);
    fundBuyer(kaspa);
    const app = await buildApp(config(), {
      kaspa,
      events: makeEventStore(),
      network: NETWORK,
      networkId: "testnet-10",
      verified: new VerifiedEventCache(),
      listings: new ListingStoreFile(),
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/events/${TEST_COVENANT_ID}/buy/prepare`,
      payload: { publicKey: BUYER_PUBKEY_HEX, address: BUYER_ADDRESS },
    });
    expect(res.statusCode).toBe(HTTP_OK);
    const body = res.json();
    expect(typeof body.buy_id).toBe("string");
    expect(typeof body.signing_template).toBe("string");
    const parsed = JSON.parse(body.signing_template);
    expect(parsed.version).toBe(1);
    expect(body.sign_inputs).toEqual([{ index: 1 }]);
    expect(body.price).toBe(EVENT_PRICE);
    await app.close();
  });

  it("rejects a buy with no spendable buyer UTXOs", async () => {
    const kaspa = new FakeKaspa();
    seedVerifiedEvent(kaspa);
    const app = await buildApp(config(), {
      kaspa,
      events: makeEventStore(),
      network: NETWORK,
      networkId: "testnet-10",
      verified: new VerifiedEventCache(),
      listings: new ListingStoreFile(),
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/events/${TEST_COVENANT_ID}/buy/prepare`,
      payload: { publicKey: BUYER_PUBKEY_HEX, address: BUYER_ADDRESS },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.type).toBe("policy");
    await app.close();
  });
});

describe("POST /v1/events/{covenantId}/buy/finalize", () => {
  it("merges, broadcasts, and confirms the buy", async () => {
    const kaspa = new FakeKaspa();
    seedVerifiedEvent(kaspa);
    mockedSubmit.mockResolvedValue(B0_ID);
    // Mark the buy tx accepted so waitForTransaction returns.
    kaspa.transactions.set(B0_ID, buyTx());

    const app = await buildApp(config(), {
      kaspa,
      events: makeEventStore(),
      network: NETWORK,
      networkId: "testnet-10",
      verified: new VerifiedEventCache(),
      listings: new ListingStoreFile(),
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/events/${TEST_COVENANT_ID}/buy/finalize`,
      payload: {
        buy_id: "buy-123",
        template: {
          version: 1,
          inputs: [
            {
              previous_outpoint: { transaction_id: G_ID, index: 0 },
              signature_script: "",
              sequence: 0,
              sig_op_count: 50,
            },
          ],
          outputs: [
            {
              value: 49_000,
              script_public_key: { version: 0, script: "aa20" + "11".repeat(32) + "87" },
              covenant: { authorizing_input: 0, covenant_id: TEST_COVENANT_ID },
            },
          ],
          lock_time: 0,
        },
        signed: {
          inputs: [
            {
              transactionId: G_ID,
              index: 0,
              signatureScript: "01".repeat(SIGNATURE_SCRIPT_BYTE_LENGTH),
            },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json()).toEqual({ txid: B0_ID });
    // KTK-115: a confirmed broadcast must drop the stale upstream cache.
    expect(kaspa.clearCalls).toBe(1);
    await app.close();
  });

  it("rejects a finalize that is not a buy (no covenant output)", async () => {
    const app = await txApp();
    const res = await app.inject({
      method: "POST",
      url: `/v1/events/${TEST_COVENANT_ID}/buy/finalize`,
      payload: {
        buy_id: "buy-456",
        template: {
          version: 1,
          inputs: [],
          outputs: [
            { value: 49_000, script_public_key: { version: 0, script: "51" }, covenant: null },
          ],
          lock_time: 0,
        },
        signed: { inputs: [] },
      },
    });
    expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
    expect(res.json().error.type).toBe("invalid");
    await app.close();
  });
});

describe("POST /v1/tickets/{ticket_id}/use/prepare (door check-in, KTK-118)", () => {
  // buyTx() mints the ticket to owner = 0x02 * 32 (the ticket owner).
  const TICKET_OWNER_HEX = "02".repeat(TXID_BYTE_LENGTH);
  const OWNER_PUBKEY_HEX = `02${TICKET_OWNER_HEX}`;
  const OWNER_ADDRESS = p2pkAddress(hexToBytes(TICKET_OWNER_HEX), NETWORK);
  const TICKET_ID = `${B0_ID}:0`;

  function seedTicketTx(kaspa: FakeKaspa): void {
    const buy = buyTx();
    kaspa.transactions.set(B0_ID, buy);
  }

  function fundOwner(kaspa: FakeKaspa): void {
    kaspa.utxoMap.set(OWNER_ADDRESS, [
      {
        address: OWNER_ADDRESS,
        outpoint: { transactionId: "dd".repeat(TXID_BYTE_LENGTH), index: 0 },
        utxoEntry: {
          amount: String(1_000_000_000),
          scriptPublicKey: { scriptPublicKey: ORG_SPK_HEX },
          blockDaaScore: "536453032",
          isCoinbase: false,
        },
      },
    ]);
  }

  function useApp(kaspa: FakeKaspa) {
    return buildApp(config(), {
      kaspa,
      events: makeEventStore(),
      network: NETWORK,
      networkId: "testnet-10",
      verified: new VerifiedEventCache(),
      listings: new ListingStoreFile(),
    });
  }

  it("returns a pre-signable mark_used template for an owned ticket", async () => {
    const kaspa = new FakeKaspa();
    seedVerifiedEvent(kaspa);
    seedTicketTx(kaspa);
    fundOwner(kaspa);
    const app = await useApp(kaspa);

    const res = await app.inject({
      method: "POST",
      url: `/v1/tickets/${TICKET_ID}/use/prepare`,
      payload: { publicKey: OWNER_PUBKEY_HEX, address: OWNER_ADDRESS },
    });

    expect(res.statusCode).toBe(HTTP_OK);
    const body = res.json();
    expect(typeof body.use_id).toBe("string");
    expect(typeof body.signing_template).toBe("string");
    // The owner signs the ticket input (0) + their fee UTXOs (1..).
    expect(body.sign_inputs_owner).toEqual([{ index: 0 }, { index: 1 }]);
    // The template carries the ticket as input 0 and a used:true output.
    expect(body.template.inputs[0].previous_outpoint).toEqual({
      transaction_id: B0_ID,
      index: 0,
    });
    expect(body.event).toEqual({ name: EVENT_NAME, date: EVENT_DATE });
    await app.close();
  });

  it("rejects a ticket that is not owned by the caller (FR-28)", async () => {
    const kaspa = new FakeKaspa();
    seedVerifiedEvent(kaspa);
    seedTicketTx(kaspa);
    fundOwner(kaspa);
    const app = await useApp(kaspa);

    const otherKey = `02${"09".repeat(TXID_BYTE_LENGTH)}`;
    const otherAddress = p2pkAddress(hexToBytes("09".repeat(TXID_BYTE_LENGTH)), NETWORK);
    kaspa.utxoMap.set(otherAddress, []);

    const res = await app.inject({
      method: "POST",
      url: `/v1/tickets/${TICKET_ID}/use/prepare`,
      payload: { publicKey: otherKey, address: otherAddress },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.type).toBe("policy");
    await app.close();
  });

  it("rejects a ticket that does not exist on chain", async () => {
    const kaspa = new FakeKaspa();
    seedVerifiedEvent(kaspa);
    const app = await useApp(kaspa);

    const res = await app.inject({
      method: "POST",
      url: `/v1/tickets/${TICKET_ID}/use/prepare`,
      payload: { publicKey: OWNER_PUBKEY_HEX, address: OWNER_ADDRESS },
    });
    expect(res.statusCode).toBe(HTTP_NOT_FOUND);
    expect(res.json().error.type).toBe("invalid");
    await app.close();
  });

  it("rejects a malformed ticket_id", async () => {
    const app = await useApp(new FakeKaspa());
    const res = await app.inject({
      method: "POST",
      url: "/v1/tickets/not-a-ticket/use/prepare",
      payload: { publicKey: OWNER_PUBKEY_HEX, address: OWNER_ADDRESS },
    });
    expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
    await app.close();
  });
});

describe("POST /v1/tickets/{ticket_id}/use/sign-template (gate, KTK-128)", () => {
  // The gate scans the owner's QR payload → {use_id, template, owner_signed}.
  // sign-template re-derives the signing template from the template's outpoints
  // (Option B stateless rebuild) — it must be byte-exact to what the owner signed.
  const TICKET_OWNER_HEX = "02".repeat(TXID_BYTE_LENGTH);
  const OWNER_UTXO_TXID = "dd".repeat(TXID_BYTE_LENGTH);
  const TICKET_ID = `${B0_ID}:0`;

  // buyTx() mints the ticket to the owner at B0_ID:0; the owner's fee UTXO
  // lives at OWNER_UTXO_TXID:0. Both prev-outputs must resolve on chain.
  function seedGateChain(kaspa: FakeKaspa): void {
    seedVerifiedEvent(kaspa);
    const buy = buyTx();
    kaspa.transactions.set(B0_ID, buy);
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
  }

  function gateTemplate(): {
    version: number;
    inputs: { previous_outpoint: { transaction_id: string; index: number }; signature_script: string; sequence: number; sig_op_count: number }[];
    outputs: { value: number; script_public_key: { version: number; script: string }; covenant: { authorizing_input: number; covenant_id: string } | null }[];
    lock_time: number;
  } {
    return {
      version: 1,
      inputs: [
        {
          previous_outpoint: { transaction_id: B0_ID, index: 0 },
          signature_script: "",
          sequence: 0,
          sig_op_count: 50,
        },
        {
          previous_outpoint: { transaction_id: OWNER_UTXO_TXID, index: 0 },
          signature_script: "",
          sequence: 0,
          sig_op_count: 50,
        },
      ],
      outputs: [
        {
          value: 50_000_000,
          script_public_key: { version: 0, script: "aa20" + "33".repeat(TXID_BYTE_LENGTH) + "87" },
          covenant: { authorizing_input: 0, covenant_id: TEST_COVENANT_ID },
        },
        {
          value: 999_900_000,
          script_public_key: { version: 0, script: `20${TICKET_OWNER_HEX}ac` },
          covenant: null,
        },
      ],
      lock_time: 0,
    };
  }

  function gateApp(kaspa: FakeKaspa) {
    return buildApp(config(), {
      kaspa,
      events: makeEventStore(),
      network: NETWORK,
      networkId: "testnet-10",
      verified: new VerifiedEventCache(),
      listings: new ListingStoreFile(),
    });
  }

  it("rebuilds a byte-exact signing template from prev-output chain facts", async () => {
    const kaspa = new FakeKaspa();
    seedGateChain(kaspa);
    const app = await gateApp(kaspa);

    const res = await app.inject({
      method: "POST",
      url: `/v1/tickets/${TICKET_ID}/use/sign-template`,
      payload: { template: gateTemplate() },
    });

    expect(res.statusCode).toBe(HTTP_OK);
    const body = res.json();
    expect(typeof body.signing_template).toBe("string");
    const parsed = JSON.parse(body.signing_template);
    expect(parsed.version).toBe(1);
    expect(parsed.inputs).toHaveLength(2);
    // The continuation output keeps the event family covenant id so the wasm
    // signs the same genesis group the owner signed.
    expect(parsed.outputs[0].covenant.covenantId).toBe(TEST_COVENANT_ID);
    await app.close();
  });

  it("rejects a template whose prev output is not on chain", async () => {
    const kaspa = new FakeKaspa();
    seedVerifiedEvent(kaspa);
    const app = await gateApp(kaspa);

    const res = await app.inject({
      method: "POST",
      url: `/v1/tickets/${TICKET_ID}/use/sign-template`,
      payload: { template: gateTemplate() },
    });
    expect(res.statusCode).toBe(HTTP_NOT_FOUND);
    await app.close();
  });

  it("rejects a malformed ticket_id", async () => {
    const app = await gateApp(new FakeKaspa());
    const res = await app.inject({
      method: "POST",
      url: "/v1/tickets/not-a-ticket/use/sign-template",
      payload: { template: gateTemplate() },
    });
    expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
    await app.close();
  });
});

describe("POST /v1/tickets/{ticket_id}/use/finalize (gate, KTK-129)", () => {
  const TICKET_OWNER_HEX = "02".repeat(TXID_BYTE_LENGTH);
  const OWNER_UTXO_TXID = "dd".repeat(TXID_BYTE_LENGTH);
  const TICKET_ID = `${B0_ID}:0`;
  const USED_TXID = "ee".repeat(TXID_BYTE_LENGTH);

  function seedGateChain(kaspa: FakeKaspa): void {
    seedVerifiedEvent(kaspa);
    const buy = buyTx();
    kaspa.transactions.set(B0_ID, buy);
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
  }

  function gateTemplate() {
    return {
      version: 1,
      inputs: [
        {
          previous_outpoint: { transaction_id: B0_ID, index: 0 },
          signature_script: "",
          sequence: 0,
          sig_op_count: 50,
        },
        {
          previous_outpoint: { transaction_id: OWNER_UTXO_TXID, index: 0 },
          signature_script: "",
          sequence: 0,
          sig_op_count: 50,
        },
      ],
      outputs: [
        {
          value: 50_000_000,
          script_public_key: { version: 0, script: "aa20" + "33".repeat(TXID_BYTE_LENGTH) + "87" },
          covenant: { authorizing_input: 0, covenant_id: TEST_COVENANT_ID },
        },
        {
          value: 999_900_000,
          script_public_key: { version: 0, script: `20${TICKET_OWNER_HEX}ac` },
          covenant: null,
        },
      ],
      lock_time: 0,
    };
  }

  function gateApp(kaspa: FakeKaspa) {
    return buildApp(config(), {
      kaspa,
      events: makeEventStore(),
      network: NETWORK,
      networkId: "testnet-10",
      verified: new VerifiedEventCache(),
      listings: new ListingStoreFile(),
    });
  }

  it("merges owner+gate signatures, assembles the mark_used sig-script, broadcasts, and confirms", async () => {
    const kaspa = new FakeKaspa();
    seedGateChain(kaspa);
    mockedSubmit.mockResolvedValue(USED_TXID);
    kaspa.transactions.set(USED_TXID, {
      transaction_id: USED_TXID,
      inputs: [],
      outputs: [],
    });
    const app = await gateApp(kaspa);

    const ownerSig = `41${"aa".repeat(65)}`;
    const gateSig = `41${"bb".repeat(65)}`;
    const res = await app.inject({
      method: "POST",
      url: `/v1/tickets/${TICKET_ID}/use/finalize`,
      payload: {
        use_id: "use-123",
        template: gateTemplate(),
        owner_signed: {
          inputs: [
            { transactionId: B0_ID, index: 0, signatureScript: ownerSig },
            { transactionId: OWNER_UTXO_TXID, index: 0, signatureScript: `41${"cc".repeat(65)}` },
          ],
        },
        gate_signed: {
          inputs: [{ transactionId: B0_ID, index: 0, signatureScript: gateSig }],
        },
      },
    });

    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json()).toEqual({ txid: USED_TXID });
    expect(kaspa.clearCalls).toBe(1);
    await app.close();
  });

  it("rejects finalize when the gate did not sign the ticket input", async () => {
    const kaspa = new FakeKaspa();
    seedGateChain(kaspa);
    const app = await gateApp(kaspa);

    const res = await app.inject({
      method: "POST",
      url: `/v1/tickets/${TICKET_ID}/use/finalize`,
      payload: {
        use_id: "use-456",
        template: gateTemplate(),
        owner_signed: {
          inputs: [
            { transactionId: B0_ID, index: 0, signatureScript: `41${"aa".repeat(65)}` },
            { transactionId: OWNER_UTXO_TXID, index: 0, signatureScript: `41${"cc".repeat(65)}` },
          ],
        },
        gate_signed: { inputs: [] },
      },
    });
    expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
    expect(res.json().error.type).toBe("invalid");
    await app.close();
  });

  it("rejects finalize for a template that is not a covenant spend", async () => {
    const kaspa = new FakeKaspa();
    seedGateChain(kaspa);
    const app = await gateApp(kaspa);

    const noCovenant = gateTemplate();
    noCovenant.outputs = [
      { value: 100, script_public_key: { version: 0, script: "51" }, covenant: null },
    ];
    const res = await app.inject({
      method: "POST",
      url: `/v1/tickets/${TICKET_ID}/use/finalize`,
      payload: {
        use_id: "use-789",
        template: noCovenant,
        owner_signed: {
          inputs: [
            { transactionId: B0_ID, index: 0, signatureScript: `41${"aa".repeat(65)}` },
            { transactionId: OWNER_UTXO_TXID, index: 0, signatureScript: `41${"cc".repeat(65)}` },
          ],
        },
        gate_signed: {
          inputs: [{ transactionId: B0_ID, index: 0, signatureScript: `41${"bb".repeat(65)}` }],
        },
      },
    });
    expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
    expect(res.json().error.type).toBe("invalid");
    await app.close();
  });

  it("rejects finalize when the template input 0 is not the requested ticket", async () => {
    const kaspa = new FakeKaspa();
    seedGateChain(kaspa);
    const app = await gateApp(kaspa);

    const otherTemplate = gateTemplate();
    otherTemplate.inputs[0]!.previous_outpoint = {
      transaction_id: "ff".repeat(TXID_BYTE_LENGTH),
      index: 0,
    };
    const res = await app.inject({
      method: "POST",
      url: `/v1/tickets/${TICKET_ID}/use/finalize`,
      payload: {
        use_id: "use-abc",
        template: otherTemplate,
        owner_signed: { inputs: [] },
        gate_signed: { inputs: [] },
      },
    });
    expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
    expect(res.json().error.type).toBe("invalid");
    await app.close();
  });
});

describe("reader routes — POST /v1/events", () => {
  it("registers an event after deploy and returns covenant_id", async () => {
    const kaspa = new FakeKaspa();
    seedVerifiedEvent(kaspa);
    const events = new EventStore();
    const app = await buildApp(config(), {
      kaspa,
      events,
      network: NETWORK,
      networkId: "testnet-10",
      verified: new VerifiedEventCache(),
      listings: new ListingStoreFile(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: { deploy_txid: G_ID },
    });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json()).toEqual({ covenant_id: TEST_COVENANT_ID });
    await app.close();
  });

  it("rejects POST /v1/events when the deploy tx is not on chain", async () => {
    const events = new EventStore();
    const app = await buildApp(config(), {
      kaspa: new FakeKaspa(),
      events,
      network: NETWORK,
      networkId: "testnet-10",
      verified: new VerifiedEventCache(),
      listings: new ListingStoreFile(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: { deploy_txid: G_ID },
    });
    expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
    expect(res.json().error.type).toBe("invalid");
    await app.close();
  });

  it("rejects POST /v1/events when the deploy is not a verifiable event", async () => {
    const kaspa = new FakeKaspa();
    kaspa.transactions.set(AUTH_TXID, fundingTx());
    kaspa.transactions.set(G_ID, deployTxWithCapacity(EVENT_CAPACITY));
    // Tamper: the covenant output no longer matches the artifact constants.
    const tampered = kaspa.transactions.get(G_ID);
    if (tampered && tampered.outputs?.[0]) {
      tampered.outputs[0] = {
        ...tampered.outputs[0],
        script_public_key: "51",
      };
    }
    const events = new EventStore();
    const app = await buildApp(config(), {
      kaspa,
      events,
      network: NETWORK,
      networkId: "testnet-10",
      verified: new VerifiedEventCache(),
      listings: new ListingStoreFile(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: { deploy_txid: G_ID },
    });
    expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
    expect(res.json().error.type).toBe("invalid");
    await app.close();
  });
});

describe("POST /v1/events/deploy/prepare", () => {
  const ORG_PUBKEY_HEX = `02${ORG_PKH_HEX}`;
  const ORG_ADDRESS = p2pkAddress(hexToBytes(ORG_PKH_HEX), NETWORK);

  function fundOrganizer(kaspa: FakeKaspa): void {
    kaspa.utxoMap.set(ORG_ADDRESS, [
      {
        outpoint: { transactionId: "cc".repeat(TXID_BYTE_LENGTH), index: 0 },
        utxoEntry: {
          amount: String(1_000_000_000),
          scriptPublicKey: { scriptPublicKey: ORG_SPK_HEX },
          blockDaaScore: "536453032",
          isCoinbase: false,
        },
      },
    ]);
  }

  it("returns a signing template the wallet can sign", async () => {
    const kaspa = new FakeKaspa();
    fundOrganizer(kaspa);
    const app = await buildApp(config(), {
      kaspa,
      events: makeEventStore(),
      network: NETWORK,
      networkId: "testnet-10",
      verified: new VerifiedEventCache(),
      listings: new ListingStoreFile(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/events/deploy/prepare",
      payload: {
        capacity: EVENT_CAPACITY,
        price_kas: EVENT_PRICE / 100_000_000,
        publicKey: ORG_PUBKEY_HEX,
        address: ORG_ADDRESS,
        name: EVENT_NAME,
        date: EVENT_DATE,
        time: EVENT_TIME,
      },
    });
    expect(res.statusCode).toBe(HTTP_OK);
    const body = res.json();
    expect(typeof body.deploy_id).toBe("string");
    expect(typeof body.signing_template).toBe("string");
    const parsed = JSON.parse(body.signing_template);
    expect(parsed.version).toBe(1);
    expect(parsed.inputs).toHaveLength(1);
    expect(parsed.inputs[0].utxo.scriptPublicKey).toContain("ac");
    expect(body.event_covenant_id).toMatch(/^[0-9a-f]{64}$/);
    await app.close();
  });

  it("carries the KCC-0021 keys into the deploy template payload", async () => {
    const kaspa = new FakeKaspa();
    fundOrganizer(kaspa);
    const app = await buildApp(config(), {
      kaspa,
      events: makeEventStore(),
      network: NETWORK,
      networkId: "testnet-10",
      verified: new VerifiedEventCache(),
      listings: new ListingStoreFile(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/events/deploy/prepare",
      payload: {
        capacity: EVENT_CAPACITY,
        price_kas: EVENT_PRICE / 100_000_000,
        publicKey: ORG_PUBKEY_HEX,
        address: ORG_ADDRESS,
        name: EVENT_NAME,
        date: EVENT_DATE,
        time: EVENT_TIME,
        ticker: "RAVE",
        decimals: 0,
        image: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
        image_hash: "3b8c4e0f2a1d6b9c7e5f4a2d8b0c1e3f6a9d2c5b8e1f4a7d0c3b6e9f2a5d8c1b",
      },
    });
    expect(res.statusCode).toBe(HTTP_OK);
    const payloadJson = res.json().template?.payload;
    expect(typeof payloadJson).toBe("string");
    const parsed = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(Buffer.from(payloadJson, "hex"))),
    );
    expect(parsed).toMatchObject({
      name: EVENT_NAME,
      ticker: "RAVE",
      decimals: 0,
      image: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
      image_hash: "3b8c4e0f2a1d6b9c7e5f4a2d8b0c1e3f6a9d2c5b8e1f4a7d0c3b6e9f2a5d8c1b",
    });
    await app.close();
  });

  it("rejects out-of-range decimals on the deploy prepare body", async () => {
    const app = await txApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/events/deploy/prepare",
      payload: {
        capacity: EVENT_CAPACITY,
        price_kas: EVENT_PRICE / 100_000_000,
        publicKey: ORG_PUBKEY_HEX,
        address: ORG_ADDRESS,
        name: EVENT_NAME,
        date: EVENT_DATE,
        decimals: 300,
      },
    });
    expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
    expect(res.json().error.type).toBe("invalid");
    await app.close();
  });

  it("rejects a deploy with no spendable UTXOs on the organizer address", async () => {
    const app = await txApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/events/deploy/prepare",
      payload: {
        capacity: EVENT_CAPACITY,
        price_kas: EVENT_PRICE / 100_000_000,
        publicKey: ORG_PUBKEY_HEX,
        address: ORG_ADDRESS,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.type).toBe("policy");
    await app.close();
  });
});

describe("POST /v1/events/deploy/finalize", () => {
  it("broadcasts, confirms, and registers the event identifiers", async () => {
    const kaspa = new FakeKaspa();
    seedVerifiedEvent(kaspa);
    mockedSubmit.mockResolvedValue(G_ID);

    const events = new EventStore();
    const app = await buildApp(config(), {
      kaspa,
      events,
      network: NETWORK,
      networkId: "testnet-10",
      verified: new VerifiedEventCache(),
      listings: new ListingStoreFile(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/events/deploy/finalize",
      payload: {
        deploy_id: "deploy-123",
        template: {
          version: 1,
          inputs: [
            {
              previous_outpoint: { transaction_id: G_ID, index: 0 },
              signature_script: "",
              sequence: 0,
              sig_op_count: 50,
            },
          ],
          outputs: [
            {
              value: 49_000,
              script_public_key: { version: 0, script: "aa20" + "11".repeat(32) + "87" },
              covenant: { authorizing_input: 0, covenant_id: TEST_COVENANT_ID },
            },
          ],
          lock_time: 0,
        },
        signed: {
          inputs: [
            {
              transactionId: G_ID,
              index: 0,
              signatureScript: "01".repeat(SIGNATURE_SCRIPT_BYTE_LENGTH),
            },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(HTTP_OK);
    const body = res.json();
    expect(body).toEqual({ covenant_id: TEST_COVENANT_ID, deploy_txid: G_ID });
    expect(events.list()).toEqual([
      {
        covenantId: TEST_COVENANT_ID,
        deployTxId: G_ID,
        organizerAddress: p2pkAddress(hexToBytes(ORG_PKH_HEX), NETWORK),
      },
    ]);
    await app.close();
  });

  it("rejects a template that is not a deploy (no covenant output)", async () => {
    const app = await txApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/events/deploy/finalize",
      payload: {
        deploy_id: "deploy-456",
        template: {
          version: 1,
          inputs: [],
          outputs: [
            { value: 49_000, script_public_key: { version: 0, script: "51" }, covenant: null },
          ],
          lock_time: 0,
        },
        signed: { inputs: [] },
      },
    });
    expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
    expect(res.json().error.type).toBe("invalid");
    await app.close();
  });
});
