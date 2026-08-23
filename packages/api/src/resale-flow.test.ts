// Whole-issue integration tests for KTK-151 (trustless resale).
//
// Three black-box flows through the API over a seeded FakeKaspa:
//
//   list      holder prepare → holder signs ALL inputs → finalize assembles
//             input 0's sig-script, proves the listed-state commitment and
//             records the listing in the index.
//   delist    holder prepare (index + chain must agree) → sign → finalize
//             clears back to the unlisted address and drops the index row.
//   purchase  ANYONE prepares (no seller online); input 0 arrives pre-stamped,
//             the buyer signs only their fee inputs; finalize relays and clears
//             the index. The chain — not the API's index — is proven first.
//
// The listings directory is also tested against stale rows: an entry whose
// recorded price no longer matches the chain is hidden, never served.

import {
  assembleDelistSigScript,
  assembleListSigScript,
  assembleMarkUsedSigScript,
  assemblePurchaseSigScript,
  injectState,
  p2pkAddress,
  p2shScript,
} from "@kticket/kit";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HTTP_BAD_REQUEST, HTTP_NOT_FOUND, HTTP_OK, HTTP_UNPROCESSABLE_ENTITY } from "./http-status.js";
import { ListingStoreFile } from "./listings";
import {
  B0_ID,
  EVENT_DATE,
  EVENT_NAME,
  FakeKaspa,
  NETWORK,
  OWNER_ADDRESS,
  OWNER_PUBKEY_HEX,
  TICKET_ID,
  TEST_COVENANT_ID,
  USED_TXID,
  buyTx,
  buildAppWith,
  eventArtifact,
  seedBaseChain,
} from "./test-chain";

vi.mock("./wrpc-client.js", () => ({
  submitTransactionOverWrpc: vi.fn(),
}));

import { submitTransactionOverWrpc } from "./wrpc-client.js";

const mockedSubmit = vi.mocked(submitTransactionOverWrpc);

const LIST_PRICE = 150_000_000;
const LIST_TXID = "cc".repeat(32);
const BUYER_PKH_HEX = "04".repeat(32);
const BUYER_PUBKEY_HEX = `02${BUYER_PKH_HEX}`;
const BUYER_ADDRESS = p2pkAddress(hexToBytes(BUYER_PKH_HEX), NETWORK);
const BUYER_UTXO_TXID = "d1".repeat(32);
const LISTED_TICKET_ID = `${LIST_TXID}:0`;

function redeemState(ownerHex: string, salePrice: number) {
  return injectState(eventArtifact(), {
    owner: hexToBytes(ownerHex),
    identifierType: 0,
    amount: 1,
    isMinter: false,
    used: false,
    salePrice,
  });
}

/** The ticket value the mint produced (the listed UTXO carries the same). */
function ticketValue(): number {
  return buyTx().outputs[0]?.amount ?? 0;
}

/** A fake post-list tx: the ticket re-points at the listed-state address. */
function listTx(price: number) {
  const sellerPkh = "02".repeat(32);
  const listed = p2shScript(redeemState(sellerPkh, price)).script;
  return {
    transaction_id: LIST_TXID,
    inputs: [],
    outputs: [
      {
        transaction_id: LIST_TXID,
        index: 0,
        amount: ticketValue(),
        script_public_key: listed,
        covenant_authorizing_input: null,
        covenant_id: TEST_COVENANT_ID,
      },
      {
        transaction_id: LIST_TXID,
        index: 1,
        amount: 500_000_000,
        script_public_key: `20${sellerPkh}ac`,
        covenant_authorizing_input: null,
        covenant_id: null,
      },
    ],
  };
}

function seedBuyerFunds(kaspa: FakeKaspa): void {
  kaspa.transactions.set(BUYER_UTXO_TXID, {
    transaction_id: BUYER_UTXO_TXID,
    accepting_block_blue_score: 100,
    inputs: [],
    outputs: [
      {
        transaction_id: BUYER_UTXO_TXID,
        index: 0,
        amount: 2_000_000_000,
        script_public_key: `20${BUYER_PKH_HEX}ac`,
      },
    ],
  });
  kaspa.utxoMap.set(BUYER_ADDRESS, [
    {
      address: BUYER_ADDRESS,
      outpoint: { transactionId: BUYER_UTXO_TXID, index: 0 },
      utxoEntry: {
        amount: String(2_000_000_000),
        scriptPublicKey: { scriptPublicKey: `20${BUYER_PKH_HEX}ac` },
        blockDaaScore: "100",
        isCoinbase: false,
      },
    },
  ]);
}

