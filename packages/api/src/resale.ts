// Trustless resale endpoints (KTK-151). Three two-call flows over the same
// stateless pattern as buy/use — the backend builds and validates, the wallet
// signs, the chain judges:
//
//   list     holder re-points the ticket at a listed state (sale_price = P) and
//            pays the fee. Holder signs every input; finalize assembles input
//            0's sig-script from the raw signature and records the listing.
//   delist   holder clears the listing (back to the unlisted state).
//   purchase ANYONE buys: input 0 needs NO signature (the covenant escrow pays
//            the seller and re-keys the ticket), so prepare stamps the full
//            sig-script server-side; the buyer signs only their fee inputs.
//            Finalize validates the escrow shape, broadcasts, clears the index.
//
// The listings store is an INDEX only. Every read verifies the listing against
// the chain: the live ticket UTXO's address must equal the derived
// `listedStateAddress` for (seller, price) — only then is the listing proven.

import { randomUUID } from "node:crypto";
import {
  addressFor,
  addressFromScriptHash,
  assembleDelistSigScript,
  assembleListSigScript,
  injectState,
  listedStateAddress,
  organizerPkh,
  orgSpkFromPublicKey,
  p2pkScriptFromPubkey,
  pubkeyFromP2pkScript,
  TICKET_DUST,
  type KaspaNetwork,
} from "@kticket/kit";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { invalidError, notFoundError, policyError } from "./errors.js";
import { broadcastAndConfirm } from "./flow.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import type { UtxoResponse } from "./kaspa-types.js";
import type { ListingStore } from "./listings.js";
import { verifyEventFromChain, type VerifiedEvent } from "./provenance.js";
import { buildTransaction } from "./tx.js";
import { isRecord, str, testnetAddress, uint } from "./validate.js";
import type { WireTransaction, WireUtxo, WireUtxoMeta } from "./wire.js";

export interface ResaleContext {
  kaspa: KaspaClientLike;
  networkId: string;
  network: KaspaNetwork;
  /** Resolve the registry pointer for a covenant id (may be undefined). */
  byCovenantId: (covenantId: string) => { deployTxId: string } | undefined;
  /** The listings index (discovery only — the chain stays the source of truth). */
  listings: ListingStore;
}

const TICKET_ID = /^([0-9a-fA-F]{64}):(\d+)$/;
const COMPRESSED_PUBKEY_HEX_LEN = 66;
const X_COORD_HEX_LEN = 64;
const PUBKEY_HEX = /^[0-9a-fA-F]+$/;
/** A wallet signature push for an input: OP_PUSHDATA(65) || 65 bytes. */
const SIG_PUSH_LENGTH = 65;

function parseTicketId(value: unknown): { txid: string; index: number } {
  const s = str(value, "ticket_id");
  const match = TICKET_ID.exec(s);
  if (!match) throw invalidError("ticket_id must be <64-hex-txid>:<output-index>");
  return { txid: match[1]!.toLowerCase(), index: Number(match[2]) };
}

export { parseTicketId };

function validatePublicKey(publicKey: unknown, label = "publicKey"): string {
  const key = str(publicKey, label).toLowerCase();
  if (!PUBKEY_HEX.test(key)) throw invalidError(`${label} must be hex`);
  if (key.length !== COMPRESSED_PUBKEY_HEX_LEN && key.length !== X_COORD_HEX_LEN) {
    throw invalidError(`${label} must be 66 or 64 hex chars`);
  }
  return key;
}

function toWireUtxo(u: UtxoResponse): WireUtxo {
  return {
    transaction_id: u.outpoint.transactionId,
    index: u.outpoint.index,
    value: Number(u.utxoEntry.amount),
  };
}

function toWireUtxoMeta(u: UtxoResponse): WireUtxoMeta {
  return {
    transaction_id: u.outpoint.transactionId,
    index: u.outpoint.index,
    value: Number(u.utxoEntry.amount),
    script_public_key: { version: 0, script: u.utxoEntry.scriptPublicKey.scriptPublicKey },
    block_daa_score: Number(u.utxoEntry.blockDaaScore),
    is_coinbase: u.utxoEntry.isCoinbase,
    ...(typeof u.address === "string" ? { address: u.address } : {}),
  };
}

