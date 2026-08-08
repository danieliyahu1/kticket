import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KaspaClientLike } from "./kaspa-client";
import type {
  FeeEstimateResponse,
  SubmitTransactionResponse,
  SubmitTxModel,
  TxMass,
} from "./kaspa-types";
import { broadcastTransaction, buildTransaction, throwRejectionError, toSubmitModel } from "./tx";

vi.mock("./wrpc-client.js", () => ({
  submitTransactionOverWrpc: vi.fn(),
}));

import { submitTransactionOverWrpc } from "./wrpc-client.js";

const mockedSubmit = vi.mocked(submitTransactionOverWrpc);

const EVENT_ID = "ab".repeat(32);
const ORG_SPK_HEX = "21020001";

const CHANGE_SPK = { version: 0, script: "51" };
const ORGANIZER_UTXO = { transaction_id: "cc".repeat(32), index: 0, value: 1_000_000_000 };
const BUYER_UTXO = { transaction_id: "cc".repeat(32), index: 0, value: 1_000_000_000 };
const HOLDER_UTXO = { transaction_id: "dd".repeat(32), index: 0, value: 1_000_000_000 };

const CONSTANTS = {
  event_id: EVENT_ID,
  price: 1_000,
  org_spk: ORG_SPK_HEX,
  burn_template_hash: "77".repeat(32),
};

const FEE_ESTIMATE: FeeEstimateResponse = {
  priorityBucket: { feerate: 200, estimatedSeconds: 1 },
  normalBuckets: [{ feerate: 100, estimatedSeconds: 5 }],
  lowBuckets: [{ feerate: 50, estimatedSeconds: 10 }],
};

class FakeKaspa implements KaspaClientLike {
  feeEstimate: FeeEstimateResponse = FEE_ESTIMATE;
  broadcastResponse: SubmitTransactionResponse = { transactionId: "dd".repeat(32) };
  broadcastCalls = 0;
  lastBroadcast?: SubmitTxModel;

  async getUtxos(): Promise<never> {
    throw new Error("not used");
  }

  async getUtxosForAddresses(): Promise<never> {
    throw new Error("not used");
  }

  async getFullTransactions(): Promise<never> {
    throw new Error("not used");
  }

  async getTransaction(): Promise<never> {
    throw new Error("not used");
  }

  async getFeeEstimate(): Promise<FeeEstimateResponse> {
    return this.feeEstimate;
  }

  async computeMass(): Promise<TxMass> {
    return { mass: 1_000, storage_mass: 0, compute_mass: 1_000 };
  }

  async broadcastTransaction(_tx: SubmitTxModel): Promise<SubmitTransactionResponse> {
    this.broadcastCalls += 1;
    this.lastBroadcast = _tx;
    return this.broadcastResponse;
  }
}

const ctx = (kaspa: KaspaClientLike): { kaspa: KaspaClientLike; networkId: string } => ({
  kaspa,
  networkId: "testnet-10",
});

describe("toSubmitModel", () => {
  it("maps the wire template to the upstream SubmitTxModel shape", () => {
    const model = toSubmitModel({
      version: 1,
      inputs: [
        {
          previous_outpoint: { transaction_id: "aa".repeat(32), index: 0 },
          signature_script: "",
          sequence: 0,
          sig_op_count: 1,
        },
      ],
      outputs: [
        {
          value: 0,
          script_public_key: { version: 0, script: "51" },
          covenant: { authorizing_input: 0, covenant_id: "bb".repeat(32) },
        },
      ],
      lock_time: 0,
    });
    expect(model).toEqual({
      version: 1,
      inputs: [
        {
          previousOutpoint: { transactionId: "aa".repeat(32), index: 0 },
          signatureScript: "",
          sequence: 0,
          sigOpCount: 1,
        },
      ],
      outputs: [
        {
          amount: 0,
          scriptPublicKey: { version: 0, scriptPublicKey: "51" },
        },
      ],
      lockTime: 0,
    });
  });
});

