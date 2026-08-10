import { beforeEach, describe, expect, it, vi } from "vitest";
import { signTemplate } from "./signing";

const SIGNED_JSON = '{"id":"test","version":1,"inputs":[{"transactionId":"aa","index":0,"signatureScript":"41abcd"},{"transactionId":"bb","index":1,"signatureScript":"41ef01"}],"outputs":[],"lockTime":"0"}';

function fakeSignPskt(args: { txJsonString: string; options?: { signInputs?: { index: number }[] } }): string {
  return JSON.stringify({ _args: args });
}

describe("signTemplate — signInputs exclusion (Bug: covenant input was signed)", () => {
  beforeEach(() => {
    const kasware = {
      signPskt: vi.fn().mockImplementation(fakeSignPskt),
    };
    vi.stubGlobal("window", { kasware });
  });

  it("passes signInputs to signPskt when provided", async () => {
    const result = await signTemplate(SIGNED_JSON, [{ index: 1 }]);
    const parsed = JSON.parse(result as string);
    expect(parsed._args.options.signInputs).toEqual([{ index: 1 }]);
  });

  it("does not pass options when signInputs is not provided", async () => {
    const result = await signTemplate(SIGNED_JSON);
    const parsed = JSON.parse(result as string);
    expect(parsed._args.options).toBeUndefined();
  });

  it("throws when signPskt is not available", async () => {
    vi.stubGlobal("window", {});
    await expect(signTemplate(SIGNED_JSON)).rejects.toThrow("Kasware wallet not available");
  });

  it("throws when signing template is empty", async () => {
    await expect(signTemplate(null)).rejects.toThrow("No signing template from build");
  });
});
