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

function deployScript(): string {
  return deployTx().outputs?.[0]?.script_public_key as string;
}

function buyTxModelFrom(tx: UnsignedTransaction): TxModel {
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
  const store = new EventStore(`test-events-${Date.now()}.json`);
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
  it("GET /v1/events lists identifiers from the registry (details fetched on demand)", async () => {
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
      },
    ]);
    await app.close();
  });

  it("GET /v1/events returns the registry identifiers even before the tx is verifiable", async () => {
    const app = await readerApp(new FakeKaspa());
    const res = await app.inject({ method: "GET", url: "/v1/events" });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json()).toEqual([
      {
        covenant_id: TEST_COVENANT_ID,
        deploy_txid: G_ID,
        organizer_address: p2pkAddress(hexToBytes(ORG_PKH_HEX), NETWORK),
      },
    ]);
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

describe("reader routes (KTK-89) — event availability", () => {
  it("GET /v1/events/{id} returns verified event + availability", async () => {
    const kaspa = new FakeKaspa();
    seedVerifiedEvent(kaspa);
    const buy = buyTx();
    const deployAddress = addressFromScriptHash(deployScript(), NETWORK);
    kaspa.txMap.set(deployAddress, [buy]);
    const remainingAddress = addressFromScriptHash(
      buy.outputs?.[1]?.script_public_key as string,
      NETWORK,
    );
    kaspa.utxoMap.set(remainingAddress, [
      {
        address: remainingAddress,
        outpoint: { transactionId: G_ID, index: 0 },
        utxoEntry: {
          amount: "0",
          scriptPublicKey: { scriptPublicKey: "" },
          blockDaaScore: "0",
          isCoinbase: false,
        },
      },
    ]);

    const app = await readerApp(kaspa);
    const res = await app.inject({ method: "GET", url: `/v1/events/${TEST_COVENANT_ID}` });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json()).toMatchObject({
      event: {
        covenant_id: TEST_COVENANT_ID,
        deploy_txid: G_ID,
        name: EVENT_NAME,
        date: EVENT_DATE,
        price: EVENT_PRICE,
        capacity: EVENT_CAPACITY,
        verified: true,
      },
      availability: { capacity: 2, sold: 1, left: 1 },
      buy_info: {
        event_owner: ORG_PKH_HEX,
        org_spk: ORG_SPK_HEX,
        burn_template_hash: BURN_TEMPLATE_HASH,
        remaining: 1,
      },
      raw_chain: {
        deploy_txid: G_ID,
        authorizing_txid: AUTH_TXID,
        maker_address: p2pkAddress(hexToBytes(ORG_PKH_HEX), NETWORK),
        decoded_state: { owner: ORG_PKH_HEX, capacity: 2 },
      },
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

describe("reader routes (KTK-89) — tickets", () => {
  it("GET /v1/tickets/{id} returns alive for an unspent ticket", async () => {
    const kaspa = new FakeKaspa();
    seedVerifiedEvent(kaspa);
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

    const app = await readerApp(kaspa);
    const res = await app.inject({ method: "GET", url: `/v1/tickets/${B0_ID}:0` });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json().state).toBe("alive");
    expect(res.json().event.authorizing_txid).toBe(AUTH_TXID);
    expect(res.json().price).toBe(EVENT_PRICE);
    await app.close();
  });
});

describe("reader routes (KTK-89) — unknown tickets", () => {
  it("GET /v1/tickets/{id} returns unknown with a cause (never guessed)", async () => {
    const kaspa = new FakeKaspa();
    seedVerifiedEvent(kaspa);
    const app = await readerApp(kaspa);
    const res = await app.inject({ method: "GET", url: `/v1/tickets/${G_ID}:0` });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json()).toEqual({
      state: "unknown",
      cause: "unresolved-spend",
      event: { authorizing_txid: AUTH_TXID, name: EVENT_NAME, date: EVENT_DATE },
      price: EVENT_PRICE,
    });
    await app.close();
  });

  it("GET /v1/tickets/{id} rejects a malformed ticket id", async () => {
    const app = await readerApp(new FakeKaspa());
    const res = await app.inject({ method: "GET", url: "/v1/tickets/not-a-ticket" });
    expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
    expect(res.json().error.type).toBe("invalid");
    await app.close();
  });

  it("GET /v1/tickets/{id} rejects a missing genesis tx", async () => {
    const app = await readerApp(new FakeKaspa());
    const res = await app.inject({ method: "GET", url: `/v1/tickets/${B0_ID}:0` });
    expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
    expect(res.json().error.type).toBe("invalid");
    await app.close();
  });
});

const deployBody = {
  type: "deploy",
  capacity: 2,
  constants: {
    authorizing_txid: AUTH_TXID,
    price: EVENT_PRICE,
    org_spk: ORG_SPK_HEX,
    burn_template_hash: BURN_TEMPLATE_HASH,
  },
  organizer: ORG_PKH_HEX,
  authorizing_outpoint: {
    transaction_id: "cc".repeat(TXID_BYTE_LENGTH),
    index: 0,
    value: 1_000_000_000,
  },
  organizer_utxos: [],
  change_spk: { version: 0, script: "51" },
};

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

describe("tx routes (KTK-6) — build", () => {
  beforeEach(() => {
    mockedSubmit.mockReset();
  });

  it("POST /v1/tx/build returns a fee-aware deploy template", async () => {
    const app = await txApp();
    const res = await app.inject({ method: "POST", url: "/v1/tx/build", payload: deployBody });
    expect(res.statusCode).toBe(HTTP_OK);
    const body = res.json();
    expect(body.template.version).toBe(1);
    expect(body.template.outputs).toHaveLength(2);
    const inputTotal = 1_000_000_000;
    const outputTotal = body.template.outputs.reduce(
      (acc: number, o: { value: number }) => acc + o.value,
      0,
    );
    expect(inputTotal - outputTotal).toBeGreaterThan(0);
    expect(body.event_covenant_id).toMatch(/^[0-9a-f]{64}$/);
    await app.close();
  });

  it("POST /v1/tx/build returns a signing_template (safe-JSON) when UTXO metadata is supplied", async () => {
    await expectSigningTemplate();
  });

  it("POST /v1/tx/build rejects an unknown type as invalid", async () => {
    const app = await txApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/tx/build",
      payload: { type: "nope" },
    });
    expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
    expect(res.json().error.type).toBe("invalid");
    await app.close();
  });
});

async function expectSigningTemplate(): Promise<void> {
  const app = await txApp();
  const body = {
    ...deployBody,
    input_utxo_metas: [
      {
        transaction_id: "cc".repeat(TXID_BYTE_LENGTH),
        index: 0,
        value: 1_000_000_000,
        script_public_key: { version: 0, script: `2071${"11".repeat(TXID_BYTE_LENGTH)}ac` },
        block_daa_score: 536_453_032,
        is_coinbase: false,
      },
    ],
  };
  const res = await app.inject({ method: "POST", url: "/v1/tx/build", payload: body });
  expect(res.statusCode).toBe(HTTP_OK);
  const result = res.json();
  expect(typeof result.signing_template).toBe("string");
  const parsed = JSON.parse(result.signing_template);
  expect(parsed.version).toBe(1);
  expect(parsed.inputs).toHaveLength(1);
  expect(parsed.inputs[0].utxo.scriptPublicKey).toContain("ac");
  await app.close();
}

describe("tx routes (KTK-6) — broadcast", () => {
  beforeEach(() => {
    mockedSubmit.mockReset();
  });

  it("POST /v1/tx/broadcast relays a signed tx and returns the txid", async () => {
    mockedSubmit.mockResolvedValue("dd".repeat(TXID_BYTE_LENGTH));
    const app = await txApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/tx/broadcast",
      payload: {
        transaction: {
          version: 1,
          inputs: [
            {
              previous_outpoint: { transaction_id: "aa".repeat(TXID_BYTE_LENGTH), index: 0 },
              signature_script: "01".repeat(SIGNATURE_SCRIPT_BYTE_LENGTH),
              sequence: 0,
              sig_op_count: 1,
            },
          ],
          outputs: [
            { value: 49_000, script_public_key: { version: 0, script: "51" }, covenant: null },
          ],
          lock_time: 0,
        },
      },
    });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json()).toEqual({ txid: "dd".repeat(TXID_BYTE_LENGTH) });
    await app.close();
  });
});

