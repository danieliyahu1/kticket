import {
  addressFromScriptHash,
  buildBuy,
  buildDeploy,
  DUST,
  type UnsignedTransaction,
} from "@kticket/kit";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app";
import { compileBurnArtifact, compileEventArtifact, eventScript } from "./compiler";
import { loadConfig } from "./config";
import { EventStore, type StoredEventInternal } from "./eventstore";
import { HTTP_BAD_REQUEST, HTTP_NOT_FOUND, HTTP_OK } from "./http-status.js";

vi.mock("./wrpc-client.js", () => ({
  submitTransactionOverWrpc: vi.fn(),
}));

import { submitTransactionOverWrpc } from "./wrpc-client.js";

const mockedSubmit = vi.mocked(submitTransactionOverWrpc);

import { covenantId } from "@kticket/kit";
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
const ORG_SPK_HEX = "21020001";
const BURN_TEMPLATE_HASH = bytesToHex(
  Uint8Array.from(compileBurnArtifact(AUTH_TXID_HEX).template_hash),
);

function eventArtifact() {
  return compileEventArtifact({
    authorizingTxId: AUTH_TXID_HEX,
    price: 1_000,
    orgSpk: ORG_SPK_HEX,
    burnTemplateHash: BURN_TEMPLATE_HASH,
  });
}

function makeStoredEvent(overrides: Partial<StoredEventInternal> = {}): StoredEventInternal {
  return {
    covenantId: computeTestCovenantId(),
    genesisTxId: G_ID,
    orgPkh: ORG_PKH_HEX,
    orgSpk: ORG_SPK_HEX,
    burnTemplateHash: BURN_TEMPLATE_HASH,
    name: "Testnet Rave",
    date: "2026-12-31",
    price: 1_000,
    capacity: 2,
    authorizingTxId: AUTH_TXID_HEX,
    ...overrides,
  };
}

function computeTestCovenantId(): string {
  const artifact = eventArtifact();
  const script = eventScript(artifact, { owner: ORG_PKH_HEX, amount: 2 });
  return bytesToHex(
    covenantId(
      { txId: hexToBytes(AUTH_TXID_HEX), index: 0 },
      [{ index: 0, value: DUST, version: 0, script: hexToBytes(script.script) }],
    ),
  );
}

const TEST_COVENANT_ID = computeTestCovenantId();

const EVENT = makeStoredEvent();

function deployTxWithCapacity(capacity: number): TxModel {
  const { tx } = buildDeploy({
    authorizingOutpoint: {
      txId: Uint8Array.from(Buffer.from(AUTH_TXID_HEX, "hex")),
      index: 0,
    },
    organizerUtxos: [],
    organizerUtxoValues: [UTXO_VALUE],
    organizer: Uint8Array.from(Buffer.from(EVENT.orgPkh, "hex")),
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
    })),
  };
}

function deployTx(): TxModel {
  return deployTxWithCapacity(EVENT.capacity);
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
    })),
  };
}

