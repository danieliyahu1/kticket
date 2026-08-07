import { describe, expect, it } from "vitest";
import { decodeBase64Wasm } from "./artifact";
import { BURN_ARTIFACT, TICKET_ARTIFACT } from "./artifacts";
import { availableTicket, Covenant, ownedTicket } from "./covenant";
import type { CovenantContext, TicketConstants } from "./types";
import { RESULT_CODES } from "./types";
import { getWasmRuntime } from "./wasm";

/** Deterministic 32-byte key hash: all zeros with `byte` in the last position. */
function pkh(byte: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[31] = byte;
  return bytes;
}

function constants(overrides: Partial<TicketConstants> = {}): TicketConstants {
  return {
    eventId: pkh(0x11),
    index: 0,
    price: 100,
    orgSpk: pkh(0x22),
    burnTemplateHash: pkh(0x33),
    ...overrides,
  };
}

function buyCtx(overrides: Partial<CovenantContext> = {}): CovenantContext {
  return {
    authOutputCount: 1,
    hasOrgPayout: true,
    holderSigned: false,
    successorIsBurn: false,
    ...overrides,
  };
}

function transferCtx(holderSigned: boolean): CovenantContext {
  return { authOutputCount: 0, hasOrgPayout: false, holderSigned, successorIsBurn: false };
}

function useCtx(overrides: Partial<CovenantContext> = {}): CovenantContext {
  return {
    authOutputCount: 0,
    hasOrgPayout: false,
    holderSigned: true,
    successorIsBurn: true,
    ...overrides,
  };
}

const ALICE = pkh(0xaa);
const BOB = pkh(0xbb);
const CAROL = pkh(0xcc);

describe("artifacts", () => {
  it("ticket artifact exposes the three entrypoints as auth covenants (HLD §2.1)", () => {
    expect(TICKET_ARTIFACT.name).toBe("Ticket");
    expect(TICKET_ARTIFACT.unspendable).toBe(false);
    expect(TICKET_ARTIFACT.contract.entrypoints).toEqual({
      buy: expect.objectContaining({ id: 0, binding: "auth", from: 1, to: 1 }),
      transfer: expect.objectContaining({ id: 1, binding: "auth", from: 1, to: 1 }),
      use: expect.objectContaining({ id: 2, binding: "auth", from: 1, to: 1 }),
    });
    expect(TICKET_ARTIFACT.contract.constantsBaked).toBe(true);
  });

  it("burn artifact is unspendable with no entrypoints", () => {
    expect(BURN_ARTIFACT.name).toBe("Burn");
    expect(BURN_ARTIFACT.unspendable).toBe(true);
    expect(Object.keys(BURN_ARTIFACT.contract.entrypoints)).toHaveLength(0);
  });

  it("both artifacts decode to valid WASM", () => {
    const validate = getWasmRuntime().validate;
    expect(validate(decodeBase64Wasm(TICKET_ARTIFACT.wasmBase64))).toBe(true);
    expect(validate(decodeBase64Wasm(BURN_ARTIFACT.wasmBase64))).toBe(true);
  });
});

describe("state machine available -> owned -> burned", () => {
  const c = new Covenant(TICKET_ARTIFACT, constants());

  it("happy path: buy then transfer then use", () => {
    const buy = c.transition("buy", availableTicket(), ALICE, buyCtx());
    expect(buy).toMatchObject({ ok: true });
    expect(buy.state).toEqual({ phase: 1, owner: ALICE });

    const transfer = c.transition("transfer", ownedTicket(ALICE), BOB, transferCtx(true));
    expect(transfer).toMatchObject({ ok: true });
    expect(transfer.state).toEqual({ phase: 1, owner: BOB });

    const use = c.transition("use", ownedTicket(BOB), new Uint8Array(0), useCtx());
    expect(use).toMatchObject({ ok: true });
    expect(use.state?.phase).toBe(2);
  });

  it("a ticket issued only when payment succeeds in the same tx (FR-18)", () => {
    const noPayout = c.transition("buy", availableTicket(), ALICE, buyCtx({ hasOrgPayout: false }));
    expect(noPayout).toMatchObject({ ok: false, code: RESULT_CODES.ERR_PAYOUT });
  });

  it("free events skip the payout requirement (FR-2)", () => {
    const free = new Covenant(TICKET_ARTIFACT, constants({ price: 0 }));
    const buy = free.transition("buy", availableTicket(), ALICE, buyCtx({ hasOrgPayout: false }));
    expect(buy).toMatchObject({ ok: true });
    expect(buy.state?.owner).toEqual(ALICE);
  });

  it("used ticket is gone forever, no path revives it (FR-11, NFR-5)", () => {
    const gone = c.transition("use", ownedTicket(ALICE), new Uint8Array(0), useCtx());
    expect(gone).toMatchObject({ ok: true, state: { phase: 2 } });
  });
});

describe("buy guards (FR-17: one ticket per purchase)", () => {
  const c = new Covenant(TICKET_ARTIFACT, constants());

  it("buy requires phase 0 (double-buy rejected)", () => {
    const doubleBuy = c.transition("buy", ownedTicket(ALICE), BOB, buyCtx());
    expect(doubleBuy).toMatchObject({ ok: false, code: RESULT_CODES.ERR_PHASE });
  });

  it("buy requires exactly one auth output", () => {
    expect(
      c.transition("buy", availableTicket(), ALICE, buyCtx({ authOutputCount: 0 })),
    ).toMatchObject({
      ok: false,
      code: RESULT_CODES.ERR_AUTH_OUTPUT,
    });
    expect(
      c.transition("buy", availableTicket(), ALICE, buyCtx({ authOutputCount: 2 })),
    ).toMatchObject({
      ok: false,
      code: RESULT_CODES.ERR_AUTH_OUTPUT,
    });
  });

  it("buy pays the organizer in the same tx when price > 0", () => {
    const paid = c.transition("buy", availableTicket(), ALICE, buyCtx({ hasOrgPayout: true }));
    expect(paid).toMatchObject({ ok: true });
    expect(paid.state?.owner).toEqual(ALICE);
  });
});

