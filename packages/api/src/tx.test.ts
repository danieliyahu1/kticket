import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KaspaClientLike } from "./kaspa-client";
import type {
  FeeEstimateResponse,
  SubmitTransactionResponse,
  SubmitTxModel,
  TxMass,
  TxModel,
} from "./kaspa-types";
import { broadcastTransaction, buildTransaction, throwRejectionError, toSubmitModel } from "./tx";

vi.mock("./wrpc-client.js", () => ({
  submitTransactionOverWrpc: vi.fn(),
}));

import { submitTransactionOverWrpc } from "./wrpc-client.js";

const mockedSubmit = vi.mocked(submitTransactionOverWrpc);

const TXID_BYTE_LENGTH = 32;
const SIGNATURE_SCRIPT_BYTE_LENGTH = 70;
const TICKET_PRICE = 1_000;
const UTXO_VALUE = 1_000_000_000;
const BUY_OUTPUTS = 4;
const EVENT_CAPACITY = 100;
const INVALID_CAPACITY = 101;

const EVENT_ID = "ab".repeat(TXID_BYTE_LENGTH);
const ORG_X_HEX = "01".repeat(TXID_BYTE_LENGTH);
const ORG_SPK_HEX = `20${ORG_X_HEX}ac`;

const CHANGE_SPK = { version: 0, script: "51" };
const ORGANIZER_UTXO = {
  transaction_id: "cc".repeat(TXID_BYTE_LENGTH),
  index: 0,
  value: UTXO_VALUE,
};
const BUYER_UTXO = { transaction_id: "cc".repeat(TXID_BYTE_LENGTH), index: 0, value: UTXO_VALUE };
const HOLDER_UTXO = { transaction_id: "dd".repeat(TXID_BYTE_LENGTH), index: 0, value: UTXO_VALUE };

const CONSTANTS = {
  authorizing_txid: EVENT_ID,
  price: 1_000,
  org_spk: ORG_SPK_HEX,
  burn_template_hash: "77".repeat(TXID_BYTE_LENGTH),
};

const FEE_ESTIMATE: FeeEstimateResponse = {
  priorityBucket: { feerate: 200, estimatedSeconds: 1 },
  normalBuckets: [{ feerate: 100, estimatedSeconds: 5 }],
  lowBuckets: [{ feerate: 50, estimatedSeconds: 10 }],
};

class FakeKaspa implements KaspaClientLike {
  feeEstimate: FeeEstimateResponse = FEE_ESTIMATE;
  broadcastResponse: SubmitTransactionResponse = { transactionId: "dd".repeat(TXID_BYTE_LENGTH) };
  broadcastCalls = 0;
  lastBroadcast?: SubmitTxModel;
  transaction: TxModel | null = null;

  async getUtxos(): Promise<never> {
    throw new Error("not used");
  }

  async getUtxosForAddresses(): Promise<never> {
    throw new Error("not used");
  }

  async getFullTransactions(): Promise<never> {
    throw new Error("not used");
  }

  async getTransaction(_txId: string): Promise<TxModel | null> {
    return this.transaction;
  }

