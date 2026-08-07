import { describe, expect, it } from "vitest";

const WASM = (await import("../vendor/kaspa-wasm/kaspa.js")) as {
  Transaction: new (
    init: unknown,
  ) => {
    outputs: Array<{ covenant?: { authorizingInput: number; covenantId: string } }>;
    readonly id: string;
  };
};

describe("wrpc-client transaction construction (KTK-29)", () => {
  it("builds a v1 transaction with covenant bindings from the wire template", () => {
    const tx = new WASM.Transaction({
      version: 1,
      inputs: [
        {
          previousOutpoint: { transactionId: "aa".repeat(32), index: 0 },
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
          covenant: { authorizingInput: 0, covenantId: "bb".repeat(32) },
        },
      ],
      lockTime: 0n,
      subnetworkId: "0000000000000000000000000000000000000000",
      gas: 0n,
      payload: "",
    });

    // The wasm Transaction carries the covenant binding on the ticket output.
    const covenant = tx.outputs[0]?.covenant;
    expect(JSON.parse(JSON.stringify(covenant))).toEqual({
      authorizingInput: 0,
      covenantId: "bb".repeat(32),
    });
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