describe("buildTransaction (KTK-28)", () => {
  it("builds a fee-aware deploy template from a wallet request", async () => {
    const kaspa = new FakeKaspa();
    const result = await buildTransaction(
      {
        type: "deploy",
        capacity: 100,
        constants: CONSTANTS,
        organizer: "01".repeat(32),
        authorizing_outpoint: ORGANIZER_UTXO,
        organizer_utxos: [],
        change_spk: CHANGE_SPK,
      },
      ctx(kaspa),
    );

    expect(result.template.version).toBe(1);
    expect(result.template.outputs).toHaveLength(2); // event covenant + change
    expect(result.event_covenant_id).toMatch(/^[0-9a-f]{64}$/);
    // a fee is charged: inputs exceed outputs
    const inputTotal = 1_000_000_000;
    const outputTotal = result.template.outputs.reduce((acc, o) => acc + o.value, 0);
    expect(inputTotal - outputTotal).toBeGreaterThan(0);
  });

  it("builds a buy template where the event splits a ticket and the buyer pays price + dust + fee", async () => {
    const kaspa = new FakeKaspa();
    const result = await buildTransaction(
      {
        type: "buy",
        event_outpoint: { transaction_id: "aa".repeat(32), index: 0 },
        event_covenant_id: "77".repeat(32),
        event_owner: "01".repeat(32),
        remaining: 100,
        constants: CONSTANTS,
        buyer: "42".repeat(32),
        buyer_utxos: [BUYER_UTXO],
        change_spk: CHANGE_SPK,
      },
      ctx(kaspa),
    );

    expect(result.template.outputs).toHaveLength(4); // ticket + remaining + payout + change
    const payout = result.template.outputs.find((o) => o.value === 1_000);
    expect(payout).toBeDefined();
    const change = result.template.outputs.find((o) => o.covenant === null && o.value !== 1_000);
    // buyer pays price + ticket dust + fee, so change is under what they supplied
    expect(change?.value).toBeGreaterThan(0);
    expect(change?.value).toBeLessThan(1_000_000_000);
  });

  it("builds a transfer template with the holder paying the fee", async () => {
    const kaspa = new FakeKaspa();
    const result = await buildTransaction(
      {
        type: "transfer",
        ticket_outpoint: { transaction_id: "bb".repeat(32), index: 0 },
        event_covenant_id: "77".repeat(32),
        constants: CONSTANTS,
        new_owner: "99".repeat(32),
        holder_utxos: [HOLDER_UTXO],
        change_spk: CHANGE_SPK,
      },
      ctx(kaspa),
    );

    expect(result.template.outputs).toHaveLength(2);
    const change = result.template.outputs[1];
    // the holder pays the fee: change is less than the supplied input
    expect(change?.value).toBeLessThan(1_000_000_000);
  });

  it("lifts a 0-fee estimate to the relay floor (0-fee tx never relays)", async () => {
    const kaspa = new FakeKaspa();
    kaspa.feeEstimate = {
      priorityBucket: { feerate: 0, estimatedSeconds: 1 },
      normalBuckets: [],
      lowBuckets: [],
    };
    const result = await buildTransaction(
      {
        type: "transfer",
        ticket_outpoint: { transaction_id: "bb".repeat(32), index: 0 },
        event_covenant_id: "77".repeat(32),
        constants: CONSTANTS,
        new_owner: "99".repeat(32),
        holder_utxos: [HOLDER_UTXO],
        change_spk: CHANGE_SPK,
      },
      ctx(kaspa),
    );
    // even a 0-feerate estimate is lifted to a positive fee (relay floor),
    // so the holder's change is less than the supplied input
    const change = result.template.outputs[1];
    expect(change?.value).toBeLessThan(1_000_000_000);
  });

  it("rejects invalid capacity as invalid", async () => {
    const kaspa = new FakeKaspa();
    await expect(
      buildTransaction(
        {
          type: "deploy",
          capacity: 101,
          constants: CONSTANTS,
          organizer: "01".repeat(32),
          authorizing_outpoint: ORGANIZER_UTXO,
          organizer_utxos: [],
          change_spk: CHANGE_SPK,
        },
        ctx(kaspa),
      ),
    ).rejects.toMatchObject({ type: "invalid" });
  });

  it("rejects an unknown type as invalid", async () => {
    const kaspa = new FakeKaspa();
    await expect(buildTransaction({ type: "burn" }, ctx(kaspa))).rejects.toMatchObject({
      type: "invalid",
    });
  });

  it("maps inputs that cannot cover payouts + fee to policy", async () => {
    const kaspa = new FakeKaspa();
    await expect(
      buildTransaction(
        {
          type: "buy",
          event_outpoint: { transaction_id: "aa".repeat(32), index: 0 },
          event_covenant_id: "77".repeat(32),
          event_owner: "01".repeat(32),
          remaining: 100,
          constants: { ...CONSTANTS, price: 100_000 },
          buyer: "42".repeat(32),
          buyer_utxos: [{ transaction_id: "cc".repeat(32), index: 0, value: 500 }],
          change_spk: CHANGE_SPK,
        },
        ctx(kaspa),
      ),
    ).rejects.toMatchObject({ type: "policy" });
  });

  it("propagates an upstream failure from the fee-estimate call", async () => {
    const kaspa = new FakeKaspa();
    kaspa.getFeeEstimate = async () => {
      throw Object.assign(new Error("up"), { type: "upstream", statusCode: 503 });
    };
    await expect(
      buildTransaction(
        {
          type: "deploy",
          capacity: 1,
          constants: CONSTANTS,
          organizer: "01".repeat(32),
          authorizing_outpoint: ORGANIZER_UTXO,
          organizer_utxos: [],
          change_spk: CHANGE_SPK,
        },
        ctx(kaspa),
      ),
    ).rejects.toMatchObject({ type: "upstream" });
  });
});