  clearCache(): void {}

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

const signedTx = {
  version: 1,
  inputs: [
    {
      previous_outpoint: { transaction_id: "aa".repeat(TXID_BYTE_LENGTH), index: 0 },
      signature_script: "01".repeat(SIGNATURE_SCRIPT_BYTE_LENGTH),
      sequence: 0,
      sig_op_count: 1,
    },
  ],
  outputs: [{ value: 49_000, script_public_key: { version: 0, script: "51" }, covenant: null }],
  lock_time: 0,
};

function deployRequest(capacity: number) {
  return {
    type: "deploy",
    capacity,
    constants: CONSTANTS,
    organizer: "01".repeat(TXID_BYTE_LENGTH),
    authorizing_outpoint: ORGANIZER_UTXO,
    organizer_utxos: [],
    change_spk: CHANGE_SPK,
  };
}

function buyRequest(constants = CONSTANTS, buyerUtxos = [BUYER_UTXO]) {
  return {
    type: "buy",
    event_outpoint: { transaction_id: "aa".repeat(TXID_BYTE_LENGTH), index: 0 },
    event_covenant_id: "77".repeat(TXID_BYTE_LENGTH),
    event_owner: "01".repeat(TXID_BYTE_LENGTH),
    remaining: 100,
    constants,
    buyer: "42".repeat(TXID_BYTE_LENGTH),
    buyer_utxos: buyerUtxos,
    change_spk: CHANGE_SPK,
  };
}

describe("toSubmitModel", () => {
  it("maps the wire template to the upstream SubmitTxModel shape", () => {
    const model = toSubmitModel({
      version: 1,
      inputs: [
        {
          previous_outpoint: { transaction_id: "aa".repeat(TXID_BYTE_LENGTH), index: 0 },
          signature_script: "",
          sequence: 0,
          sig_op_count: 1,
        },
      ],
      outputs: [
        {
          value: 0,
          script_public_key: { version: 0, script: "51" },
          covenant: { authorizing_input: 0, covenant_id: "bb".repeat(TXID_BYTE_LENGTH) },
        },
      ],
      lock_time: 0,
    });
    expect(model).toEqual({
      version: 1,
      inputs: [
        {
          previousOutpoint: { transactionId: "aa".repeat(TXID_BYTE_LENGTH), index: 0 },
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

describe("buildTransaction (KTK-28) — deploy", () => {
  it("builds a fee-aware deploy template from a wallet request", async () => {
    const kaspa = new FakeKaspa();
    const result = await buildTransaction(deployRequest(EVENT_CAPACITY), ctx(kaspa));

    expect(result.template.version).toBe(1);
    expect(result.template.outputs).toHaveLength(2); // event covenant + change
    expect(result.event_covenant_id).toMatch(/^[0-9a-f]{64}$/);
    // a fee is charged: inputs exceed outputs
    const inputTotal = UTXO_VALUE;
    const outputTotal = result.template.outputs.reduce((acc, o) => acc + o.value, 0);
    expect(inputTotal - outputTotal).toBeGreaterThan(0);
  });

  it("rejects an unknown type as invalid", async () => {
    const kaspa = new FakeKaspa();
    await expect(buildTransaction({ type: "burn" }, ctx(kaspa))).rejects.toMatchObject({
      type: "invalid",
    });
  });
});

describe("buildTransaction (KTK-28) — buy", () => {
  it("builds a buy template where the event splits a ticket and the buyer pays price + dust + fee", async () => {
    const kaspa = new FakeKaspa();
    const result = await buildTransaction(buyRequest(), ctx(kaspa));

    expect(result.template.outputs).toHaveLength(BUY_OUTPUTS); // ticket + remaining + payout + change
    const payout = result.template.outputs.find((o) => o.value === TICKET_PRICE);
    expect(payout).toBeDefined();
    const change = result.template.outputs.find(
      (o) => o.covenant === null && o.value !== TICKET_PRICE,
    );
    // buyer pays price + ticket dust + fee, so change is under what they supplied
    expect(change?.value).toBeGreaterThan(0);
    expect(change?.value).toBeLessThan(UTXO_VALUE);
  });

  it("rejects invalid capacity as invalid", async () => {
    const kaspa = new FakeKaspa();
    await expect(
      buildTransaction(deployRequest(INVALID_CAPACITY), ctx(kaspa)),
    ).rejects.toMatchObject({
      type: "invalid",
    });
  });
});

describe("buildTransaction (KTK-55) — buy signing template alignment", () => {
  const EVENT_TXID = "aa".repeat(TXID_BYTE_LENGTH);
  const EVENT_SPK = ORG_SPK_HEX;
  const EVENT_VALUE = 500_000_000;

  const BUYER_META = {
    transaction_id: "cc".repeat(TXID_BYTE_LENGTH),
    index: 0,
    value: UTXO_VALUE,
    script_public_key: { version: 0, script: ORG_SPK_HEX },
    block_daa_score: 100,
    is_coinbase: false,
  };

  function eventTx(): TxModel {
    return {
      transaction_id: EVENT_TXID,
      accepting_block_blue_score: 50,
      inputs: [],
      outputs: [
        {
          transaction_id: EVENT_TXID,
          index: 0,
          amount: EVENT_VALUE,
          script_public_key: EVENT_SPK,
        },
      ],
    };
  }

  it("prepends the event covenant UTXO metadata to inputUtxoMetas at index 0", async () => {
    const kaspa = new FakeKaspa();
    kaspa.transaction = eventTx();

    const req = buyRequest();
    const result = await buildTransaction(
      { ...req, input_utxo_metas: [BUYER_META] },
      ctx(kaspa),
    );

    // The signing template should be generated since all UTXOs have script_public_key
    expect(result.signing_template).toBeDefined();

    const signing = JSON.parse(result.signing_template!);
    const inputs = signing.inputs as Array<{ utxo: Record<string, unknown> }>;

    // The tx has 2 inputs: event covenant + buyer
    // The signing template should have 2 inputs with utxo metadata
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.utxo).toBeDefined();
    expect(inputs[1]?.utxo).toBeDefined();

    // Input 0 (event covenant) should have the event's UTXO value and script
    expect(inputs[0]?.utxo?.amount).toBe(String(EVENT_VALUE));
  });

  it("generates signing template only when buyer UTXO metas have script_public_key", async () => {
    const kaspa = new FakeKaspa();
    kaspa.transaction = eventTx();

    const result = await buildTransaction(
      { ...buyRequest(), input_utxo_metas: [BUYER_META] },
      ctx(kaspa),
    );
    expect(result.signing_template).toBeDefined();
  });

  it("does not generate signing template when buyer UTXO metas lack script_public_key", async () => {
    const kaspa = new FakeKaspa();
    kaspa.transaction = eventTx();

    // No input_utxo_metas → buyer UTXOs get empty script from utxoMetaOf
    const result = await buildTransaction(buyRequest(), ctx(kaspa));
    expect(result.signing_template).toBeUndefined();
  });

  it("inputTotal includes both event covenant and buyer UTXO values", async () => {
    const kaspa = new FakeKaspa();
    kaspa.transaction = eventTx();

    const result = await buildTransaction(buyRequest(), ctx(kaspa));
    // Outputs include: ticket + remaining event + payout + change
    expect(result.template.outputs).toHaveLength(BUY_OUTPUTS);

    // All outputs should be covered by event value + buyer value - fee
    const outputTotal = result.template.outputs.reduce((a, o) => a + o.value, 0);
    expect(outputTotal).toBeLessThan(EVENT_VALUE + UTXO_VALUE);
  });

  it("fills covenant input with mint args + pushData-wrapped redeem script", async () => {
    const kaspa = new FakeKaspa();
    kaspa.transaction = eventTx();

    const req = buyRequest();
    const result = await buildTransaction(
      { ...req, input_utxo_metas: [BUYER_META] },
      ctx(kaspa),
    );

    // Input 0 (covenant) must carry the mint call args (push(buyer_pkh) +
    // selector) followed by the pushData-wrapped redeem script, not a Schnorr sig.
    const sigScript = result.template.inputs[0]?.signature_script ?? "";
    expect(sigScript.length).toBeGreaterThan(0);
    const buyerPkh = "42".repeat(TXID_BYTE_LENGTH);
    expect(sigScript.slice(0, 2)).toBe("20"); // OP_PUSHBYTES_32
    expect(sigScript.slice(0, 2 + buyerPkh.length)).toBe(`20${buyerPkh}`);
    // Redeem reveal follows the args (0x4c = OP_PUSHDATA1 / 0x4d = OP_PUSHDATA2)
    expect(sigScript.slice(2 + buyerPkh.length + 2)).toMatch(/^(4c|4d)/);

    // Signing template also has the covenant spend script
    expect(result.signing_template).toBeDefined();
    const signing = JSON.parse(result.signing_template!);
    const inputs = signing.inputs as Array<{ signatureScript: string }>;
    expect(inputs[0]?.signatureScript.slice(0, 2)).toBe("20");
    expect(inputs[0]?.signatureScript.slice(2 + buyerPkh.length + 2)).toMatch(/^(4c|4d)/);
  });

  it("continuation outputs keep the genesis covenant id from the buy request", async () => {
    const kaspa = new FakeKaspa();
    kaspa.transaction = eventTx();

    const req = buyRequest();
    const result = await buildTransaction(
      { ...req, input_utxo_metas: [BUYER_META] },
      ctx(kaspa),
    );

    // The buy is a CONTINUATION of the deployed event covenant. Its outputs
    // (ticket + remaining event) must be bound to the SAME covenant family id
    // as the genesis event (`req.event_covenant_id`), NOT a freshly recomputed id.
    const expected = "77".repeat(TXID_BYTE_LENGTH);
    for (const output of result.template.outputs) {
      if (output.covenant) {
        expect(output.covenant.covenant_id, "continuation output covenant id").toBe(expected);
      }
    }
    // The returned event_covenant_id must also stay as the genesis id.
    expect(result.event_covenant_id).toBe(expected);
  });

});

describe("buildTransaction (KTK-28) — failure paths", () => {
  it("maps inputs that cannot cover payouts + fee to policy", async () => {
    const kaspa = new FakeKaspa();
    await expect(
      buildTransaction(
        buyRequest({ ...CONSTANTS, price: 100_000 }, [
          { transaction_id: "cc".repeat(TXID_BYTE_LENGTH), index: 0, value: 500 },
        ]),
        ctx(kaspa),
      ),
    ).rejects.toMatchObject({ type: "policy" });
  });

  it("propagates an upstream failure from the fee-estimate call", async () => {
    const kaspa = new FakeKaspa();
    kaspa.getFeeEstimate = async () => {
      throw Object.assign(new Error("up"), { type: "upstream", statusCode: 503 });
    };
    await expect(buildTransaction(deployRequest(1), ctx(kaspa))).rejects.toMatchObject({
      type: "upstream",
    });
  });
});

describe("broadcastTransaction (KTK-29)", () => {
  beforeEach(() => {
    mockedSubmit.mockReset();
  });

  it("relays the signed tx over wRPC and returns the txid", async () => {
    mockedSubmit.mockResolvedValue("DD".repeat(TXID_BYTE_LENGTH));
    const kaspa = new FakeKaspa();
    const result = await broadcastTransaction({ transaction: signedTx }, ctx(kaspa));
    expect(result).toEqual({ txid: "dd".repeat(TXID_BYTE_LENGTH) });
    expect(mockedSubmit).toHaveBeenCalledTimes(1);
    expect(mockedSubmit.mock.calls[0]?.[0]).toBe("testnet-10");
    expect(mockedSubmit.mock.calls[0]?.[1].version).toBe(1);
  });

  it("is idempotent: re-broadcasting a known tx returns the same txid", async () => {
    mockedSubmit.mockResolvedValue("dd".repeat(TXID_BYTE_LENGTH));
    const kaspa = new FakeKaspa();
    const first = await broadcastTransaction({ transaction: signedTx }, ctx(kaspa));
    const second = await broadcastTransaction({ transaction: signedTx }, ctx(kaspa));
    expect(second).toEqual(first);
    expect(mockedSubmit).toHaveBeenCalledTimes(2);
  });
});

describe("broadcastTransaction (KTK-29) — rejection mapping", () => {
  beforeEach(() => {
    mockedSubmit.mockReset();
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