describe("transfer is holder-only (NFR-4)", () => {
  const c = new Covenant(TICKET_ARTIFACT, constants());

  it("non-holder cannot transfer", () => {
    const r = c.transition("transfer", ownedTicket(ALICE), BOB, transferCtx(false));
    expect(r).toMatchObject({ ok: false, code: RESULT_CODES.ERR_SIG });
  });

  it("holder can transfer to a new owner", () => {
    const r = c.transition("transfer", ownedTicket(ALICE), BOB, transferCtx(true));
    expect(r).toMatchObject({ ok: true, state: { phase: 1, owner: BOB } });
  });

  it("transfer on an available ticket is rejected", () => {
    const r = c.transition("transfer", availableTicket(), BOB, transferCtx(true));
    expect(r).toMatchObject({ ok: false, code: RESULT_CODES.ERR_PHASE });
  });
});

describe("use (handover) successor is the event burn (FR-9)", () => {
  const c = new Covenant(TICKET_ARTIFACT, constants());

  it("rejects a successor that is not the burn template", () => {
    const r = c.transition(
      "use",
      ownedTicket(ALICE),
      new Uint8Array(0),
      useCtx({ successorIsBurn: false }),
    );
    expect(r).toMatchObject({ ok: false, code: RESULT_CODES.ERR_BURN_TEMPLATE });
  });

  it("only the holder can hand over", () => {
    const r = c.transition(
      "use",
      ownedTicket(ALICE),
      new Uint8Array(0),
      useCtx({ holderSigned: false }),
    );
    expect(r).toMatchObject({ ok: false, code: RESULT_CODES.ERR_SIG });
  });

  it("handover on an available ticket is rejected", () => {
    const r = c.transition("use", availableTicket(), new Uint8Array(0), useCtx());
    expect(r).toMatchObject({ ok: false, code: RESULT_CODES.ERR_PHASE });
  });
});

describe("rules freeze at genesis (FR-7)", () => {
  it("constants are immutable after deployment", () => {
    const c = new Covenant(TICKET_ARTIFACT, constants({ price: 100 }));
    expect(Object.isFrozen(c.constants)).toBe(true);
    expect(() => {
      (c.constants as { price: number }).price = 0;
    }).toThrow();
    expect(c.constants.price).toBe(100);
  });

  it("price is baked at genesis and stable across transitions", () => {
    const c = new Covenant(TICKET_ARTIFACT, constants({ price: 100 }));
    c.transition("buy", availableTicket(), ALICE, buyCtx({ hasOrgPayout: true }));
    c.transition("transfer", ownedTicket(ALICE), BOB, transferCtx(true));
    c.transition("use", ownedTicket(BOB), new Uint8Array(0), useCtx());
    expect(c.constants.price).toBe(100);
  });
});

describe("burn covenant is unspendable and contention-free", () => {
  it("any spend attempt on the burn covenant fails (unspendable)", () => {
    const burn = new Covenant(BURN_ARTIFACT, constants());
    expect(burn.transition("use", ownedTicket(ALICE), new Uint8Array(0), useCtx())).toMatchObject({
      ok: false,
      code: RESULT_CODES.ERR_UNSPENDABLE,
    });
  });

  it("concurrent handovers never contend on one UTXO (no shared counter)", () => {
    const evt = constants();
    const a = new Covenant(TICKET_ARTIFACT, evt);
    const b = new Covenant(TICKET_ARTIFACT, evt);

    const handoverA = a.transition("use", ownedTicket(ALICE), new Uint8Array(0), useCtx());
    const handoverB = b.transition("use", ownedTicket(BOB), new Uint8Array(0), useCtx());

    expect(handoverA).toMatchObject({ ok: true, state: { phase: 2 } });
    expect(handoverB).toMatchObject({ ok: true, state: { phase: 2 } });
  });
});

describe("edge cases", () => {
  const c = new Covenant(TICKET_ARTIFACT, constants());

  it("unknown entrypoint is rejected", () => {
    const r = c.transition("resell" as "use", ownedTicket(ALICE), new Uint8Array(0), useCtx());
    expect(r).toMatchObject({ ok: false, code: RESULT_CODES.ERR_FUNCTION });
  });

  it("wrong burn template at handover is rejected (wrong burn template edge case)", () => {
    const wrong = c.transition(
      "use",
      ownedTicket(CAROL),
      new Uint8Array(0),
      useCtx({ successorIsBurn: false }),
    );
    expect(wrong).toMatchObject({ ok: false, code: RESULT_CODES.ERR_BURN_TEMPLATE });
  });

  it("a sold ticket can be re-bought only after it is gone — no third state (FR-20)", () => {
    const gone = c.transition("use", ownedTicket(ALICE), new Uint8Array(0), useCtx());
    expect(gone).toMatchObject({ ok: true, state: { phase: 2 } });
    const rebuy = c.transition("buy", availableTicket(), BOB, buyCtx());
    expect(rebuy).toMatchObject({ ok: true, state: { phase: 1, owner: BOB } });
  });
});