async function fundingUtxos(ctx: ResaleContext, address: string): Promise<UtxoResponse[]> {
  const utxos = (await ctx.kaspa.getUtxos(address))
    .filter((u) => u.outpoint && u.utxoEntry)
    .sort((a, b) => Number(b.utxoEntry.amount) - Number(a.utxoEntry.amount));
  if (utxos.length === 0) {
    throw policyError("no spendable UTXOs on the funding address");
  }
  return utxos;
}

/**
 * Resolve + verify the event behind a ticket id, and prove the ticket output
 * exists with the event's covenant family id.
 */
async function verifiedTicketEvent(
  txid: string,
  index: number,
  ctx: ResaleContext,
): Promise<VerifiedEvent> {
  const ticketTx = await ctx.kaspa.getTransaction(txid);
  const ticketOutput = ticketTx?.outputs[index];
  if (!ticketOutput) throw notFoundError(`ticket ${txid}:${index} not found on chain`);

  const covenantId = ticketOutput.covenant_id;
  if (!covenantId) {
    throw invalidError(`output ${txid}:${index} is not a covenant ticket`);
  }
  const entry = ctx.byCovenantId(covenantId);
  if (!entry) throw notFoundError(`event for ticket ${txid}:${index} not found`);
  const verified = await verifyEventFromChain(ctx.kaspa, ctx.network, entry.deployTxId);
  if (verified.covenant_id !== covenantId) {
    throw invalidError("ticket does not belong to the verified event");
  }
  return verified;
}

/** The ticket output's on-chain address (`aa20 <hash> 87` -> bech32). */
function ticketAddressOf(script: string | undefined, network: KaspaNetwork): string {
  if (!script) throw invalidError("ticket output has no script public key");
  return addressFromScriptHash(script, network);
}

async function liveTicketAddress(
  txid: string,
  index: number,
  ctx: ResaleContext,
): Promise<string> {
  const tx = await ctx.kaspa.getTransaction(txid);
  return ticketAddressOf(tx?.outputs[index]?.script_public_key, ctx.network);
}

interface WalletSignature {
  transactionId: string;
  index: number;
  signatureScript?: string;
}

function walletSignatures(signed: unknown): WalletSignature[] {
  let parsed: unknown = signed;
  if (typeof signed === "string") {
    try {
      parsed = JSON.parse(signed);
    } catch {
      throw invalidError("signed output is not valid JSON");
    }
  }
  const inputs =
    isRecord(parsed) && Array.isArray((parsed as { inputs?: unknown }).inputs)
      ? ((parsed as { inputs: unknown }).inputs as unknown[])
      : [];
  return inputs.map((input) => {
    if (!isRecord(input)) throw invalidError("signed input must be an object");
    return {
      transactionId: str(input.transactionId, "signed input transactionId"),
      index: input.index as number,
      ...(typeof input.signatureScript === "string"
        ? { signatureScript: input.signatureScript }
        : {}),
    };
  });
}

/** Unwrap the wallet's bare push (`41 <65 bytes>`) into the raw signature. */
function rawSignature(signatureScript: string): Uint8Array {
  const bytes = hexToBytes(signatureScript);
  if (bytes.length === SIG_PUSH_LENGTH) return bytes;
  if (bytes.length === SIG_PUSH_LENGTH + 1 && bytes[0] === SIG_PUSH_LENGTH) {
    return bytes.slice(1);
  }
  throw invalidError("wallet signature must be a 65-byte push");
}

function signatureFor(
  signatures: readonly WalletSignature[],
  txid: string,
  index: number,
  label: string,
): Uint8Array {
  const found = signatures.find(
    (s) => s.transactionId.toLowerCase() === txid && s.index === index,
  );
  if (!found || typeof found.signatureScript !== "string") {
    throw invalidError(`${label} did not sign input ${index}`);
  }
  return rawSignature(found.signatureScript);
}

/** Merge fee-input signatures while keeping input 0's assembled script. */
function mergeKeepingInputZero(
  template: WireTransaction,
  sigs: WalletSignature[],
  inputZeroScript: string,
): WireTransaction {
  return {
    ...template,
    inputs: template.inputs.map((input, i) => {
      if (i === 0) return { ...input, signature_script: inputZeroScript };
      const sig = sigs.find(
        (s) =>
          s.transactionId.toLowerCase() === input.previous_outpoint.transaction_id &&
          s.index === input.previous_outpoint.index,
      );
      return { ...input, signature_script: sig?.signatureScript ?? input.signature_script };
    }),
  };
}

