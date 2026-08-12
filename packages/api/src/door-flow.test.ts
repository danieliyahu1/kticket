// Whole-issue integration test for KTK-119 (door flow, sub-issue KTK-147).
//
// The door flow as a black box through the API: owner prepare → owner signs →
// QR payload codec round-trip → gate sign-template re-derive → gate co-signs
// input 0 → gate finalize (merge, assemble, broadcast) → confirmed txid.
//
// External dependencies are mocked: chain reads come from a seeded FakeKaspa,
// the wRPC broadcast is mocked, and the "wallets" (owner + gate) are simulated
// as 65-byte signature pushes — only kticket's own code is exercised end to end.

import {
  assembleMarkUsedSigScript,
  buildBuy,
  buildDeploy,
  decodeUsePayload,
  encodeUsePayload,
  injectState,
  p2pkAddress,
  type UnsignedTransaction,
} from "@kticket/kit";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app";
import { compileBurnArtifact, compileEventArtifact } from "./compiler";
import { loadConfig } from "./config";
import { EventStore } from "./eventstore";
import { HTTP_OK } from "./http-status.js";

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
const NETWORK = "testnet10";
const G_ID = "aa".repeat(TXID_BYTE_LENGTH);
const B0_ID = "bb".repeat(TXID_BYTE_LENGTH);
const AUTH_TXID = "ab".repeat(TXID_BYTE_LENGTH);
const USED_TXID = "ee".repeat(TXID_BYTE_LENGTH);

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

const TICKET_OWNER_HEX = "02".repeat(TXID_BYTE_LENGTH);
const OWNER_PUBKEY_HEX = `02${TICKET_OWNER_HEX}`;
const OWNER_ADDRESS = p2pkAddress(hexToBytes(TICKET_OWNER_HEX), NETWORK);
const OWNER_UTXO_TXID = "dd".repeat(TXID_BYTE_LENGTH);
const TICKET_ID = `${B0_ID}:0`;

function eventArtifact() {
  return compileEventArtifact({
    authorizingTxId: AUTH_TXID_HEX,
    price: EVENT_PRICE,
    orgSpk: ORG_SPK_HEX,
    burnTemplateHash: BURN_TEMPLATE_HASH,
  });
}

function eventCovenantId(): string {
  const { eventCovenantId } = buildDeploy({
    authorizingOutpoint: { txId: hexToBytes(AUTH_TXID_HEX), index: 0 },
    organizerUtxos: [],
    organizerUtxoValues: [10_000_000_000],
    organizer: hexToBytes(ORG_PKH_HEX),
    capacity: EVENT_CAPACITY,
    eventArtifact: eventArtifact(),
    changeScript: { version: 0, script: "51" },
    fee: 1_000,
    network: NETWORK,
  });
  return eventCovenantId;
}

const TEST_COVENANT_ID = eventCovenantId();

function deployTx(): TxModel {
  const { tx } = buildDeploy({
    authorizingOutpoint: { txId: hexToBytes(AUTH_TXID_HEX), index: 0 },
    organizerUtxos: [],
    organizerUtxoValues: [10_000_000_000],
    organizer: hexToBytes(ORG_PKH_HEX),
    capacity: EVENT_CAPACITY,
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
        amount: 10_000_000_000,
        script_public_key: ORG_SPK_HEX,
      },
    ],
  };
}