describe("broadcastTransaction (KTK-29)", () => {
  const signedTx = {
    version: 1,
    inputs: [
      {
        previous_outpoint: { transaction_id: "aa".repeat(32), index: 0 },
        signature_script: "01".repeat(70),
        sequence: 0,
        sig_op_count: 1,
      },
    ],
    outputs: [{ value: 49_000, script_public_key: { version: 0, script: "51" }, covenant: null }],
    lock_time: 0,
  };

  beforeEach(() => {
    mockedSubmit.mockReset();
  });

  it("relays the signed tx over wRPC and returns the txid", async () => {
    mockedSubmit.mockResolvedValue("DD".repeat(32));
    const kaspa = new FakeKaspa();
    const result = await broadcastTransaction({ transaction: signedTx }, ctx(kaspa));
    expect(result).toEqual({ txid: "dd".repeat(32) });
    expect(mockedSubmit).toHaveBeenCalledTimes(1);
    expect(mockedSubmit.mock.calls[0]?.[0]).toBe("testnet-10");
    expect(mockedSubmit.mock.calls[0]?.[1].version).toBe(1);
  });

  it("is idempotent: re-broadcasting a known tx returns the same txid", async () => {
    mockedSubmit.mockResolvedValue("dd".repeat(32));
    const kaspa = new FakeKaspa();
    const first = await broadcastTransaction({ transaction: signedTx }, ctx(kaspa));
    const second = await broadcastTransaction({ transaction: signedTx }, ctx(kaspa));
    expect(second).toEqual(first);
    expect(mockedSubmit).toHaveBeenCalledTimes(2);
  });

  it("maps a double-spend rejection to conflict", async () => {
    mockedSubmit.mockRejectedValue(new Error("Rejected transaction: double spend"));
    const kaspa = new FakeKaspa();
    await expect(broadcastTransaction({ transaction: signedTx }, ctx(kaspa))).rejects.toMatchObject(
      {
        type: "conflict",
        statusCode: 409,
      },
    );
  });

  it("maps an invalid-sig rejection to invalid", async () => {
    mockedSubmit.mockRejectedValue(new Error("Rejected transaction: invalid signature"));
    const kaspa = new FakeKaspa();
    await expect(broadcastTransaction({ transaction: signedTx }, ctx(kaspa))).rejects.toMatchObject(
      {
        type: "invalid",
        statusCode: 400,
      },
    );
  });

  it("rejects a malformed transaction as invalid", async () => {
    const kaspa = new FakeKaspa();
    await expect(
      broadcastTransaction({ transaction: { version: 0 } }, ctx(kaspa)),
    ).rejects.toMatchObject({
      type: "invalid",
    });
    expect(mockedSubmit).not.toHaveBeenCalled();
  });
});

describe("throwRejectionError", () => {
  it("classifies double-spend / already-known as conflict", () => {
    for (const msg of [
      "Rejected transaction ...: double spend",
      "transaction already exists",
      "orphan transaction",
    ]) {
      expect(() => throwRejectionError(msg)).toThrow(/double spend or already known/);
    }
  });

  it("classifies fee/mass rejections as policy", () => {
    expect(() => throwRejectionError("low fee")).toThrow(/fee policy/);
  });

  it("classifies everything else as invalid", () => {
    expect(() => throwRejectionError("script error")).toThrow(/transaction rejected/);
  });
});