function parseHolderRequest(raw: unknown): { publicKey: string; address: string } {
  if (!isRecord(raw)) throw invalidError("request body must be an object");
  return {
    publicKey: validatePublicKey(raw.publicKey),
    address: testnetAddress(raw.address, "address"),
  };
}

function parseSignedTemplate(raw: unknown): { template: WireTransaction; signed: unknown } {
  if (!isRecord(raw)) throw invalidError("request body must be an object");
  const template = raw.template;
  if (!isRecord(template)) throw invalidError("template must be an object");
  if (!Array.isArray(template.inputs) || template.inputs.length === 0) {
    throw invalidError("template must have inputs");
  }
  if (!Array.isArray(template.outputs) || template.outputs.length === 0) {
    throw invalidError("template must have outputs");
  }
  if (typeof raw.signed !== "string" && typeof raw.signed !== "object") {
    throw invalidError("signed must be the wallet's signing output");
  }
  return { template: template as unknown as WireTransaction, signed: raw.signed };
}

/** The finalize request for a price-carrying flow (list). */
function parseSignedTemplateWithPrice(raw: unknown): {
  template: WireTransaction;
  signed: unknown;
  price: number;
} {
  const base = parseSignedTemplate(raw);
  return { ...base, price: uint((raw as Record<string, unknown>).price, "price") };
}

/**
 * Assert the finalize's input 0 spends the requested ticket — the caller cannot
 * swap in a different covenant spend than the route names.
 */
function assertInputZeroIsTicket(
  template: WireTransaction,
  txid: string,
  index: number,
): void {
  const input = template.inputs[0];
  if (
    !input ||
    input.previous_outpoint.transaction_id.toLowerCase() !== txid ||
    input.previous_outpoint.index !== index
  ) {
    throw invalidError("template input 0 is not the requested ticket");
  }
}

/** Recover the holder's identity from the change output (P2PK `20 <x> ac`). */
function ownerFromChangeOutput(template: WireTransaction): Uint8Array {
  const changeScript = template.outputs[1]?.script_public_key?.script;
  if (typeof changeScript !== "string") {
    throw invalidError("template has no change output");
  }
  const pubkey = pubkeyFromP2pkScript(changeScript);
  if (!pubkey) throw invalidError("template change output is not a P2PK script");
  return pubkey;
}

function constantsOf(verified: VerifiedEvent) {
  return {
    authorizing_txid: verified.authorizing_txid,
    price: verified.price,
    org_spk: verified.org_spk,
    burn_template_hash: verified.burn_template_hash,
  };
}

// --- list --------------------------------------------------------------------

export interface ListPrepareResult {
  list_id: string;
  signing_template: string;
  template: WireTransaction;
  sign_inputs: { index: number }[];
  price: number;
  event: { name: string; date: string };
}

export async function listPrepare(
  ticketIdValue: unknown,
  raw: unknown,
  ctx: ResaleContext,
): Promise<ListPrepareResult> {
  const holder = parseHolderRequest(raw);
  const priceRaw = isRecord(raw) ? raw.price : undefined;
  const price = uint(priceRaw, "price");
  if (price <= 0) throw invalidError("price must be a positive number of sompi");

  const { txid, index } = parseTicketId(ticketIdValue);
  const verified = await verifiedTicketEvent(txid, index, ctx);
  const ownerPkh = organizerPkh(holder.publicKey);

  // Ownership + unused + unlisted in one equality: the ticket's live address
  // must be exactly the unlisted-state address derived from the caller's key.
  const ownerAddress = addressFor(
    verified.artifact,
    { owner: hexToBytes(ownerPkh), identifierType: 0, amount: 1, isMinter: false, used: false, salePrice: 0 },
    ctx.network,
  );
  if ((await liveTicketAddress(txid, index, ctx)) !== ownerAddress) {
    throw policyError("you have no unlisted ticket for this event");
  }

  const utxos = await fundingUtxos(ctx, holder.address);
  const result = await buildTransaction(
    {
      type: "list",
      ticket_outpoint: { transaction_id: txid, index },
      event_covenant_id: verified.covenant_id,
      constants: constantsOf(verified),
      owner: ownerPkh,
      price,
      owner_utxos: utxos.map(toWireUtxo),
      change_spk: { version: 0, script: orgSpkFromPublicKey(holder.publicKey) },
      input_utxo_metas: utxos.map(toWireUtxoMeta),
    },
    { kaspa: ctx.kaspa, networkId: ctx.networkId },
  );

  if (!result.signing_template) {
    throw invalidError("could not build a signing template for the listing");
  }
  return {
    list_id: randomUUID(),
    signing_template: result.signing_template,
    template: result.template,
    sign_inputs: result.template.inputs.map((_, i) => ({ index: i })),
    price,
    event: { name: verified.name, date: verified.date },
  };
}