/** The mint tx: the event covenant splits into the owner's ticket + remainder. */
function buyTx(): TxModel {
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

class FakeKaspa implements KaspaClientLike {
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

function seedChain(kaspa: FakeKaspa): void {
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

function buildAppWith(kaspa: FakeKaspa) {
  const events = new EventStore();
  events.register({
    covenantId: TEST_COVENANT_ID,
    deployTxId: G_ID,
    organizerAddress: p2pkAddress(hexToBytes(ORG_PKH_HEX), NETWORK),
  });
  return buildApp(loadConfig({ KASPANET: NETWORK }), {
    kaspa,
    events,
    network: NETWORK,
    networkId: "testnet-10",
  });
}

describe("door flow end-to-end (KTK-119 whole-issue integration)", () => {
  it("admits the holder: prepare → sign → QR round-trip → sign-template → co-sign → finalize → confirmed", async () => {
    const kaspa = new FakeKaspa();
    seedChain(kaspa);
    mockedSubmit.mockResolvedValue(USED_TXID);
    kaspa.transactions.set(USED_TXID, { transaction_id: USED_TXID, inputs: [], outputs: [] });
    const app = await buildAppWith(kaspa);

    // 1. Owner prepare — the backend verifies + builds the mark_used template.
    const prepare = await app.inject({
      method: "POST",
      url: `/v1/tickets/${TICKET_ID}/use/prepare`,
      payload: { publicKey: OWNER_PUBKEY_HEX, address: OWNER_ADDRESS },
    });
    expect(prepare.statusCode).toBe(HTTP_OK);
    const prepared = prepare.json();
    expect(prepared.sign_inputs_owner).toEqual([{ index: 0 }, { index: 1 }]);

    // 2. Owner signs every input; the QR payload is built from the template.
    const owner_signed = {
      inputs: prepared.sign_inputs_owner.map(({ index }: { index: number }) => ({
        transactionId: index === 0 ? B0_ID : OWNER_UTXO_TXID,
        index,
        signatureScript: `41${"aa".repeat(65)}`,
      })),
    };
    const payload = { use_id: prepared.use_id, template: prepared.template, owner_signed };
    const qr = await encodeUsePayload(payload);
    const decoded = await decodeUsePayload(qr);
    expect(decoded).toEqual(payload);

    // 3. Gate scans → re-derives the signing template (stateless rebuild).
    const signTemplate = await app.inject({
      method: "POST",
      url: `/v1/tickets/${TICKET_ID}/use/sign-template`,
      payload: { template: prepared.template },
    });
    expect(signTemplate.statusCode).toBe(HTTP_OK);
    expect(typeof signTemplate.json().signing_template).toBe("string");

    // 4. Gate co-signs input 0 only, then finalize assembles + broadcasts.
    const gate_signed = {
      inputs: [{ transactionId: B0_ID, index: 0, signatureScript: `41${"bb".repeat(65)}` }],
    };
    const finalize = await app.inject({
      method: "POST",
      url: `/v1/tickets/${TICKET_ID}/use/finalize`,
      payload: {
        use_id: decoded.use_id,
        template: decoded.template,
        owner_signed: decoded.owner_signed,
        gate_signed,
      },
    });
    expect(finalize.statusCode).toBe(HTTP_OK);
    expect(finalize.json()).toEqual({ txid: USED_TXID });
    expect(kaspa.clearCalls).toBe(1);

    // 5. The broadcast tx's input 0 carries the assembled mark_used sig-script
    //    (push(owner_sig) || push(gate_sig) || selector || push(redeem)).
    expect(mockedSubmit).toHaveBeenCalledTimes(1);
    const broadcastArg = mockedSubmit.mock.calls[0]?.[1] as {
      inputs: { signature_script: string }[];
    };
    const ownerBytes = hexToBytes(`41${"aa".repeat(65)}`).slice(1);
    const gateBytes = hexToBytes(`41${"bb".repeat(65)}`).slice(1);
    const redeem = injectState(eventArtifact(), {
      owner: hexToBytes(TICKET_OWNER_HEX),
      identifierType: 0,
      amount: 1,
      isMinter: false,
      used: false,
    });
    const expectedScript = bytesToHex(
      assembleMarkUsedSigScript(eventArtifact(), ownerBytes, gateBytes, redeem),
    );
    expect(broadcastArg.inputs[0]?.signature_script).toBe(expectedScript);

    await app.close();
  });
});
