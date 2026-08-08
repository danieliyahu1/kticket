import { describe, expect, it } from "vitest";
import { decodeBase64Wasm } from "./artifact";
import { BURN_ARTIFACT, EVENT_ARTIFACT, TICKET_ARTIFACT } from "./artifacts";
import { Covenant, eventCovenant, ticketCovenant } from "./covenant";
import type { CovenantContext, Kcc20Constants } from "./types";
import { RESULT_CODES } from "./types";
import { getWasmRuntime } from "./wasm";

const HASH_LENGTH = 32;
const EVENT_ID_BYTE = 0x11;
const ORG_SPK_BYTE = 0x22;
const BURN_HASH_BYTE = 0x33;
const ORG_BYTE = 0x01;
const ALICE_BYTE = 0xaa;
const BOB_BYTE = 0xbb;
const EVENT_CAPACITY = 5;
const DEFAULT_PRICE = 100;

/** Deterministic 32-byte key hash: all zeros with `byte` in the last position. */
function pkh(byte: number): Uint8Array {
  const bytes = new Uint8Array(HASH_LENGTH);
  bytes[HASH_LENGTH - 1] = byte;
  return bytes;
}

function constants(overrides: Partial<Kcc20Constants> = {}): Kcc20Constants {
  return {
    eventId: pkh(EVENT_ID_BYTE),
    price: DEFAULT_PRICE,
    orgSpk: pkh(ORG_SPK_BYTE),
    burnTemplateHash: pkh(BURN_HASH_BYTE),
    ...overrides,
  };
}

function mintCtx(overrides: Partial<CovenantContext> = {}): CovenantContext {
  return {
    authOutputCount: 2,
    organizerSigned: true,
    holderSigned: false,
    successorIsBurn: false,
    hasOrgPayout: true,
    ...overrides,
  };
}

function transferCtx(holderSigned: boolean): CovenantContext {
  return {
    authOutputCount: 1,
    organizerSigned: false,
    holderSigned,
    successorIsBurn: false,
    hasOrgPayout: false,
  };
}

function useCtx(overrides: Partial<CovenantContext> = {}): CovenantContext {
  return {
    authOutputCount: 1,
    organizerSigned: false,
    holderSigned: true,
    successorIsBurn: true,
    hasOrgPayout: false,
    ...overrides,
  };
}

const ORG = pkh(ORG_BYTE);
const ALICE = pkh(ALICE_BYTE);
const BOB = pkh(BOB_BYTE);

describe("artifacts", () => {
  it("event artifact exposes mint/transfer/use auth covenants (HLD v0.22 §2.1)", () => {
    expect(EVENT_ARTIFACT.name).toBe("Event");
    expect(EVENT_ARTIFACT.unspendable).toBe(false);
    expect(EVENT_ARTIFACT.contract.entrypoints).toEqual({
      mint: expect.objectContaining({ id: 0, binding: "auth", from: 1, to: 2 }),
      transfer: expect.objectContaining({ id: 1, binding: "auth", from: 1, to: 1 }),
      use: expect.objectContaining({ id: 2, binding: "auth", from: 1, to: 1 }),
    });
    expect(EVENT_ARTIFACT.contract.constantsBaked).toBe(true);
    expect(TICKET_ARTIFACT).toBe(EVENT_ARTIFACT);
  });

  it("burn artifact is unspendable with no entrypoints", () => {
    expect(BURN_ARTIFACT.name).toBe("Burn");
    expect(BURN_ARTIFACT.unspendable).toBe(true);
    expect(Object.keys(BURN_ARTIFACT.contract.entrypoints)).toHaveLength(0);
  });

  it("both artifacts decode to valid WASM", () => {
    const validate = getWasmRuntime().validate;
    expect(validate(decodeBase64Wasm(EVENT_ARTIFACT.wasmBase64))).toBe(true);
    expect(validate(decodeBase64Wasm(BURN_ARTIFACT.wasmBase64))).toBe(true);
  });
});

describe("state machine: mint (happy path and free events)", () => {
  const c = new Covenant(EVENT_ARTIFACT, constants());

  it("happy path: mint a ticket, transfer it, then consume it", () => {
    const mint = c.transition("mint", eventCovenant(ORG, 10), ALICE, mintCtx());
    expect(mint).toMatchObject({ ok: true });
    expect(mint.state).toEqual({ owner: ALICE, identifierType: 0, amount: 1, isMinter: false });

    const transfer = c.transition("transfer", ticketCovenant(ALICE), BOB, transferCtx(true));
    expect(transfer).toMatchObject({ ok: true });
    expect(transfer.state?.owner).toEqual(BOB);
    expect(transfer.state?.amount).toBe(1);

    const use = c.transition("use", ticketCovenant(BOB), new Uint8Array(0), useCtx());
    expect(use).toMatchObject({ ok: true });
    expect(use.state?.amount).toBe(1);
  });

  it("free events skip the payout requirement (FR-2)", () => {
    const free = new Covenant(EVENT_ARTIFACT, constants({ price: 0 }));
    const mint = free.transition(
      "mint",
      eventCovenant(ORG, 10),
      ALICE,
      mintCtx({ hasOrgPayout: false }),
    );
    expect(mint).toMatchObject({ ok: true });
    expect(mint.state?.owner).toEqual(ALICE);
  });
});