export async function listFinalize(
  ticketIdValue: unknown,
  raw: unknown,
  ctx: ResaleContext,
): Promise<{ txid: string }> {
  const req = parseSignedTemplateWithPrice(raw);
  const { txid, index } = parseTicketId(ticketIdValue);
  assertInputZeroIsTicket(req.template, txid, index);

  const verified = await verifiedTicketEvent(txid, index, ctx);
  const owner = ownerFromChangeOutput(req.template);

  const sigs = walletSignatures(req.signed);
  const holderSig = signatureFor(sigs, txid, index, "holder");

  // Input 0's sig-script: push(sig_holder) || push(price) || push(dispatch_tag) ||
  // push(redeem) — pure kit assembly, byte-exact with the Rust golden tests.
  const redeem = injectState(verified.artifact, {
    owner,
    identifierType: 0,
    amount: 1,
    isMinter: false,
    used: false,
    salePrice: 0,
  });
  const sigScript = bytesToHex(assembleListSigScript(verified.artifact, holderSig, req.price, redeem));

  const merged = mergeKeepingInputZero(req.template, sigs, sigScript);

  // Post-merge sanity check: the ticket output carries the covenant and commits
  // to the listed-state address for (owner, price).
  const [ticketOutput] = merged.outputs;
  if (!ticketOutput?.covenant) {
    throw policyError("template is not a listing (no covenant output)");
  }
  const expectedAddress = listedStateAddress(verified.artifact, owner, req.price, ctx.network);
  if (addressFromScriptHash(ticketOutput.script_public_key.script, ctx.network) !== expectedAddress) {
    throw policyError("listing output does not commit to the asking price");
  }

  const finalTxid = await broadcastAndConfirm(merged, {}, ctx, () => {});
  // The listed UTXO now lives at the NEW outpoint (<final txid>:0 — buildList
  // always puts the covenant output first). Index THAT, not the spent one:
  // every later read proves the live coin against its listed-state address.
  await ctx.listings.upsert({
    covenantId: verified.covenant_id,
    ticketId: `${finalTxid}:0`,
    sellerPkh: bytesToHex(owner),
    price: req.price,
  });
  return { txid: finalTxid };
}

// --- delist ------------------------------------------------------------------

export interface DelistPrepareResult {
  delist_id: string;
  signing_template: string;
  template: WireTransaction;
  sign_inputs: { index: number }[];
  event: { name: string; date: string };
}

export async function delistPrepare(
  ticketIdValue: unknown,
  raw: unknown,
  ctx: ResaleContext,
): Promise<DelistPrepareResult> {
  const holder = parseHolderRequest(raw);
  const { txid, index } = parseTicketId(ticketIdValue);
  const verified = await verifiedTicketEvent(txid, index, ctx);
  const ownerPkh = organizerPkh(holder.publicKey);

  // The caller must own a LISTED ticket. The index supplies the recorded price;
  // the address equality proves it against the chain before anything is built.
  const stored = ctx.listings.get(verified.covenant_id, `${txid}:${index}`);
  if (!stored) throw policyError("this ticket is not listed for resale");
  if (stored.sellerPkh !== ownerPkh) {
    throw policyError("this listing belongs to another seller");
  }
  const actual = await liveTicketAddress(txid, index, ctx);
  const expected = listedStateAddress(verified.artifact, hexToBytes(ownerPkh), stored.price, ctx.network);
  if (actual !== expected) {
    throw policyError("this ticket is no longer listed at the recorded price");
  }

  const utxos = await fundingUtxos(ctx, holder.address);
  const result = await buildTransaction(
    {
      type: "delist",
      ticket_outpoint: { transaction_id: txid, index },
      event_covenant_id: verified.covenant_id,
      constants: constantsOf(verified),
      owner: ownerPkh,
      owner_utxos: utxos.map(toWireUtxo),
      change_spk: { version: 0, script: orgSpkFromPublicKey(holder.publicKey) },
      input_utxo_metas: utxos.map(toWireUtxoMeta),
    },
    { kaspa: ctx.kaspa, networkId: ctx.networkId },
  );

  if (!result.signing_template) {
    throw invalidError("could not build a signing template for the delist");
  }
  return {
    delist_id: randomUUID(),
    signing_template: result.signing_template,
    template: result.template,
    sign_inputs: result.template.inputs.map((_, i) => ({ index: i })),
    event: { name: verified.name, date: verified.date },
  };
}

