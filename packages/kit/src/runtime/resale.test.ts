import { describe, expect, it } from "vitest";
import { EVENT_ARTIFACT } from "../contracts/artifacts";
import { injectState } from "./address";
import {
  buildDelist,
  buildList,
  buildPurchase,
  p2pkScriptFromPubkey,
  p2shScript,
  TICKET_DUST,
} from "./builder";
import type { Outpoint } from "./covenant";
import type { ScriptPublicKey } from "./tx";
import {
  assembleDelistSigScript,
  assembleListSigScript,
  assemblePurchaseSigScript,
  listedStateAddress,
  pushI64,
  resaleSelector,
} from "./resale";

const HASH_LENGTH = 32;
const HOLDER_FILL = 0x07;
const SELLER_FILL = 0x08;
const BUYER_FILL = 0x09;
const FUNDED_UTXO_VALUE = 10_000_000_000;
const RESALE_FEE = 1_000;
const ASKING_PRICE = 150_000_000;

const NETWORK = "testnet10" as const;
const changeScript: ScriptPublicKey = { version: 0, script: "51" };

function filled(fill: number): Uint8Array {
  return new Uint8Array(HASH_LENGTH).fill(fill);
}

function outpoint(seed: number): Outpoint {
  return { txId: new Uint8Array(HASH_LENGTH).fill(seed), index: 0 };
}

const TICKET_UTXO = outpoint(0x21);
const HOLDER_UTXO = outpoint(0x22);
const BUYER_UTXO = outpoint(0x23);
const EVENT_COVENANT_ID = "cd".repeat(HASH_LENGTH);

describe("resaleSelector", () => {
  it("reads the resale entrypoints' ABI positions (list=2, purchase=3, delist=4)", () => {
    expect(resaleSelector(EVENT_ARTIFACT, "list")).toBe(2);
    expect(resaleSelector(EVENT_ARTIFACT, "purchase")).toBe(3);
    expect(resaleSelector(EVENT_ARTIFACT, "delist")).toBe(4);
  });

  it("rejects an artifact compiled without the resale entrypoints", () => {
    const stripped = { ...EVENT_ARTIFACT, abi: EVENT_ARTIFACT.abi.slice(0, 3) };
    expect(() => resaleSelector(stripped, "purchase")).toThrow(/no purchase entrypoint/);
  });
});

describe("pushI64 (rusty-kaspa add_i64 encoding)", () => {
  it("uses OP_0 / OP_N fast paths for small integers", () => {
    expect([...pushI64(0)]).toEqual([0x00]);
    expect([...pushI64(1)]).toEqual([0x51]);
    expect([...pushI64(16)]).toEqual([0x60]);
  });

  it("emits a minimal little-endian data push otherwise", () => {
    // 100_000_000 = 0x05F5E100 -> LE [00 e1 f5 05]
    expect([...pushI64(100_000_000)]).toEqual([0x04, 0x00, 0xe1, 0xf5, 0x05]);
    // top byte with the sign bit set gets a trailing zero
    expect([...pushI64(128)]).toEqual([0x02, 0x80, 0x00]);
  });

  it("rejects negative and non-integer values", () => {
    expect(() => pushI64(-1)).toThrow();
    expect(() => pushI64(1.5)).toThrow();
  });
});

describe("buildList", () => {
  const args = {
    ticketOutpoint: TICKET_UTXO,
    eventCovenantId: EVENT_COVENANT_ID,
    eventArtifact: EVENT_ARTIFACT,
    owner: filled(HOLDER_FILL),
    used: false,
    price: ASKING_PRICE,
    holderUtxos: [HOLDER_UTXO],
    holderUtxoValues: [FUNDED_UTXO_VALUE],
    changeScript,
    fee: RESALE_FEE,
  };

  it("spends the ticket back to itself with the asking price in the covenant state", () => {
    const tx = buildList(args);
    expect(tx.inputs[0]?.previousOutpoint).toEqual({
      txId: Buffer.from(TICKET_UTXO.txId).toString("hex"),
      index: 0,
    });
    expect(tx.outputs).toHaveLength(2);

    const [listed, change] = tx.outputs;
    const expectedScript = injectState(EVENT_ARTIFACT, {
      owner: filled(HOLDER_FILL),
      identifierType: 0,
      amount: 1,
      isMinter: false,
      used: false,
      salePrice: ASKING_PRICE,
    });
    expect(listed?.value).toBe(TICKET_DUST);
    expect(listed?.covenant).toEqual({ authorizingInput: 0, covenantId: EVENT_COVENANT_ID });
    expect(listed?.scriptPublicKey.script).toMatch(new RegExp(`^aa20.{64}87$`));
    // the listing's P2SH commits to the sale_price-bearing redeem
    expect(listed?.scriptPublicKey.script).toBe(p2shScript(expectedScript).script);
    expect(change?.value).toBe(FUNDED_UTXO_VALUE - RESALE_FEE);
    expect(change?.covenant).toBeNull();
  });

  it("rejects non-positive prices and unfunded holders", () => {
    expect(() => buildList({ ...args, price: 0 })).toThrow(/resale price/);
    expect(() => buildList({ ...args, price: -5 })).toThrow(/resale price/);
    expect(() =>
      buildList({ ...args, holderUtxoValues: [100], fee: RESALE_FEE }),
    ).toThrow(/cannot cover fee/);
  });
});