describe("tx routes (KTK-6) — broadcast validation", () => {
  beforeEach(() => {
    mockedSubmit.mockReset();
  });

  it("POST /v1/tx/broadcast rejects a malformed tx as invalid", async () => {
    const app = await txApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/tx/broadcast",
      payload: { transaction: { version: 0 } },
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
    const events = new EventStore(`test-events-${Date.now()}-post.json`);
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
    const events = new EventStore(`test-events-${Date.now()}-missing.json`);
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
    const events = new EventStore(`test-events-${Date.now()}-tampered.json`);
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

describe("POST /v1/events/deploy — prepare", () => {
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
      url: "/v1/events/deploy",
      payload: {
        phase: "prepare",
        capacity: EVENT_CAPACITY,
        price: EVENT_PRICE,
        publicKey: ORG_PUBKEY_HEX,
        address: ORG_ADDRESS,
        name: EVENT_NAME,
        date: EVENT_DATE,
      },
    });
    expect(res.statusCode).toBe(HTTP_OK);
    const body = res.json();
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
      url: "/v1/events/deploy",
      payload: {
        phase: "prepare",
        capacity: EVENT_CAPACITY,
        price: EVENT_PRICE,
        publicKey: ORG_PUBKEY_HEX,
        address: ORG_ADDRESS,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.type).toBe("policy");
    await app.close();
  });

  it("rejects an invalid phase", async () => {
    const app = await txApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/events/deploy",
      payload: { phase: "nope" },
    });
    expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
    expect(res.json().error.type).toBe("invalid");
    await app.close();
  });
});

describe("POST /v1/events/deploy — finalize", () => {
  it("broadcasts, confirms, and registers the event identifiers", async () => {
    const kaspa = new FakeKaspa();
    seedVerifiedEvent(kaspa);
    mockedSubmit.mockResolvedValue(G_ID);

    const events = new EventStore(`test-events-${Date.now()}-deploy.json`);
    const app = await buildApp(config(), {
      kaspa,
      events,
      network: NETWORK,
      networkId: "testnet-10",
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/events/deploy",
      payload: {
        phase: "finalize",
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
      url: "/v1/events/deploy",
      payload: {
        phase: "finalize",
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