export async function delistFinalize(
  ticketIdValue: unknown,
  raw: unknown,
  ctx: ResaleContext,
): Promise<{ txid: string }> {
  const req = parseSignedTemplate(raw);
  const { txid, index } = parseTicketId(ticketIdValue);
  assertInputZeroIsTicket(req.template, txid, index);

  const verified = await verifiedTicketEvent(txid, index, ctx);
  const owner = ownerFromChangeOutput(req.template);

  // The ticket being spent is the LISTED coin, so the reveal must carry the
  // listing's asking price — the listed P2SH address commits to it. Revealing
  // the unlisted (sale_price 0) state instead would hash to a different P2SH
  // and the node rejects the spend.
  const stored = ctx.listings.get(verified.covenant_id, `${txid}:${index}`);
  if (!stored) throw policyError("this ticket is not listed for resale");

  const sigs = walletSignatures(req.signed);
  const holderSig = signatureFor(sigs, txid, index, "holder");

  const redeem = injectState(verified.artifact, {
    owner,
    identifierType: 0,
    amount: 1,
    isMinter: false,
    used: false,
    salePrice: stored.price,
  });
  const sigScript = bytesToHex(assembleDelistSigScript(verified.artifact, holderSig, redeem));
  const merged = mergeKeepingInputZero(req.template, sigs, sigScript);

  // The delisted ticket must land back on the plain unlisted address.
  const [ticketOutput] = merged.outputs;
  if (!ticketOutput?.covenant) {
    throw policyError("template is not a delist (no covenant output)");
  }
  const unlisted = addressFor(
    verified.artifact,
    { owner, identifierType: 0, amount: 1, isMinter: false, used: false, salePrice: 0 },
    ctx.network,
  );
  if (addressFromScriptHash(ticketOutput.script_public_key.script, ctx.network) !== unlisted) {
    throw policyError("delist output does not clear the listing");
  }

  const finalTxid = await broadcastAndConfirm(merged, {}, ctx, () => {});
  await ctx.listings.remove(verified.covenant_id, `${txid}:${index}`);
  return { txid: finalTxid };
}

// --- purchase ----------------------------------------------------------------

export interface PurchasePrepareResult {
  purchase_id: string;
  signing_template: string;
  template: WireTransaction;
  /** Only the buyer's fee inputs need signatures — input 0 is signatureless. */
  sign_inputs: { index: number }[];
  price: number;
  /** Fresh deposit funded by the buyer and carried by the replacement ticket. */
  ticket_deposit: number;
  /** Asking price plus the old ticket deposit, paid to the seller. */
  seller_proceeds: number;
  seller_pkh: string;
  event: { name: string; date: string };
}

export async function purchasePrepare(
  ticketIdValue: unknown,
  raw: unknown,
  ctx: ResaleContext,
): Promise<PurchasePrepareResult> {
  const buyer = parseHolderRequest(raw);
  const { txid, index } = parseTicketId(ticketIdValue);
  const verified = await verifiedTicketEvent(txid, index, ctx);

  const stored = ctx.listings.get(verified.covenant_id, `${txid}:${index}`);
  if (!stored) throw notFoundError(`ticket ${txid}:${index} is not listed for resale`);

  // Prove the listing on-chain: the live ticket UTXO's address must be the
  // listed-state address for (seller, price). This is the whole trust model —
  // the API's index could lie; the chain cannot.
  const actual = await liveTicketAddress(txid, index, ctx);
  const expected = listedStateAddress(
    verified.artifact,
    hexToBytes(stored.sellerPkh),
    stored.price,
    ctx.network,
  );
  if (actual !== expected) {
    throw policyError("this listing is no longer valid (chain state differs)");
  }

  const buyerPkh = organizerPkh(buyer.publicKey);
  const utxos = await fundingUtxos(ctx, buyer.address);

  const result = await buildTransaction(
    {
      type: "purchase",
      ticket_outpoint: { transaction_id: txid, index },
      event_covenant_id: verified.covenant_id,
      constants: constantsOf(verified),
      seller: stored.sellerPkh,
      buyer: buyerPkh,
      price: stored.price,
      buyer_utxos: utxos.map(toWireUtxo),
      change_spk: { version: 0, script: orgSpkFromPublicKey(buyer.publicKey) },
      input_utxo_metas: utxos.map(toWireUtxoMeta),
    },
    { kaspa: ctx.kaspa, networkId: ctx.networkId },
  );

  if (!result.signing_template) {
    throw invalidError("could not build a signing template for the purchase");
  }
  return {
    purchase_id: randomUUID(),
    signing_template: result.signing_template,
    template: result.template,
    sign_inputs: result.template.inputs.slice(1).map((_, i) => ({ index: i + 1 })),
    price: stored.price,
    ticket_deposit: TICKET_DUST,
    seller_proceeds: stored.price + TICKET_DUST,
    seller_pkh: stored.sellerPkh,
    event: { name: verified.name, date: verified.date },
  };
}

