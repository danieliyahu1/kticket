import {
  addressFromScriptHash,
  buildBuy,
  buildDeploy,
  p2pkAddress,
  type UnsignedTransaction,
} from "@kticket/kit";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app";
import { compileBurnArtifact, compileEventArtifact } from "./compiler";
import { loadConfig } from "./config";
import { EventStore, type StoredEvent } from "./eventstore";
import { HTTP_BAD_REQUEST, HTTP_NOT_FOUND, HTTP_OK } from "./http-status.js";

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

function deployTxWithCapacity(capacity: number): TxModel {
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
  store.register(makeStoredEvent());
  return store;
}

function readerApp(kaspa: KaspaClientLike, events: EventStore = makeEventStore()) {
  return buildApp(config(), {
    kaspa,
    events,
    network: NETWORK,
    networkId: "testnet-10",
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
});

function txApp() {
  return buildApp(config(), {
    kaspa: new FakeKaspa(),
    events: makeEventStore(),
    network: NETWORK,
    networkId: "testnet-10",
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
