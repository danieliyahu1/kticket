import { encodeUsePayload, type UsePayload } from "@kticket/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client", () => ({
  useSignTemplate: vi.fn(),
  useFinalize: vi.fn(),
  ServerError: class ServerError extends Error {},
}));

vi.mock("../lib/signing", () => ({
  signTemplate: vi.fn(),
}));

import { ServerError, useFinalize, useSignTemplate } from "./client";
import { signTemplate } from "../lib/signing";
import {
  coSignAndFinalize,
  decodeError,
  decodeGatePayload,
  errorMsg,
  isDecodeFailure,
  isForEvent,
  prepareGateCheck,
} from "./gate-machine";

const COVENANT_ID = "aa".repeat(32);
const TICKET_TXID = "bb".repeat(32);

const payload: UsePayload = {
  use_id: "use-123",
  template: {
    version: 1,
    inputs: [
      {
        previous_outpoint: { transaction_id: TICKET_TXID, index: 0 },
        signature_script: "",
        sequence: 0,
        sig_op_count: 50,
      },
    ],
    outputs: [
      {
        value: 50_000_000,
        script_public_key: { version: 0, script: "aa20" + "cc".repeat(32) + "87" },
        covenant: { authorizing_input: 0, covenant_id: COVENANT_ID },
      },
    ],
    lock_time: 0,
  },
  owner_signed: { inputs: [{ transactionId: TICKET_TXID, index: 0, signatureScript: "4100" }] },
};

const PARAMS = { covenantId: COVENANT_ID, eventName: "Testnet Rave" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("decodeGatePayload (KTK-130)", () => {
  it("decodes a valid compressed payload QR", async () => {
    const encoded = await encodeUsePayload(payload);
    await expect(decodeGatePayload(encoded)).resolves.toEqual(payload);
  });

  it("throws on garbage → the door maps it to red 'Not a valid ticket code.'", async () => {
    await expect(decodeGatePayload("garbage")).rejects.toThrow();
    expect(decodeError()).toBe("Not a valid ticket code.");
  });

  it("classifies codec failures as decode failures (not server outages)", async () => {
    expect(isDecodeFailure(new Error("invalid use payload"))).toBe(true);
    expect(isDecodeFailure(new ServerError())).toBe(false);
  });
});

describe("prepareGateCheck (KTK-130)", () => {
  it("derives the ticket id from the template input 0 and rebuilds the signing template", async () => {
    vi.mocked(useSignTemplate).mockResolvedValue({ signing_template: "{}" });
    const result = await prepareGateCheck(payload, PARAMS);
    expect(useSignTemplate).toHaveBeenCalledWith(`${TICKET_TXID}:0`, payload.template);
    expect(result).toEqual({ ticket: `${TICKET_TXID}:0`, event: "Testnet Rave" });
  });

  it("surfaces a server outage as red 'No connection…'", async () => {
    vi.mocked(useSignTemplate).mockRejectedValue(new ServerError());
    await expect(prepareGateCheck(payload, PARAMS)).rejects.toThrow();
    expect(errorMsg(new ServerError())).toBe("No connection — handover can't complete.");
  });

  it("rejects a ticket from a different event before the dialog (KTK-131)", async () => {
    await expect(
      prepareGateCheck(payload, { covenantId: "ff".repeat(32), eventName: "Other" }),
    ).rejects.toThrow("This ticket is for a different event.");
    expect(useSignTemplate).not.toHaveBeenCalled();
  });
});

describe("isForEvent (KTK-131)", () => {
  it("accepts a ticket whose covenant output matches the gate's event", () => {
    expect(isForEvent(payload, COVENANT_ID)).toBe(true);
  });

  it("rejects a ticket bound to another event's covenant family", () => {
    expect(isForEvent(payload, "ff".repeat(32))).toBe(false);
  });

  it("rejects a payload with no covenant output", () => {
    const plain = {
      ...payload,
      template: { ...(payload.template as object), outputs: [] },
    };
    expect(isForEvent(plain, COVENANT_ID)).toBe(false);
  });
});

describe("coSignAndFinalize (KTK-131)", () => {
  it("co-signs the rebuilt template and relays both signatures via finalize", async () => {
    vi.mocked(useSignTemplate).mockResolvedValue({ signing_template: "{}" });
    vi.mocked(signTemplate).mockResolvedValue({ inputs: [{ index: 0, signatureScript: "41aa" }] });
    vi.mocked(useFinalize).mockResolvedValue({ txid: "dd".repeat(32) });

    const result = await coSignAndFinalize(payload);

    expect(signTemplate).toHaveBeenCalledWith("{}", [{ inputIndex: 0 }]);
    expect(useFinalize).toHaveBeenCalledWith(`${TICKET_TXID}:0`, {
      use_id: payload.use_id,
      template: payload.template,
      owner_signed: payload.owner_signed,
      gate_signed: { inputs: [{ index: 0, signatureScript: "41aa" }] },
    });
    expect(result).toEqual({ txid: "dd".repeat(32) });
  });

  it("surfaces a signing failure as red", async () => {
    vi.mocked(useSignTemplate).mockResolvedValue({ signing_template: "{}" });
    vi.mocked(signTemplate).mockRejectedValue(new Error("User rejected"));
    await expect(coSignAndFinalize(payload)).rejects.toThrow("User rejected");
  });
});