export async function purchaseFinalize(
  ticketIdValue: unknown,
  raw: unknown,
  ctx: ResaleContext,
): Promise<{ txid: string }> {
  const req = parseSignedTemplate(raw);
  const { txid, index } = parseTicketId(ticketIdValue);
  assertInputZeroIsTicket(req.template, txid, index);

  const verified = await verifiedTicketEvent(txid, index, ctx);
  const stored = ctx.listings.get(verified.covenant_id, `${txid}:${index}`);
  if (!stored) throw notFoundError(`ticket ${txid}:${index} is not listed for resale`);

  // Validate the fixed escrow outputs before relaying. The covenant enforces
  // these rules too, but rejecting malformed templates here gives the buyer a
  // useful error instead of submitting a transaction that must fail on-chain.
  const ticketOutput = req.template.outputs[0];
  const sellerScript = p2pkScriptFromPubkey(hexToBytes(stored.sellerPkh)).script;
  const sellerProceeds = stored.price + TICKET_DUST;
  const sellerOutput = req.template.outputs.find(
    (output) => output.script_public_key.script === sellerScript,
  );
  if (
    !ticketOutput?.covenant ||
    ticketOutput.value !== TICKET_DUST ||
    !sellerOutput ||
    sellerOutput.value !== sellerProceeds
  ) {
    throw policyError("template is not a purchase (no covenant output)");
  }

  const finalTxid = await broadcastAndConfirm(req.template, req.signed, ctx, () => {});
  await ctx.listings.remove(verified.covenant_id, `${txid}:${index}`);
  return { txid: finalTxid };
}

// --- listings directory ------------------------------------------------------

export interface ListingSummary {
  ticket_id: string;
  price: number;
  seller_pkh: string;
  event_name: string;
  event_date: string;
  covenant_id: string;
  verified: true;
}

/**
 * All live listings for one event (or every event when no covenant id is
 * given), each proven on-chain: the ticket UTXO still exists and sits on the
 * exact listed-state address for its recorded (seller, price). Entries that
 * fail are skipped silently — stale index rows are expected after off-path
 * spends (the ticket was handed over or checked in outside the flow).
 */
export async function listingsDirectory(
  covenantId: string | undefined,
  ctx: ResaleContext,
): Promise<ListingSummary[]> {
  const candidates = covenantId ? ctx.listings.byCovenantId(covenantId) : ctx.listings.list();

  const summaries = await Promise.all(
    candidates.map(async (listing): Promise<ListingSummary | undefined> => {
      try {
        const { txid, index } = parseTicketId(listing.ticketId);
        const verified = await verifiedTicketEvent(txid, index, ctx);
        const actual = await liveTicketAddress(txid, index, ctx);
        const expected = listedStateAddress(
          verified.artifact,
          hexToBytes(listing.sellerPkh),
          listing.price,
          ctx.network,
        );
        if (actual !== expected) return undefined;
        return {
          ticket_id: listing.ticketId,
          price: listing.price,
          seller_pkh: listing.sellerPkh,
          event_name: verified.name,
          event_date: verified.date,
          covenant_id: verified.covenant_id,
          verified: true,
        };
      } catch {
        return undefined;
      }
    }),
  );
  return summaries.filter((s): s is ListingSummary => s !== undefined);
}
