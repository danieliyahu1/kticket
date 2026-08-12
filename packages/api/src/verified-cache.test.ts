import { buildDeploy } from "@kticket/kit";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { compileBurnArtifact, compileEventArtifact } from "./compiler";
import type { KaspaClientLike } from "./kaspa-client";
import type { TxModel, UtxoResponse } from "./kaspa-types";
import { VerifiedEventCache } from "./verified-cache";

const TXID_BYTE_LENGTH = 32;
const ORG_PKH = new Uint8Array(TXID_BYTE_LENGTH).fill(0x01);
const UTXO_VALUE = 10_000_000_000;

const NETWORK = "testnet10";
const AUTH_TXID = "ab".repeat(TXID_BYTE_LENGTH);
const G_ID = "aa".repeat(TXID_BYTE_LENGTH);
const ORG_PKH_HEX = bytesToHex(ORG_PKH);
const ORG_SPK_HEX = `20${ORG_PKH_HEX}ac`;
const BURN_TEMPLATE_HASH = bytesToHex(
  Uint8Array.from(compileBurnArtifact(AUTH_TXID).template_hash),
);

function deployModel(): TxModel {
  const artifact = compileEventArtifact({
    authorizingTxId: AUTH_TXID,
    price: 1_000,
    orgSpk: ORG_SPK_HEX,
    burnTemplateHash: BURN_TEMPLATE_HASH,
  });
  const { tx } = buildDeploy({
    authorizingOutpoint: { txId: hexToBytes(AUTH_TXID), index: 0 },
    organizerUtxos: [],
    organizerUtxoValues: [UTXO_VALUE],
    organizer: ORG_PKH,
    capacity: 3,
    eventArtifact: artifact,
    changeScript: { version: 0, script: "51" },
    fee: 1_000,
    network: NETWORK,
    metadata: {
      name: "Testnet Rave",
      date: "2026-12-31",
      time: "20:00",
      priceKAS: 1_000 / 100_000_000,
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

class FakeKaspa implements KaspaClientLike {
  txReads = 0;
  constructor(private readonly genesis: TxModel) {}

  async getTransaction(txId: string): Promise<TxModel | null> {
    this.txReads += 1;
    const lower = txId.toLowerCase();
    if (lower === this.genesis.transaction_id) return this.genesis;
    if (lower === AUTH_TXID) return fundingModel();
    return null;
  }

  clearCache(): void {}

  async getUtxos(): Promise<UtxoResponse[]> {
    throw new Error("getUtxos not used by the cache tests");
  }

  async getUtxosForAddresses(): Promise<UtxoResponse[]> {
    throw new Error("getUtxosForAddresses not used by the cache tests");
  }

  async getFullTransactions(): Promise<TxModel[]> {
    throw new Error("getFullTransactions not used by the cache tests");
  }

  async getFeeEstimate(): Promise<never> {
    throw new Error("getFeeEstimate not used by the cache tests");
  }

  async computeMass(): Promise<never> {
    throw new Error("computeMass not used by the cache tests");
  }

  async broadcastTransaction(): Promise<never> {
    throw new Error("broadcastTransaction not used by the cache tests");
  }
}

describe("VerifiedEventCache", () => {
  it("verifies an event once and serves the memo on repeat reads", async () => {
    const kaspa = new FakeKaspa(deployModel());
    const cache = new VerifiedEventCache();

    const first = await cache.verify(kaspa, NETWORK, G_ID);
    const second = await cache.verify(kaspa, NETWORK, G_ID);

    expect(second).toBe(first);
    // One deploy read + one funding read — verification ran once.
    expect(kaspa.txReads).toBe(2);
  });

  it("does not cache failed verifications", async () => {
    const kaspa = new FakeKaspa(deployModel());
    const cache = new VerifiedEventCache();

    await expect(cache.verify(kaspa, NETWORK, "ff".repeat(TXID_BYTE_LENGTH))).rejects.toThrow();
    const verified = await cache.verify(kaspa, NETWORK, G_ID);
    expect(verified.covenant_id).toMatch(/^[0-9a-f]{64}$/);
  });
});