describe("buildDelist", () => {
  it("clears the listing back to sale_price 0", () => {
    const tx = buildDelist({
      ticketOutpoint: TICKET_UTXO,
      eventCovenantId: EVENT_COVENANT_ID,
      eventArtifact: EVENT_ARTIFACT,
      owner: filled(HOLDER_FILL),
      used: false,
      holderUtxos: [HOLDER_UTXO],
      holderUtxoValues: [FUNDED_UTXO_VALUE],
      changeScript,
      fee: RESALE_FEE,
    });
    const [unlisted] = tx.outputs;
    const expectedScript = injectState(EVENT_ARTIFACT, {
      owner: filled(HOLDER_FILL),
      identifierType: 0,
      amount: 1,
      isMinter: false,
      used: false,
      salePrice: 0,
    });
    expect(unlisted?.scriptPublicKey.script).toBe(p2shScript(expectedScript).script);
  });
});

describe("buildPurchase", () => {
  const args = {
    ticketOutpoint: TICKET_UTXO,
    eventCovenantId: EVENT_COVENANT_ID,
    eventArtifact: EVENT_ARTIFACT,
    seller: filled(SELLER_FILL),
    buyer: filled(BUYER_FILL),
    used: false,
    price: ASKING_PRICE,
    buyerUtxos: [BUYER_UTXO],
    buyerUtxoValues: [FUNDED_UTXO_VALUE],
    changeScript,
    fee: RESALE_FEE,
  };

  it("pays the seller exactly the asking price and re-keys the ticket to the buyer", () => {
    const tx = buildPurchase(args);
    expect(tx.outputs).toHaveLength(3); // ticket + seller payout + change

    const [ticket, payout, change] = tx.outputs;
    const expectedTicket = injectState(EVENT_ARTIFACT, {
      owner: filled(BUYER_FILL),
      identifierType: 0,
      amount: 1,
      isMinter: false,
      used: false,
      salePrice: 0,
    });
    expect(ticket?.scriptPublicKey.script).toBe(p2shScript(expectedTicket).script);
    expect(ticket?.covenant).toEqual({ authorizingInput: 0, covenantId: EVENT_COVENANT_ID });

    expect(payout?.value).toBe(ASKING_PRICE);
    expect(payout?.scriptPublicKey).toEqual(p2pkScriptFromPubkey(filled(SELLER_FILL)));
    expect(payout?.covenant).toBeNull();

    expect(change?.value).toBe(FUNDED_UTXO_VALUE - ASKING_PRICE - RESALE_FEE);
  });

  it("p2pkScriptFromPubkey emits `20 <x> ac`", () => {
    const script = p2pkScriptFromPubkey(filled(SELLER_FILL));
    expect(script.version).toBe(0);
    expect(script.script).toBe(`20${"08".repeat(32)}ac`);
  });

  it("rejects bad prices, short keys, and unfunded buyers", () => {
    expect(() => buildPurchase({ ...args, price: 0 })).toThrow(/resale price/);
    expect(() => buildPurchase({ ...args, seller: new Uint8Array(31) })).toThrow(/seller must be/);
    expect(() => buildPurchase({ ...args, buyer: new Uint8Array(33) })).toThrow(/buyer must be/);
    expect(() =>
      buildPurchase({ ...args, buyerUtxoValues: [ASKING_PRICE], fee: RESALE_FEE }),
    ).toThrow(/cannot cover price/);
  });
});

describe("resale sig-script assembly", () => {
  const redeem = injectState(EVENT_ARTIFACT, {
    owner: filled(HOLDER_FILL),
    identifierType: 0,
    amount: 1,
    isMinter: false,
    used: false,
    salePrice: 0,
  });
  const sig = new Uint8Array(65).fill(0x11);
  // the ~14kB redeem needs a PUSHDATA2 header (opcode + u16 LE length)
  const redeemPushLength = 3 + redeem.length;

  it("list: sig || price(i64) || selector || redeem", () => {
    const script = assembleListSigScript(EVENT_ARTIFACT, sig, ASKING_PRICE, redeem);
    const pricePush = pushI64(ASKING_PRICE);
    expect(script.length).toBe(1 + 65 + pricePush.length + 1 + redeemPushLength);
    // the minimal-LE price push sits right after the sig
    expect([...script.subarray(66, 66 + pricePush.length)]).toEqual([...pricePush]);
    expect(script[66 + pricePush.length]).toBe(0x52); // OP_2 list selector
  });

  it("delist: sig || selector || redeem", () => {
    const script = assembleDelistSigScript(EVENT_ARTIFACT, sig, redeem);
    expect(script.length).toBe(1 + 65 + 1 + redeemPushLength);
    expect(script[66]).toBe(0x54); // OP_4 delist selector right after the sig push
  });

  it("purchase: buyer_pkh || selector || redeem — no signatures at all", () => {
    const script = assemblePurchaseSigScript(EVENT_ARTIFACT, filled(BUYER_FILL), redeem);
    expect(script.length).toBe(1 + 32 + 1 + redeemPushLength);
    expect(script[33]).toBe(0x53); // OP_3 purchase selector after the 32-byte pkh push
  });

  it("rejects malformed signatures and keys", () => {
    expect(() => assembleListSigScript(EVENT_ARTIFACT, new Uint8Array(64), 1, redeem)).toThrow();
    expect(() => assemblePurchaseSigScript(EVENT_ARTIFACT, new Uint8Array(31), redeem)).toThrow();
  });
});

describe("listedStateAddress", () => {
  it("differs per asking price and from the unlisted address", () => {
    const unlisted = listedStateAddress(EVENT_ARTIFACT, filled(HOLDER_FILL), 0, NETWORK);
    const at150 = listedStateAddress(EVENT_ARTIFACT, filled(HOLDER_FILL), 150_000_000, NETWORK);
    const at200 = listedStateAddress(EVENT_ARTIFACT, filled(HOLDER_FILL), 200_000_000, NETWORK);
    expect(at150).not.toBe(unlisted);
    expect(at150).not.toBe(at200);
    expect(at150).toMatch(/^kaspatest:/);
  });
});