function buyTx(): TxModel {
  const tx = buildBuy({
    eventOutpoint: { txId: Uint8Array.from(Buffer.from(G_ID, "hex")), index: 0 },
    eventCovenantId: TEST_COVENANT_ID,
    eventOwner: Uint8Array.from(Buffer.from(EVENT.orgPkh, "hex")),
    eventArtifact: eventArtifact(),
    buyer: new Uint8Array(TXID_BYTE_LENGTH).fill(BUYER_BYTE),
    buyerUtxos: [{ txId: new Uint8Array(TXID_BYTE_LENGTH).fill(BUYER_UTXO_BYTE), index: 0 }],
    buyerUtxoValues: [UTXO_VALUE],
    orgScript: { version: 0, script: EVENT.orgSpk },
    changeScript: { version: 0, script: "51" },
    remaining: EVENT.capacity,
    price: EVENT.price,
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
  store.register(EVENT);
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

describe("reader routes (KTK-5)", () => {
  it("GET /v1/events lists the registered directory", async () => {
    const app = await readerApp(new FakeKaspa());
    const res = await app.inject({ method: "GET", url: "/v1/events" });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json()).toEqual([
      {
        covenant_id: EVENT.covenantId,
        genesis_txid: EVENT.genesisTxId,
        name: EVENT.name,
        date: EVENT.date,
        price: EVENT.price,
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

describe("reader routes (KTK-5) — event availability", () => {
  it("GET /v1/events/{id} returns event + availability", async () => {
    const kaspa = new FakeKaspa();
    const genesis = deployTx();
    kaspa.transactions.set(G_ID, genesis);
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
    const res = await app.inject({ method: "GET", url: `/v1/events/${EVENT.covenantId}` });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json()).toMatchObject({
      event: {
        covenant_id: EVENT.covenantId,
        name: EVENT.name,
        date: EVENT.date,
        price: EVENT.price,
      },
      availability: { capacity: 2, sold: 1, left: 1 },
      buy_info: {
        event_owner: EVENT.orgPkh,
        org_spk: EVENT.orgSpk,
        burn_template_hash: EVENT.burnTemplateHash,
        remaining: 1,
      },
    });
    await app.close();
  });
});

describe("reader routes (KTK-5) — event validation", () => {
  it("GET /v1/events/{id} treats a missing deploy tx as invalid (400)", async () => {
    const app = await readerApp(new FakeKaspa());
    const res = await app.inject({ method: "GET", url: `/v1/events/${EVENT.covenantId}` });
    expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
    expect(res.json().error.type).toBe("invalid");
    expect(res.json().error.retryable).toBe(false);
    await app.close();
  });
});

describe("reader routes (KTK-5) — tickets", () => {
  it("GET /v1/tickets/{id} returns alive for an unspent ticket", async () => {
    const kaspa = new FakeKaspa();
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

    const events = new EventStore(`test-events-${Date.now()}-tickets.json`);
    events.register(makeStoredEvent({ genesisTxId: B0_ID }));
    const app = await readerApp(kaspa, events);
    const res = await app.inject({ method: "GET", url: `/v1/tickets/${B0_ID}:0` });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json().state).toBe("alive");
    expect(res.json().event.authorizing_txid).toBe(EVENT.authorizingTxId);
    expect(res.json().price).toBe(EVENT.price);
    await app.close();
  });
});

describe("reader routes (KTK-5) — unknown tickets", () => {
  it("GET /v1/tickets/{id} returns unknown with a cause (never guessed)", async () => {
    const kaspa = new FakeKaspa();
    kaspa.transactions.set(G_ID, deployTx());
    const app = await readerApp(kaspa);
    const res = await app.inject({ method: "GET", url: `/v1/tickets/${G_ID}:0` });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json()).toEqual({
      state: "unknown",
      cause: "unresolved-spend",
      event: { authorizing_txid: EVENT.authorizingTxId, name: EVENT.name, date: EVENT.date },
      price: 1_000,
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
    price: 1_000,
    org_spk: "21020001",
    burn_template_hash: "77".repeat(TXID_BYTE_LENGTH),
  },
  organizer: "01".repeat(TXID_BYTE_LENGTH),
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
    const genesis = deployTx();
    kaspa.transactions.set(G_ID, genesis);
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
      payload: {
        genesis_txid: G_ID,
        org_pkh: EVENT.orgPkh,
        name: EVENT.name,
        date: EVENT.date,
        price: EVENT.price,
        capacity: EVENT.capacity,
        org_spk: EVENT.orgSpk,
        burn_template_hash: EVENT.burnTemplateHash,
        authorizing_txid: AUTH_TXID,
      },
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
      payload: {
        genesis_txid: G_ID,
        org_pkh: EVENT.orgPkh,
        name: EVENT.name,
        date: EVENT.date,
        price: EVENT.price,
        capacity: EVENT.capacity,
        org_spk: EVENT.orgSpk,
        burn_template_hash: EVENT.burnTemplateHash,
        authorizing_txid: AUTH_TXID,
      },
    });
    expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
    expect(res.json().error.type).toBe("invalid");
    await app.close();
  });
});
