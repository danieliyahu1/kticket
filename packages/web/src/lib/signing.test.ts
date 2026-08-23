import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signTemplate } from "./signing";

const X_ONLY_P2PK = `20${"ab".repeat(32)}ac`;
const SCRIPT_LOCK = "beefcafe";

/** Two inputs: 0 = covenant/script-locked ticket input, 1 = plain P2PK fee input. */
const TEMPLATE = JSON.stringify({
  version: 0,
  inputs: [
    {
      previousOutpoint: { transactionId: "aa".repeat(32), index: 0 },
      signatureScript: "",
      utxo: { scriptPublicKey: { version: 0, script: SCRIPT_LOCK }, amount: "1000" },
    },
    {
      previousOutpoint: { transactionId: "bb".repeat(32), index: 1 },
      signatureScript: "",
      utxo: { scriptPublicKey: { version: 0, script: X_ONLY_P2PK }, amount: "2000" },
    },
  ],
  outputs: [],
});

function signedResult(inputs: Record<string, unknown>[]): string {
  return JSON.stringify({ id: "0".repeat(64), version: 0, inputs, outputs: [] });
}

function stubWallet(signResult: string | object) {
  const signTx = vi.fn().mockResolvedValue(signResult);
  vi.stubGlobal("window", { kastle: { signTx } });
  return signTx;
}

describe("signTemplate — Kastle signTx adapter", () => {
  let logs: string[];
  let warns: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logs = [];
    warns = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });
    warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args.join(" "));
    });
    stubWallet(signedResult([]));
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("passes the expected network id and template to signTx", async () => {
    const signTx = stubWallet(signedResult([]));
    await signTemplate(TEMPLATE);
    expect(signTx).toHaveBeenCalledWith("testnet-10", TEMPLATE, undefined);
  });

  it("forwards per-input script overrides to signTx", async () => {
    const signTx = stubWallet(signedResult([]));
    await signTemplate(TEMPLATE, [{ inputIndex: 0 }]);
    expect(signTx).toHaveBeenCalledWith("testnet-10", TEMPLATE, [{ inputIndex: 0 }]);
  });

  it("returns whatever the wallet signed", async () => {
    const signed = signedResult([]);
    expect(await signTemplate(TEMPLATE)).toBe(signed);
  });

  it("throws when Kastle is not available", async () => {
    vi.stubGlobal("window", {});
    await expect(signTemplate(TEMPLATE)).rejects.toThrow("Kastle wallet not available");
  });

  it("throws when the wallet has no signTx", async () => {
    vi.stubGlobal("window", { kastle: {} });
    await expect(signTemplate(TEMPLATE)).rejects.toThrow("Kastle wallet not available");
  });

  it("throws when signing template is empty", async () => {
    await expect(signTemplate(null)).rejects.toThrow("No signing template from build");
  });
});

describe("signTemplate — assumption diagnostics", () => {
  let logs: string[];
  let warns: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logs = [];
    warns = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });
    warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args.join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("reports which inputs were classified and signed", async () => {
    stubWallet(
      signedResult([
        {
          previousOutpoint: { transactionId: "aa".repeat(32), index: 0 },
          signatureScript: "41" + "cd".repeat(64),
        },
        {
          previousOutpoint: { transactionId: "bb".repeat(32), index: 1 },
          signatureScript: "41" + "ef".repeat(64),
        },
      ]),
    );
    await signTemplate(TEMPLATE);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("inputs=[0:script 1:p2pk]"),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("0:script:signed"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("co-signing works"));
  });

  it("warns loudly when a covenant input comes back unsigned", async () => {
    stubWallet(
      signedResult([
        {
          previousOutpoint: { transactionId: "aa".repeat(32), index: 0 },
          signatureScript: "",
        },
      ]),
    );
    await signTemplate(TEMPLATE);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/script\/covenant input 0 .*UNSIGNED/),
    );
  });

  it("accepts an object-shaped result with a txJson field", async () => {
    stubWallet({
      txJson: signedResult([
        {
          previousOutpoint: { transactionId: "aa".repeat(32), index: 0 },
          signatureScript: "41ff",
        },
      ]),
    });
    await signTemplate(TEMPLATE);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("0:script:signed"));
  });

  it("stays silent about unsigned p2pk inputs but shows their status", async () => {
    stubWallet(
      signedResult([
        {
          previousOutpoint: { transactionId: "aa".repeat(32), index: 0 },
          signatureScript: "41" + "cd".repeat(64),
        },
      ]),
    );
    await signTemplate(TEMPLATE);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("1:p2pk:UNSIGNED"));
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringMatching(/input 1/));
  });

  it("does not throw when the result shape is unrecognizable", async () => {
    stubWallet({ something: 42 });
    await expect(signTemplate(TEMPLATE)).resolves.toEqual({ something: 42 });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("could not inspect"));
  });

  it("does not throw when the template is not valid JSON", async () => {
    stubWallet(signedResult([]));
    await expect(signTemplate("{broken")).resolves.toBeDefined();
  });

  it("keeps outpoints and amounts out of the logs", async () => {
    stubWallet(
      signedResult([
        {
          previousOutpoint: { transactionId: "aa".repeat(32), index: 0 },
          signatureScript: "41ff",
        },
      ]),
    );
    await signTemplate(TEMPLATE);
    const all = [...logs, ...warns].join("\n");
    expect(all).not.toContain("aa".repeat(32));
    expect(all).not.toContain("1000");
  });
});
