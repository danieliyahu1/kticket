import {
  addressFromScriptHash,
  buildBuy,
  buildDeploy,
  type DecodedConstants,
  EVENT_ARTIFACT,
  type UnsignedTransaction,
} from "@kticket/kit";
import { hexToBytes } from "@noble/hashes/utils.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { HTTP_BAD_REQUEST, HTTP_OK } from "./http-status.js";

vi.mock("./wrpc-client.js", () => ({
  submitTransactionOverWrpc: vi.fn(),
}));

import { submitTransactionOverWrpc } from "./wrpc-client.js";

const mockedSubmit = vi.mocked(submitTransactionOverWrpc);

import type { RegisteredEvent } from "./events";
import { EventRegistry } from "./events";
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

const EVENT: RegisteredEvent = {
  eventId: "ab".repeat(TXID_BYTE_LENGTH),
  genesisTxId: G_ID,
  orgPkh: "01".repeat(TXID_BYTE_LENGTH),
  orgSpk: "21020001",
  burnTemplateHash: "77".repeat(TXID_BYTE_LENGTH),
  name: "Testnet Rave",
  date: "2026-12-31",
  price: 1_000,
  capacity: 2,
};

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

function config() {
  return loadConfig({
    KASPANET: NETWORK,
    KTICKET_EVENTS: JSON.stringify([
      {
        event_id: EVENT.eventId,
        genesis_txid: EVENT.genesisTxId,
        org_pkh: EVENT.orgPkh,
        org_spk: EVENT.orgSpk,
        burn_template_hash: EVENT.burnTemplateHash,
        name: EVENT.name,
        date: EVENT.date,
        price: EVENT.price,
        capacity: EVENT.capacity,
      },
    ]),
  });
}

function decodedConstants(): DecodedConstants {
  return {
    eventId: Uint8Array.from(Buffer.from(EVENT.eventId, "hex")),
    price: EVENT.price,
    orgSpk: Uint8Array.from(Buffer.from(EVENT.orgSpk, "hex")),
    burnTemplateHash: Uint8Array.from(Buffer.from(EVENT.burnTemplateHash, "hex")),
  };
}

function deployTxWithCapacity(capacity: number): TxModel {
  const { tx } = buildDeploy({
    authorizingOutpoint: {
      txId: Uint8Array.from(Buffer.from("11".repeat(TXID_BYTE_LENGTH), "hex")),
      index: 0,
    },
    organizerUtxos: [],
    organizerUtxoValues: [UTXO_VALUE],
    organizer: Uint8Array.from(Buffer.from(EVENT.orgPkh, "hex")),
    capacity,
    constants: decodedConstants(),
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
    eventCovenantId: "77".repeat(TXID_BYTE_LENGTH),
    eventOwner: Uint8Array.from(Buffer.from(EVENT.orgPkh, "hex")),
    constants: decodedConstants(),
    buyer: new Uint8Array(TXID_BYTE_LENGTH).fill(BUYER_BYTE),
    buyerUtxos: [{ txId: new Uint8Array(TXID_BYTE_LENGTH).fill(BUYER_UTXO_BYTE), index: 0 }],
    buyerUtxoValues: [UTXO_VALUE],
    orgScript: { version: 0, script: EVENT.orgSpk },
    changeScript: { version: 0, script: "51" },
    covenantCode: hexToBytes(EVENT_ARTIFACT.code),
    remaining: EVENT.capacity,
    network: NETWORK,
    fee: 400,
  });
  return buyTxModelFrom(tx);
}

function buildBuyTx(): TxModel {
  return buyTx();
}

function readerApp(kaspa: KaspaClientLike, events: EventRegistry = new EventRegistry([EVENT])) {
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
        event_id: EVENT.eventId,
        genesis_txid: EVENT.genesisTxId,
        name: EVENT.name,
        date: EVENT.date,
        price: EVENT.price,
        capacity: EVENT.capacity,
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
    expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
    expect(res.json().error.type).toBe("invalid");
    await app.close();
  });
});

describe("reader routes (KTK-5) — event availability", () => {
  it("GET /v1/events/{id} returns event + availability", async () => {
    const kaspa = new FakeKaspa();
    const genesis = deployTx(); // event covenant at remaining = 2
    kaspa.transactions.set(G_ID, genesis);
    // one mint: a buy tx spends the event covenant (G_ID:0) and creates the
    // remaining event covenant at remaining = 1 (output index 1)
    const buy = buildBuyTx();
    const deployAddress = addressFromScriptHash(deployScript(), NETWORK);
    kaspa.txMap.set(deployAddress, [buy]); // spender visible at deploy address
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
    const res = await app.inject({ method: "GET", url: `/v1/events/${EVENT.eventId}` });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json()).toEqual({
      event: { event_id: EVENT.eventId, name: EVENT.name, date: EVENT.date, price: EVENT.price },
      availability: { capacity: 2, sold: 1, left: 1 },
    });
    await app.close();
  });
});

describe("reader routes (KTK-5) — event validation", () => {
  it("GET /v1/events/{id} treats a missing deploy tx as invalid (400)", async () => {
    const app = await readerApp(new FakeKaspa());
    const res = await app.inject({ method: "GET", url: `/v1/events/${EVENT.eventId}` });
    expect(res.statusCode).toBe(HTTP_BAD_REQUEST);
    expect(res.json().error.type).toBe("invalid");
    expect(res.json().error.retryable).toBe(false);
    await app.close();
  });
});

describe("reader routes (KTK-5) — tickets", () => {
  it("GET /v1/tickets/{id} returns alive for an unspent ticket", async () => {
    const kaspa = new FakeKaspa();
    const buy = buildBuyTx(); // minted ticket at output 0
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

    // register the event keyed by the ticket's creating tx (the buy)
    const app = await readerApp(kaspa, new EventRegistry([{ ...EVENT, genesisTxId: B0_ID }]));
    const res = await app.inject({ method: "GET", url: `/v1/tickets/${B0_ID}:0` });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json().state).toBe("alive");
    expect(res.json().event.event_id).toBe(EVENT.eventId);
    expect(res.json().price).toBe(EVENT.price);
    await app.close();
  });
});

describe("reader routes (KTK-5) — unknown tickets", () => {
  it("GET /v1/tickets/{id} returns unknown with a cause (never guessed)", async () => {
    const kaspa = new FakeKaspa();
    kaspa.transactions.set(G_ID, deployTx());
    // spent but no spender visible -> unresolved-spend
    const app = await readerApp(kaspa);
    const res = await app.inject({ method: "GET", url: `/v1/tickets/${G_ID}:0` });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json()).toEqual({
      state: "unknown",
      cause: "unresolved-spend",
      event: { event_id: EVENT.eventId, name: EVENT.name, date: EVENT.date },
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
    event_id: EVENT.eventId,
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
    events: new EventRegistry([EVENT]),
    network: NETWORK,
    networkId: "testnet-10",
  });
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
    expect(body.template.outputs).toHaveLength(2); // event covenant + change
    const inputTotal = 1_000_000_000;
    const outputTotal = body.template.outputs.reduce(
      (acc: number, o: { value: number }) => acc + o.value,
      0,
    );
    expect(inputTotal - outputTotal).toBeGreaterThan(0); // a fee is charged
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
