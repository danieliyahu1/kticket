import { describe, expect, it } from "vitest";
import { buildWasmTransaction } from "./wrpc-client.js";
import type { WireTransaction } from "./wire.js";

const TXID_BYTE_LENGTH = 32;

const WASM = (await import("../vendor/kaspa-wasm/kaspa.js")) as {
  Transaction: new (
    init: unknown,
  ) => {
    outputs: Array<{ covenant?: { authorizingInput: number; covenantId: string } }>;
    readonly id: string;
  };
};

type WasmTransaction = InstanceType<typeof WASM.Transaction>;

function buildWireTransaction(): WasmTransaction {
  return new WASM.Transaction({
    version: 1,
    inputs: [
      {
        previousOutpoint: { transactionId: "aa".repeat(TXID_BYTE_LENGTH), index: 0 },
        signatureScript: "",
        sequence: 0n,
        sigOpCount: 0,
        computeBudget: 1,
      },
    ],
    outputs: [
      {
        value: 50_000_000n,
        scriptPublicKey: { version: 0, script: "51" },
        covenant: { authorizingInput: 0, covenantId: "bb".repeat(TXID_BYTE_LENGTH) },
      },
    ],
    lockTime: 0n,
    subnetworkId: "0000000000000000000000000000000000000000",
    gas: 0n,
    payload: "",
  });
}

describe("wrpc-client transaction construction (KTK-29)", () => {
  it("builds a v1 transaction with covenant bindings from the wire template", () => {
    const tx = buildWireTransaction();
    // The wasm Transaction carries the covenant binding on the ticket output.
    const covenant = tx.outputs[0]?.covenant;
    expect(JSON.parse(JSON.stringify(covenant))).toEqual({
      authorizingInput: 0,
      covenantId: "bb".repeat(TXID_BYTE_LENGTH),
    });
  });

  it("assigns a string id to the constructed transaction", () => {
    const tx = buildWireTransaction();
    expect(typeof tx.id).toBe("string");
  });

  it("exposes the RpcClient / Resolver / Encoding surface used for relay", async () => {
    const mod = (await import("../vendor/kaspa-wasm/kaspa.js")) as {
      RpcClient: unknown;
      Resolver: unknown;
      Encoding: { Borsh: number };
    };
    expect(typeof mod.RpcClient).toBe("function");
    expect(typeof mod.Resolver).toBe("function");
    expect(mod.Encoding.Borsh).toBeDefined();
  });
});

describe("buildWasmTransaction — broadcast relay construction (KTK: outpoint is not an object)", () => {
  const EVENT_COVENANT_ID = "a55feec69df92e228b5cb8761283ce9afa0d2bcb4404d1a6a2dbb81676a9721d";
  const FUNDING_TXID = "b789cd53fd83c1a8980f03abe2fc99fa3906d3de81105327dcf5b062260f713e";

  function deployWireTransaction(): WireTransaction {
    return {
      version: 1,
      inputs: [
        {
          previous_outpoint: { transaction_id: FUNDING_TXID, index: 1 },
          signature_script:
            "4175b3759f7c553a36acec8a43c9af0c7d4183a79a8fad4bbcacbcadb5cbf49603528cd6ac3acb2d68db1b2401fe6dc30fae966bb91e0b45ab0e92f0689eccec4501",
          sequence: 0,
          sig_op_count: 50,
        },
      ],
      outputs: [
        {
          value: 50_000_000,
          script_public_key: { version: 0, script: "aa20" + "c5".repeat(32) + "87" },
          covenant: { authorizing_input: 0, covenant_id: EVENT_COVENANT_ID },
        },
        {
          value: 98_733_528_500,
          script_public_key: {
            version: 0,
            script: "2071721fd48bf471ad50131c6c3c837dbf13c246041f8478d92f89a588d7a5e8e3ac",
          },
          covenant: null,
        },
      ],
      lock_time: 0,
      payload:
        "7b226e616d65223a22653561372d31222c2264617465223a22323032362d30382d3138227d",
    };
  }

  it("constructs a wasm Transaction for a deploy whose covenant output authorizes input 0", async () => {
    const tx = await buildWasmTransaction(deployWireTransaction());
    const covenant = (tx as WasmTransaction).outputs[0]?.covenant;
    expect(JSON.parse(JSON.stringify(covenant))).toEqual({
      authorizingInput: 0,
      covenantId: EVENT_COVENANT_ID,
    });
    expect(typeof (tx as WasmTransaction).id).toBe("string");
  });
});
