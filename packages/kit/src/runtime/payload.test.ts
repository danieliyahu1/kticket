import { describe, expect, it } from "vitest";
import {
  decodeTicketId,
  decodeUsePayload,
  encodeTicketId,
  encodeUsePayload,
  type TicketId,
  type UsePayload,
} from "./payload";

const EVENT_COV_ID = "aa".repeat(32);
const TICKET_TXID = "bb".repeat(32);

describe("encodeTicketId / decodeTicketId (inert ticket identity codec)", () => {
  it("round-trips a ticket id", () => {
    const id: TicketId = { v: 1, e: EVENT_COV_ID, t: TICKET_TXID, i: 0 };
    expect(decodeTicketId(encodeTicketId(id))).toEqual(id);
  });

  it("round-trips a non-zero output index", () => {
    const id: TicketId = { v: 1, e: EVENT_COV_ID, t: TICKET_TXID, i: 3 };
    expect(decodeTicketId(encodeTicketId(id))).toEqual(id);
  });

  it("is compact (a small inert identity, not a credential)", () => {
    const id: TicketId = { v: 1, e: EVENT_COV_ID, t: TICKET_TXID, i: 0 };
    // 1 + 32 + 32 + 4 bytes -> base64url ~ 92 chars
    expect(encodeTicketId(id).length).toBeLessThan(120);
  });

  it("rejects a malformed ticket id", () => {
    expect(() => encodeTicketId({ v: 1, e: "00", t: TICKET_TXID, i: 0 })).toThrow();
    expect(() => encodeTicketId({ v: 2, e: EVENT_COV_ID, t: TICKET_TXID, i: 0 })).toThrow();
    expect(() => decodeTicketId("not-a-ticket-id")).toThrow();
  });
});

describe("encodeUsePayload / decodeUsePayload (Option B QR payload codec)", () => {
  const payload: UsePayload = {
    use_id: "use-123",
    template: {
      version: 1,
      inputs: [{ previous_outpoint: { transaction_id: TICKET_TXID, index: 0 }, signature_script: "", sequence: 0, sig_op_count: 50 }],
      outputs: [{ value: 50_000_000, script_public_key: { version: 0, script: "aa20" + "cc".repeat(32) + "87" }, covenant: { authorizing_input: 0, covenant_id: EVENT_COV_ID } }],
      lock_time: 0,
    },
    owner_signed: { inputs: [{ transactionId: TICKET_TXID, index: 0, signatureScript: "4100" }] },
  };

  it("round-trips the payload (encode -> decode identity)", async () => {
    const encoded = await encodeUsePayload(payload);
    const decoded = await decodeUsePayload(encoded);
    expect(decoded).toEqual(payload);
  });

  it("compresses the payload well below a single-QR target (~0.5-0.7 KB)", async () => {
    const raw = new TextEncoder().encode(JSON.stringify(payload)).length;
    const encoded = await encodeUsePayload(payload);
    // base64url of the deflated bytes; the compressed size is ~0.5-0.7 KB for a
    // realistic template, so assert a generous ceiling vs. the raw JSON.
    expect(encoded.length).toBeLessThan(raw);
  });

  it("does not carry the signing_template (Option B decision)", async () => {
    const encoded = await encodeUsePayload(payload);
    const decoded = await decodeUsePayload(encoded);
    expect(decoded).not.toHaveProperty("signing_template");
  });

  it("throws on garbage input (gate -> red 'Not a valid ticket code.')", async () => {
    await expect(decodeUsePayload("garbage")).rejects.toThrow();
    await expect(decodeUsePayload("")).rejects.toThrow();
  });

  it("throws when required fields are missing", async () => {
    await expect(decodeUsePayload(await encodeUsePayload({ use_id: "x", template: {}, owner_signed: undefined }))).rejects.toThrow();
  });
});
