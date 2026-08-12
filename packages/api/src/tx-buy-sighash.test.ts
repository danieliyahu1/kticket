import { describe, expect, it } from "vitest";
import type { KaspaClientLike } from "./kaspa-client.js";
import type {
  FeeEstimateResponse,
  SubmitTransactionResponse,
  SubmitTxModel,
  TxMass,
  TxModel,
} from "./kaspa-types.js";
import { buildTransaction, type WireTransaction } from "./tx.js";

const TXID_BYTE_LENGTH = 32;
const EVENT_TXID = "aa".repeat(TXID_BYTE_LENGTH);
const ORG_X_HEX = "01".repeat(TXID_BYTE_LENGTH);
const EVENT_SPK = `20${ORG_X_HEX}ac`;
const EVENT_VALUE = 500_000_000;
const UTXO_VALUE = 1_000_000_000;
const TICKET_PRICE = 1_000;

const BUYER_META = {
  transaction_id: "cc".repeat(TXID_BYTE_LENGTH),
  index: 0,
  value: UTXO_VALUE,
  script_public_key: { version: 0, script: EVENT_SPK },
  block_daa_score: 100,
  is_coinbase: false,
};

const FEE_ESTIMATE: FeeEstimateResponse = {
  priorityBucket: { feerate: 200, estimatedSeconds: 1 },
  normalBuckets: [{ feerate: 100, estimatedSeconds: 5 }],
  lowBuckets: [{ feerate: 50, estimatedSeconds: 10 }],
};

const CONSTANTS = {
  authorizing_txid: "ab".repeat(TXID_BYTE_LENGTH),
  price: TICKET_PRICE,
  org_spk: EVENT_SPK,
  burn_template_hash: "77".repeat(TXID_BYTE_LENGTH),
};

class FakeKaspa implements KaspaClientLike {
  feeEstimate: FeeEstimateResponse = FEE_ESTIMATE;
  broadcastResponse: SubmitTransactionResponse = { transactionId: "dd".repeat(TXID_BYTE_LENGTH) };
  broadcastCalls = 0;
  lastBroadcast?: SubmitTxModel;
  transaction: TxModel | null = null;

  async getUtxos(): Promise<never> { throw new Error("not used"); }
  async getUtxosForAddresses(): Promise<never> { throw new Error("not used"); }
  async getFullTransactions(): Promise<never> { throw new Error("not used"); }
  async getTransaction(_txId: string): Promise<TxModel | null> { return this.transaction; }
  clearCache(): void {}
  async getFeeEstimate(): Promise<FeeEstimateResponse> { return this.feeEstimate; }
  async computeMass(): Promise<TxMass> { return { mass: 1_000, storage_mass: 0, compute_mass: 1_000 }; }
  async broadcastTransaction(_tx: SubmitTxModel): Promise<SubmitTransactionResponse> {
    this.broadcastCalls += 1;
    this.lastBroadcast = _tx;
    return this.broadcastResponse;
  }
}

function buyRequest() {
  return {
    type: "buy" as const,
    event_outpoint: { transaction_id: EVENT_TXID, index: 0 },
    event_covenant_id: "77".repeat(TXID_BYTE_LENGTH),
    event_owner: "01".repeat(TXID_BYTE_LENGTH),
    remaining: 100,
    constants: CONSTANTS,
    buyer: "42".repeat(TXID_BYTE_LENGTH),
    buyer_utxos: [{ transaction_id: "cc".repeat(TXID_BYTE_LENGTH), index: 0, value: UTXO_VALUE }],
    change_spk: { version: 0, script: "51" },
  };
}

function eventTx(): TxModel {
  return {
    transaction_id: EVENT_TXID,
    accepting_block_blue_score: 50,
    inputs: [],
    outputs: [{ transaction_id: EVENT_TXID, index: 0, amount: EVENT_VALUE, script_public_key: EVENT_SPK }],
  };
}