/** Chain where the ticket already sits on the listed-state address at `price`. */
function seedListedChain(kaspa: FakeKaspa, price = LIST_PRICE): void {
  seedBaseChain(kaspa);
  kaspa.transactions.set(LIST_TXID, listTx(price));
}

async function storeListing(store: ListingStoreFile): Promise<void> {
  await store.upsert({
    covenantId: TEST_COVENANT_ID,
    ticketId: LISTED_TICKET_ID,
    sellerPkh: "02".repeat(32),
    price: LIST_PRICE,
  });
}

/** The seller's wallet output for a template with N inputs. */
function signedInputs(template: {
  inputs: { previous_outpoint: { transaction_id: string; index: number } }[];
}, sigSeed: string) {
  return {
    inputs: template.inputs.map((input) => ({
      transactionId: input.previous_outpoint.transaction_id,
      index: input.previous_outpoint.index,
      signatureScript: `41${sigSeed.repeat(65)}`,
    })),
  };
}

describe("resale flow end-to-end (KTK-151)", () => {
  beforeEach(() => {
    mockedSubmit.mockReset();
    mockedSubmit.mockResolvedValue(USED_TXID);
  });

  describe("list", () => {
    it("prepare builds a signing template over every input", async () => {
      const kaspa = new FakeKaspa();
      seedBaseChain(kaspa);
      const app = await buildAppWith(kaspa);

      const prepare = await app.inject({
        method: "POST",
        url: `/v1/tickets/${TICKET_ID}/list/prepare`,
        payload: { publicKey: OWNER_PUBKEY_HEX, address: OWNER_ADDRESS, price: LIST_PRICE },
      });
      expect(prepare.statusCode).toBe(HTTP_OK);
      const body = prepare.json();
      expect(body.price).toBe(LIST_PRICE);
      expect(body.event).toEqual({ name: EVENT_NAME, date: EVENT_DATE });
      expect(body.sign_inputs).toEqual([{ index: 0 }, { index: 1 }]);
      // Input 0 spends the requested ticket; the fee input is the owner's.
      expect(body.template.inputs[0].previous_outpoint).toEqual({
        transaction_id: B0_ID,
        index: 0,
      });
      await app.close();
    });

    it("finalize assembles the list sig-script and indexes a proven listing", async () => {
      const kaspa = new FakeKaspa();
      seedBaseChain(kaspa);
      // The mocked broadcast "confirms" instantly: seed the accepted listing
      // tx so waitForTransaction + the directory's chain re-check see it.
      kaspa.transactions.set(USED_TXID, listTx(LIST_PRICE));
      const app = await buildAppWith(kaspa);

      const prepare = await app.inject({
        method: "POST",
        url: `/v1/tickets/${TICKET_ID}/list/prepare`,
        payload: { publicKey: OWNER_PUBKEY_HEX, address: OWNER_ADDRESS, price: LIST_PRICE },
      });
      const prepared = prepare.json();

      const finalize = await app.inject({
        method: "POST",
        url: `/v1/tickets/${TICKET_ID}/list/finalize`,
        payload: {
          template: prepared.template,
          signed: signedInputs(prepared.template, "aa"),
          price: LIST_PRICE,
        },
      });
      expect(finalize.statusCode).toBe(HTTP_OK);
      expect(finalize.json()).toEqual({ txid: USED_TXID });

      // Input 0's script is pure kit assembly — byte-exact with the golden VM.
      const broadcastArg = mockedSubmit.mock.calls[0]?.[1] as {
        inputs: { signature_script: string }[];
      };
      const expected = bytesToHex(
        assembleListSigScript(
          eventArtifact(),
          hexToBytes(`41${"aa".repeat(65)}`).slice(1),
          LIST_PRICE,
          redeemState("02".repeat(32), 0),
        ),
      );
      expect(broadcastArg.inputs[0]?.signature_script).toBe(expected);

      // The directory proves the listing at its NEW outpoint (<final txid>:0).
      const directory = await app.inject({
        method: "GET",
        url: `/v1/events/${TEST_COVENANT_ID}/listings`,
      });
      expect(directory.statusCode).toBe(HTTP_OK);
      expect(directory.json()).toEqual([
        {
          ticket_id: `${USED_TXID}:0`,
          price: LIST_PRICE,
          seller_pkh: "02".repeat(32),
          event_name: EVENT_NAME,
          event_date: EVENT_DATE,
          covenant_id: TEST_COVENANT_ID,
          verified: true,
        },
      ]);

      await app.close();
    });

    it("rejects a caller who owns no unlisted ticket (422)", async () => {
      const kaspa = new FakeKaspa();
      seedBaseChain(kaspa);
      const app = await buildAppWith(kaspa);

      const prepare = await app.inject({
        method: "POST",
        url: `/v1/tickets/${TICKET_ID}/list/prepare`,
        payload: { publicKey: BUYER_PUBKEY_HEX, address: BUYER_ADDRESS, price: LIST_PRICE },
      });
      expect(prepare.statusCode).toBe(HTTP_UNPROCESSABLE_ENTITY);
      expect(prepare.json().error.message).toContain("no unlisted ticket");
      await app.close();
    });

    it("rejects a non-positive price (400)", async () => {
      const kaspa = new FakeKaspa();
      seedBaseChain(kaspa);
      const app = await buildAppWith(kaspa);

      const prepare = await app.inject({
        method: "POST",
        url: `/v1/tickets/${TICKET_ID}/list/prepare`,
        payload: { publicKey: OWNER_PUBKEY_HEX, address: OWNER_ADDRESS, price: 0 },
      });
      expect(prepare.statusCode).toBe(HTTP_BAD_REQUEST);
      await app.close();
    });
  });

  describe("delist", () => {
    async function preparedDelist(kaspa: FakeKaspa, store: ListingStoreFile) {
      seedListedChain(kaspa);
      await storeListing(store);
      const app = await buildAppWith(kaspa, store);
      const prepare = await app.inject({
        method: "POST",
        url: `/v1/tickets/${LISTED_TICKET_ID}/delist/prepare`,
        payload: { publicKey: OWNER_PUBKEY_HEX, address: OWNER_ADDRESS },
      });
      return { app, prepare };
    }

    it("finalize clears the listing and drops the index row", async () => {
      const kaspa = new FakeKaspa();
      const store = new ListingStoreFile();
      kaspa.transactions.set(USED_TXID, { transaction_id: USED_TXID, inputs: [], outputs: [] });
      const { app, prepare } = await preparedDelist(kaspa, store);
      expect(prepare.statusCode).toBe(HTTP_OK);
      const prepared = prepare.json();

      const finalize = await app.inject({
        method: "POST",
        url: `/v1/tickets/${LISTED_TICKET_ID}/delist/finalize`,
        payload: {
          template: prepared.template,
          signed: signedInputs(prepared.template, "aa"),
        },
      });
      expect(finalize.statusCode).toBe(HTTP_OK);

      const broadcastArg = mockedSubmit.mock.calls[0]?.[1] as {
        inputs: { signature_script: string }[];
      };
      const expected = bytesToHex(
        assembleDelistSigScript(
          eventArtifact(),
          hexToBytes(`41${"aa".repeat(65)}`).slice(1),
          redeemState("02".repeat(32), 0),
        ),
      );
      expect(broadcastArg.inputs[0]?.signature_script).toBe(expected);

      const directory = await app.inject({
        method: "GET",
        url: `/v1/events/${TEST_COVENANT_ID}/listings`,
      });
      expect(directory.json()).toEqual([]);
      await app.close();
    });

    it("rejects a ticket that was never listed (422)", async () => {
      const kaspa = new FakeKaspa();
      seedBaseChain(kaspa);
      const app = await buildAppWith(kaspa);

      const prepare = await app.inject({
        method: "POST",
        url: `/v1/tickets/${TICKET_ID}/delist/prepare`,
        payload: { publicKey: OWNER_PUBKEY_HEX, address: OWNER_ADDRESS },
      });
      expect(prepare.statusCode).toBe(HTTP_UNPROCESSABLE_ENTITY);
      expect(prepare.json().error.message).toContain("not listed");
      await app.close();
    });

    it("rejects another seller's listing (422)", async () => {
      const kaspa = new FakeKaspa();
      seedListedChain(kaspa);
      seedBuyerFunds(kaspa);
      const store = new ListingStoreFile();
      await storeListing(store);
      const app = await buildAppWith(kaspa, store);

      const prepare = await app.inject({
        method: "POST",
        url: `/v1/tickets/${LISTED_TICKET_ID}/delist/prepare`,
        payload: { publicKey: BUYER_PUBKEY_HEX, address: BUYER_ADDRESS },
      });
      expect(prepare.statusCode).toBe(HTTP_UNPROCESSABLE_ENTITY);
      expect(prepare.json().error.message).toContain("another seller");
      await app.close();
    });
  });

  describe("purchase", () => {
    /** Listed chain + funded buyer + index row, ready for purchase requests. */
    function listedChainWithBuyer() {
      const kaspa = new FakeKaspa();
      seedListedChain(kaspa);
      seedBuyerFunds(kaspa);
      const store = new ListingStoreFile();
      return { kaspa, store };
    }

    async function preparePurchaseOn(
      app: Awaited<ReturnType<typeof buildAppWith>>,
    ) {
      return app.inject({
        method: "POST",
        url: `/v1/tickets/${LISTED_TICKET_ID}/purchase/prepare`,
        payload: { publicKey: BUYER_PUBKEY_HEX, address: BUYER_ADDRESS },
      });
    }

    it("prepare stamps input 0 server-side and asks only for fee-input signatures", async () => {
      const { kaspa, store } = listedChainWithBuyer();
      const app = await buildAppWith(kaspa, store);
      await storeListing(store);

      const prepare = await preparePurchaseOn(app);
      expect(prepare.statusCode).toBe(HTTP_OK);
      const body = prepare.json();
      expect(body.price).toBe(LIST_PRICE);
      expect(body.seller_pkh).toBe("02".repeat(32));
      expect(body.sign_inputs).toEqual([{ index: 1 }]);
      expect(body.template.inputs[0].previous_outpoint).toEqual({
        transaction_id: LIST_TXID,
        index: 0,
      });
      expect(body.template.inputs[0].signature_script.length).toBeGreaterThan(0);
      await app.close();
    });

    it("finalize relays the escrow spend and clears the index", async () => {
      const { kaspa, store } = listedChainWithBuyer();
      await storeListing(store);
      // The mocked broadcast "confirms" instantly (the accepted purchase tx).
      kaspa.transactions.set(USED_TXID, { transaction_id: USED_TXID, inputs: [], outputs: [] });
      const app = await buildAppWith(kaspa, store);

      const prepare = await preparePurchaseOn(app);
      const prepared = prepare.json();

      const buyerSigned = {
        inputs: [
          {
            transactionId: prepared.template.inputs[1].previous_outpoint.transaction_id,
            index: prepared.template.inputs[1].previous_outpoint.index,
            signatureScript: `41${"cc".repeat(65)}`,
          },
        ],
      };
      const finalize = await app.inject({
        method: "POST",
        url: `/v1/tickets/${LISTED_TICKET_ID}/purchase/finalize`,
        payload: { template: prepared.template, signed: buyerSigned },
      });
      expect(finalize.statusCode).toBe(HTTP_OK);
      expect(finalize.json()).toEqual({ txid: USED_TXID });

      // The stamped input-0 script is the trustless purchase reveal:
      // push(buyer_pkh) || selector(purchase) || push(redeem @ sale_price).
      const broadcastArg = mockedSubmit.mock.calls[0]?.[1] as {
        inputs: { signature_script: string }[];
      };
      const expected = bytesToHex(
        assemblePurchaseSigScript(
          eventArtifact(),
          hexToBytes(BUYER_PKH_HEX),
          redeemState("02".repeat(32), LIST_PRICE),
        ),
      );
      expect(broadcastArg.inputs[0]?.signature_script).toBe(expected);

      const directory = await app.inject({
        method: "GET",
        url: `/v1/events/${TEST_COVENANT_ID}/listings`,
      });
      expect(directory.json()).toEqual([]);
      await app.close();
    });

    it("rejects an unlisted ticket (404)", async () => {
      const kaspa = new FakeKaspa();
      seedBaseChain(kaspa);
      seedBuyerFunds(kaspa);
      const app = await buildAppWith(kaspa);

      const prepare = await app.inject({
        method: "POST",
        url: `/v1/tickets/${TICKET_ID}/purchase/prepare`,
        payload: { publicKey: BUYER_PUBKEY_HEX, address: BUYER_ADDRESS },
      });
      expect(prepare.statusCode).toBe(HTTP_NOT_FOUND);
      await app.close();
    });

    it("rejects a stale index row the chain no longer backs (422)", async () => {
      const { kaspa, store } = listedChainWithBuyer();
      // Chain says listed at a DIFFERENT price than the index claims.
      seedListedChain(kaspa, LIST_PRICE * 2);
      seedBuyerFunds(kaspa);
      await storeListing(store);
      const app = await buildAppWith(kaspa, store);

      const prepare = await app.inject({
        method: "POST",
        url: `/v1/tickets/${LISTED_TICKET_ID}/purchase/prepare`,
        payload: { publicKey: BUYER_PUBKEY_HEX, address: BUYER_ADDRESS },
      });
      expect(prepare.statusCode).toBe(HTTP_UNPROCESSABLE_ENTITY);
      expect(prepare.json().error.message).toContain("no longer valid");
      await app.close();
    });
  });

  describe("listings directory", () => {
    it("hides a stale row instead of serving it", async () => {
      const kaspa = new FakeKaspa();
      seedListedChain(kaspa, LIST_PRICE);
      const store = new ListingStoreFile();
      // Index claims a different price than the chain shows → not provable.
      await store.upsert({
        covenantId: TEST_COVENANT_ID,
        ticketId: LISTED_TICKET_ID,
        sellerPkh: "02".repeat(32),
        price: LIST_PRICE + 1,
      });
      const app = await buildAppWith(kaspa, store);

      const all = await app.inject({ method: "GET", url: "/v1/listings" });
      expect(all.statusCode).toBe(HTTP_OK);
      expect(all.json()).toEqual([]);

      const scoped = await app.inject({
        method: "GET",
        url: `/v1/events/${TEST_COVENANT_ID}/listings`,
      });
      expect(scoped.json()).toEqual([]);

      // An unknown event lists nothing rather than erroring.
      const empty = await app.inject({
        method: "GET",
        url: `/v1/events/${"ff".repeat(32)}/listings`,
      });
      expect(empty.statusCode).toBe(HTTP_OK);
      expect(empty.json()).toEqual([]);
      await app.close();
    });
  });

  describe("full resale lifecycle", () => {
    const PURCHASE_TXID = "e1".repeat(32);
    const PURCHASE_TICKET_ID = `${PURCHASE_TXID}:0`;

    /** The accepted purchase tx: the ticket re-keyed to the buyer, unlisted. */
    function purchaseTx(): Parameters<FakeKaspa["transactions"]["set"]>[1] {
      return {
        transaction_id: PURCHASE_TXID,
        inputs: [],
        outputs: [
          {
            transaction_id: PURCHASE_TXID,
            index: 0,
            amount: ticketValue(),
            script_public_key: p2shScript(redeemState(BUYER_PKH_HEX, 0)).script,
            covenant_authorizing_input: null,
            covenant_id: TEST_COVENANT_ID,
          },
          {
            transaction_id: PURCHASE_TXID,
            index: 1,
            amount: LIST_PRICE,
            script_public_key: `20${"02".repeat(32)}ac`,
            covenant_authorizing_input: null,
            covenant_id: null,
          },
        ],
      };
    }

    it("list → trustless purchase → the BUYER walks through the door", async () => {
      const kaspa = new FakeKaspa();
      seedBaseChain(kaspa);
      seedBuyerFunds(kaspa);
      kaspa.transactions.set(LIST_TXID, listTx(LIST_PRICE));
      kaspa.transactions.set(PURCHASE_TXID, purchaseTx());
      const store = new ListingStoreFile();
      const app = await buildAppWith(kaspa, store);

      // 1. The holder lists the ticket (holder signs every input).
      mockedSubmit.mockResolvedValueOnce(LIST_TXID);
      const listPrepare = await app.inject({
        method: "POST",
        url: `/v1/tickets/${TICKET_ID}/list/prepare`,
        payload: { publicKey: OWNER_PUBKEY_HEX, address: OWNER_ADDRESS, price: LIST_PRICE },
      });
      expect(listPrepare.statusCode).toBe(HTTP_OK);
      const listed = listPrepare.json();
      const listFinalize = await app.inject({
        method: "POST",
        url: `/v1/tickets/${TICKET_ID}/list/finalize`,
        payload: {
          template: listed.template,
          signed: signedInputs(listed.template, "aa"),
          price: LIST_PRICE,
        },
      });
      expect(listFinalize.json()).toEqual({ txid: LIST_TXID });

      // 2. Anyone buys it — no seller interaction at all.
      mockedSubmit.mockResolvedValueOnce(PURCHASE_TXID);
      const buyPrepare = await app.inject({
        method: "POST",
        url: `/v1/tickets/${LISTED_TICKET_ID}/purchase/prepare`,
        payload: { publicKey: BUYER_PUBKEY_HEX, address: BUYER_ADDRESS },
      });
      expect(buyPrepare.statusCode).toBe(HTTP_OK);
      const purchased = buyPrepare.json();
      const purchaseFinalize = await app.inject({
        method: "POST",
        url: `/v1/tickets/${LISTED_TICKET_ID}/purchase/finalize`,
        payload: {
          template: purchased.template,
          signed: {
            inputs: [
              {
                transactionId: purchased.template.inputs[1].previous_outpoint.transaction_id,
                index: purchased.template.inputs[1].previous_outpoint.index,
                signatureScript: `41${"cc".repeat(65)}`,
              },
            ],
          },
        },
      });
      expect(purchaseFinalize.json()).toEqual({ txid: PURCHASE_TXID });

      // The index is clear and the directory proves nothing.
      const directory = await app.inject({ method: "GET", url: "/v1/listings" });
      expect(directory.json()).toEqual([]);

      // 3. The buyer checks in at the door with THEIR key — the resale
      //    handoff produced a fully usable ticket.
      mockedSubmit.mockResolvedValueOnce(USED_TXID);
      kaspa.transactions.set(USED_TXID, { transaction_id: USED_TXID, inputs: [], outputs: [] });
      const usePrepare = await app.inject({
        method: "POST",
        url: `/v1/tickets/${PURCHASE_TICKET_ID}/use/prepare`,
        payload: { publicKey: BUYER_PUBKEY_HEX, address: BUYER_ADDRESS },
      });
      expect(usePrepare.statusCode).toBe(HTTP_OK);
      const preparedUse = usePrepare.json();

      const ownerSigned = {
        inputs: preparedUse.sign_inputs_owner.map(({ index }: { index: number }) => ({
          transactionId: preparedUse.template.inputs[index].previous_outpoint.transaction_id,
          index,
          signatureScript: `41${"aa".repeat(65)}`,
        })),
      };
      const gateSigned = {
        inputs: [
          {
            transactionId: preparedUse.template.inputs[0].previous_outpoint.transaction_id,
            index: 0,
            signatureScript: `41${"bb".repeat(65)}`,
          },
        ],
      };
      const useFinalize = await app.inject({
        method: "POST",
        url: `/v1/tickets/${PURCHASE_TICKET_ID}/use/finalize`,
        payload: {
          use_id: preparedUse.use_id,
          template: preparedUse.template,
          owner_signed: ownerSigned,
          gate_signed: gateSigned,
        },
      });
      expect(useFinalize.statusCode).toBe(HTTP_OK);

      // Input 0 reveals mark_used for the BUYER's state (sale_price cleared).
      const broadcastArg = mockedSubmit.mock.calls[2]?.[1] as {
        inputs: { signature_script: string }[];
      };
      const expectedScript = bytesToHex(
        assembleMarkUsedSigScript(
          eventArtifact(),
          hexToBytes(`41${"aa".repeat(65)}`).slice(1),
          hexToBytes(`41${"bb".repeat(65)}`).slice(1),
          redeemState(BUYER_PKH_HEX, 0),
        ),
      );
      expect(broadcastArg.inputs[0]?.signature_script).toBe(expectedScript);

      await app.close();
    });
  });

  // v3: the door accepts a LISTED ticket — check-in absorbs the sale. The
  // reveal must commit to the listed state (the asking price), which only
  // works when prepare's ownership proof and finalize's redeem both accept the
  // listed address via the index.
  describe("check-in of a listed ticket", () => {
    it("prepare + finalize succeed and reveal mark_used for the LISTED state", async () => {
      const kaspa = new FakeKaspa();
      seedListedChain(kaspa);
      kaspa.transactions.set(USED_TXID, { transaction_id: USED_TXID, inputs: [], outputs: [] });
      const store = new ListingStoreFile();
      await storeListing(store);
      const app = await buildAppWith(kaspa, store);

      mockedSubmit.mockResolvedValueOnce(USED_TXID);
      const usePrepare = await app.inject({
        method: "POST",
        url: `/v1/tickets/${LISTED_TICKET_ID}/use/prepare`,
        payload: { publicKey: OWNER_PUBKEY_HEX, address: OWNER_ADDRESS },
      });
      expect(usePrepare.statusCode).toBe(HTTP_OK);
      const preparedUse = usePrepare.json();

      const ownerSigned = {
        inputs: preparedUse.sign_inputs_owner.map(({ index }: { index: number }) => ({
          transactionId: preparedUse.template.inputs[index].previous_outpoint.transaction_id,
          index,
          signatureScript: `41${"aa".repeat(65)}`,
        })),
      };
      const gateSigned = {
        inputs: [
          {
            transactionId: preparedUse.template.inputs[0].previous_outpoint.transaction_id,
            index: 0,
            signatureScript: `41${"bb".repeat(65)}`,
          },
        ],
      };
      const useFinalize = await app.inject({
        method: "POST",
        url: `/v1/tickets/${LISTED_TICKET_ID}/use/finalize`,
        payload: {
          use_id: preparedUse.use_id,
          template: preparedUse.template,
          owner_signed: ownerSigned,
          gate_signed: gateSigned,
        },
      });
      expect(useFinalize.statusCode).toBe(HTTP_OK);

      // Input 0 reveals mark_used for the LISTED state (sale_price = asking).
      const broadcastArg = mockedSubmit.mock.calls[0]?.[1] as {
        inputs: { signature_script: string }[];
      };
      const expectedScript = bytesToHex(
        assembleMarkUsedSigScript(
          eventArtifact(),
          hexToBytes(`41${"aa".repeat(65)}`).slice(1),
          hexToBytes(`41${"bb".repeat(65)}`).slice(1),
          redeemState("02".repeat(32), LIST_PRICE),
        ),
      );
      expect(broadcastArg.inputs[0]?.signature_script).toBe(expectedScript);

      await app.close();
    });

    it("refuses check-in of a listed ticket the caller does not own", async () => {
      const kaspa = new FakeKaspa();
      seedListedChain(kaspa);
      const app = await buildAppWith(kaspa);

      const usePrepare = await app.inject({
        method: "POST",
        url: `/v1/tickets/${LISTED_TICKET_ID}/use/prepare`,
        payload: { publicKey: BUYER_PUBKEY_HEX, address: BUYER_ADDRESS },
      });
      expect(usePrepare.statusCode).toBe(HTTP_UNPROCESSABLE_ENTITY);
      expect(usePrepare.json().error.message).toBe("you have no ticket for this event");

      await app.close();
    });
  });
});