describe("state machine: mint validation", () => {
  const c = new Covenant(EVENT_ARTIFACT, constants());

  it("mint requires the organizer to sign (organizer authorizes the sale)", () => {
    const r = c.transition(
      "mint",
      eventCovenant(ORG, 10),
      ALICE,
      mintCtx({ organizerSigned: false }),
    );
    expect(r).toMatchObject({ ok: false, code: RESULT_CODES.ERR_SIG });
  });

  it("mint rejects an exhausted event (oversell, FR-8/27)", () => {
    const r = c.transition("mint", eventCovenant(ORG, 0), ALICE, mintCtx());
    expect(r).toMatchObject({ ok: false, code: RESULT_CODES.ERR_AMOUNT });
  });

  it("mint requires exactly two authorized outputs (ticket + remaining event)", () => {
    expect(
      c.transition("mint", eventCovenant(ORG, 10), ALICE, mintCtx({ authOutputCount: 1 })),
    ).toMatchObject({
      ok: false,
      code: RESULT_CODES.ERR_AUTH_OUTPUT,
    });
  });

  it("mint pays the organizer in the same tx when price > 0 (FR-18)", () => {
    expect(
      c.transition("mint", eventCovenant(ORG, 10), ALICE, mintCtx({ hasOrgPayout: false })),
    ).toMatchObject({ ok: false, code: RESULT_CODES.ERR_AUTH_OUTPUT });
  });
});

describe("transfer is holder-only (NFR-4)", () => {
  const c = new Covenant(EVENT_ARTIFACT, constants());

  it("non-holder cannot transfer", () => {
    const r = c.transition("transfer", ticketCovenant(ALICE), BOB, transferCtx(false));
    expect(r).toMatchObject({ ok: false, code: RESULT_CODES.ERR_SIG });
  });

  it("holder can transfer to a new owner", () => {
    const r = c.transition("transfer", ticketCovenant(ALICE), BOB, transferCtx(true));
    expect(r).toMatchObject({ ok: true, state: { owner: BOB, amount: 1 } });
  });

  it("transfer on the event covenant (amount > 1) is rejected", () => {
    const r = c.transition("transfer", eventCovenant(ORG, EVENT_CAPACITY), BOB, transferCtx(true));
    expect(r).toMatchObject({ ok: false, code: RESULT_CODES.ERR_AMOUNT });
  });
});

describe("use (handover) successor is the burn-owner (FR-9)", () => {
  const c = new Covenant(EVENT_ARTIFACT, constants());

  it("rejects a successor that is not the burn template", () => {
    const r = c.transition(
      "use",
      ticketCovenant(ALICE),
      new Uint8Array(0),
      useCtx({ successorIsBurn: false }),
    );
    expect(r).toMatchObject({ ok: false, code: RESULT_CODES.ERR_BURN_TEMPLATE });
  });

  it("only the holder can hand over", () => {
    const r = c.transition(
      "use",
      ticketCovenant(ALICE),
      new Uint8Array(0),
      useCtx({ holderSigned: false }),
    );
    expect(r).toMatchObject({ ok: false, code: RESULT_CODES.ERR_SIG });
  });

  it("handover on the event covenant is rejected", () => {
    const r = c.transition("use", eventCovenant(ORG, EVENT_CAPACITY), new Uint8Array(0), useCtx());
    expect(r).toMatchObject({ ok: false, code: RESULT_CODES.ERR_AMOUNT });
  });
});

describe("rules freeze at deploy (FR-7)", () => {
  it("constants are immutable after deployment", () => {
    const c = new Covenant(EVENT_ARTIFACT, constants({ price: DEFAULT_PRICE }));
    expect(Object.isFrozen(c.constants)).toBe(true);
    expect(() => {
      (c.constants as { price: number }).price = 0;
    }).toThrow();
    expect(c.constants.price).toBe(DEFAULT_PRICE);
  });

  it("price is baked at deploy and stable across transitions", () => {
    const c = new Covenant(EVENT_ARTIFACT, constants({ price: DEFAULT_PRICE }));
    c.transition("mint", eventCovenant(ORG, 10), ALICE, mintCtx({ hasOrgPayout: true }));
    c.transition("transfer", ticketCovenant(ALICE), BOB, transferCtx(true));
    c.transition("use", ticketCovenant(BOB), new Uint8Array(0), useCtx());
    expect(c.constants.price).toBe(DEFAULT_PRICE);
  });
});

describe("burn covenant is unspendable and contention-free", () => {
  it("any spend attempt on the burn covenant fails (unspendable)", () => {
    const burn = new Covenant(BURN_ARTIFACT, constants());
    expect(
      burn.transition("use", ticketCovenant(ALICE), new Uint8Array(0), useCtx()),
    ).toMatchObject({
      ok: false,
      code: RESULT_CODES.ERR_UNSPENDABLE,
    });
  });

  it("concurrent handovers never contend on one UTXO (no shared counter)", () => {
    const a = new Covenant(EVENT_ARTIFACT, constants());
    const b = new Covenant(EVENT_ARTIFACT, constants());
    const handoverA = a.transition("use", ticketCovenant(ALICE), new Uint8Array(0), useCtx());
    const handoverB = b.transition("use", ticketCovenant(BOB), new Uint8Array(0), useCtx());
    expect(handoverA).toMatchObject({ ok: true });
    expect(handoverB).toMatchObject({ ok: true });
  });
});

describe("edge cases", () => {
  const c = new Covenant(EVENT_ARTIFACT, constants());

  it("unknown entrypoint is rejected", () => {
    const r = c.transition("resell" as "use", ticketCovenant(ALICE), new Uint8Array(0), useCtx());
    expect(r).toMatchObject({ ok: false, code: RESULT_CODES.ERR_FUNCTION });
  });

  it("wrong burn template at handover is rejected", () => {
    const wrong = c.transition(
      "use",
      ticketCovenant(ALICE),
      new Uint8Array(0),
      useCtx({ successorIsBurn: false }),
    );
    expect(wrong).toMatchObject({ ok: false, code: RESULT_CODES.ERR_BURN_TEMPLATE });
  });
});