/**
 * Strip fields that are NOT part of the v1 sighash (signatureScript, UTXO metadata).
 * Returns a canonical representation of the sighash-relevant fields.
 */
function sighashCanonical(tx: WireTransaction) {
  return {
    version: tx.version,
    input_outpoints: tx.inputs.map((i) => ({
      txid: i.previous_outpoint.transaction_id,
      index: i.previous_outpoint.index,
      sequence: i.sequence,
    })),
    outputs: tx.outputs.map((o) => ({
      value: o.value,
      spk: `${o.script_public_key.version}:${o.script_public_key.script}`,
      covenant: o.covenant
        ? { ai: o.covenant.authorizing_input, cid: o.covenant.covenant_id }
        : null,
    })),
    lock_time: tx.lock_time,
    payload: tx.payload ?? "",
  };
}

describe("sighash integrity — signing template vs broadcast template", () => {
  it("signing template outputs and broadcast template outputs match", async () => {
    const kaspa = new FakeKaspa();
    kaspa.transaction = eventTx();

    const result = await buildTransaction(
      { ...buyRequest(), input_utxo_metas: [BUYER_META] },
      { kaspa, networkId: "testnet-10" },
    );

    expect(result.signing_template).toBeDefined();

    const signingJson = JSON.parse(result.signing_template!) as Record<string, unknown>;
    const signingOutputs = signingJson.outputs as Array<Record<string, unknown>>;

    const broadcastCanon = sighashCanonical(result.template);

    // Compare output count
    expect(signingOutputs.length).toBe(broadcastCanon.outputs.length);

    for (let i = 0; i < signingOutputs.length; i++) {
      const s = signingOutputs[i]!;
      const b = broadcastCanon.outputs[i]!;

      expect(String(s.value), `output[${i}].value`).toBe(String(b.value));

      const sSpk = String(s.scriptPublicKey ?? "");
      const bSpk = b.spk;
      expect(sSpk, `output[${i}].scriptPublicKey`).toBe(`0000${bSpk.split(":")[1]}`);

      const sCov = s.covenant as Record<string, unknown> | undefined;
      if (sCov || b.covenant) {
        expect(sCov, `output[${i}] covenant should exist in both`).toBeDefined();
        expect(b.covenant, `output[${i}] covenant should exist in both`).toBeDefined();
        expect(Number(sCov?.authorizingInput), `output[${i}] covenant.authorizingInput`).toBe(b.covenant?.ai);
        expect(String(sCov?.covenantId), `output[${i}] covenant.covenantId`).toBe(b.covenant?.cid);
      }
    }

    // Compare input outpoints (same order)
    const sInputs = signingJson.inputs as Array<Record<string, unknown>>;
    expect(sInputs.length).toBe(broadcastCanon.input_outpoints.length);
    for (let i = 0; i < sInputs.length; i++) {
      expect(String(sInputs[i]?.transactionId), `input[${i}].txid`).toBe(
        broadcastCanon.input_outpoints[i]!.txid,
      );
      expect(Number(sInputs[i]?.index), `input[${i}].index`).toBe(
        broadcastCanon.input_outpoints[i]!.index,
      );
    }
  });

  it("signing template subnetworkId, lockTime, gas, payload match broadcast defaults", async () => {
    const kaspa = new FakeKaspa();
    kaspa.transaction = eventTx();

    const result = await buildTransaction(
      { ...buyRequest(), input_utxo_metas: [BUYER_META] },
      { kaspa, networkId: "testnet-10" },
    );

    expect(result.signing_template).toBeDefined();
    const signingJson = JSON.parse(result.signing_template!) as Record<string, unknown>;

    expect(signingJson.subnetworkId).toBe("0000000000000000000000000000000000000000");
    expect(signingJson.gas).toBe("0");
    expect(signingJson.lockTime).toBe("0");
    expect(signingJson.payload).toBe("");
  });
});
