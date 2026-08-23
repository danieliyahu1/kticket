// kticket API routes (HLD v0.27 §2.2):
//   GET  /v1/events                              — directory of verified events (from the registry)
//   POST /v1/events                              — register an event after deploy (discovery only)
//   GET  /v1/events/{covenant_id}                — verified event facts + raw chain facts
//   GET  /v1/events/{covenant_id}/listings       — chain-proven resale listings (KTK-151)
//   POST /v1/events/deploy/prepare               — backend-owned deploy: build the unsigned template
//   POST /v1/events/deploy/finalize              — backend-owned deploy: merge, broadcast, register
//   POST /v1/events/{covenant_id}/buy/prepare    — backend-owned buy: verify event, build template
//   POST /v1/events/{covenant_id}/buy/finalize   — backend-owned buy: merge, broadcast, confirm
//   GET  /v1/tickets                             — user's on-chain tickets (?owner_pkh=)
//   POST /v1/tickets/{ticket_id}/use/prepare     — owner pre-signs a check-in (door flow, KTK-118)
//   POST /v1/tickets/{ticket_id}/list/prepare    — holder lists a ticket for resale (KTK-151)
//   POST /v1/tickets/{ticket_id}/list/finalize   — merge, broadcast, index the listing
//   POST /v1/tickets/{ticket_id}/delist/prepare  — holder clears a listing
//   POST /v1/tickets/{ticket_id}/delist/finalize — merge, broadcast, drop the index row
//   POST /v1/tickets/{ticket_id}/purchase/prep.. — trustless buyer flow (no seller online)
//   POST /v1/tickets/{ticket_id}/purchase/final..— validate escrow, broadcast, drop the index row
//
// KTK-89 (stateless backend): the identifier registry holds only
// `{deploy_txid, covenant_id, organizer_address}` for discovery. Every event
// read calls `verifyEventFromChain` (memoized by `VerifiedEventCache`) — the
// chain is the source of truth, and the response carries raw chain facts so any
// displayed value can be re-checked. Events that fail on-chain verification are
// hidden from the directory.

import {
  addressFor,
  addressFromScriptHash,
  listedStateAddress,
  organizerPkh,
  type KaspaNetwork,
} from "@kticket/kit";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { buyFinalize, buyPrepare } from "./buy.js";
import { invalidError, isApiError, notFoundError } from "./errors.js";
import { describeWalletSignatures } from "./flow.js";
import { deployFinalize, deployPrepare } from "./deploy.js";
import type { EventRegistry, StoredEvent } from "./eventstore.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import type { ListingStore } from "./listings.js";
import type { VerifiedEvent } from "./provenance.js";
import { verifyEventFromChain } from "./provenance.js";
import {
  delistFinalize,
  delistPrepare,
  listFinalize,
  listPrepare,
  listingsDirectory,
  parseTicketId,
  purchaseFinalize,
  purchasePrepare,
  type ResaleContext,
} from "./resale.js";
import { usePrepare } from "./use.js";
import { useFinalize, useSignTemplate } from "./use-gate.js";
import { VerifiedEventCache } from "./verified-cache.js";
import { HEX64, hex64, isRecord } from "./validate.js";
import type { WireTransaction } from "./wire.js";

/** The wallet-relay fields every finalize body carries. */
interface FinalizeBody {
  template?: WireTransaction;
  signed?: unknown;
  owner_signed?: unknown;
  gate_signed?: unknown;
}

/**
 * Structured log of what each finalize's wallet payload actually covered,
 * before merge/broadcast — the server-side counterpart of the (dev-only)
 * client signing diagnostics. Positions only, all public chain data.
 */
function logSignatureOutcome(
  req: FastifyRequest,
  flow: string,
  body: FinalizeBody,
  ...payloads: unknown[]
): void {
  if (!body.template) return;
  const rest = payloads.length > 0 ? payloads : [body.signed];
  req.log.info(describeWalletSignatures(flow, body.template, ...rest), "wallet signatures");
}

export interface AppContext {
  kaspa: KaspaClientLike;
  events: EventRegistry;
  /** The resale listings index (discovery only — the chain stays the truth). */
  listings: ListingStore;
  network: KaspaNetwork;
  networkId: string;
  verified: VerifiedEventCache;
}

/** The subset the resale flows need — routes pass it straight through. */
function resaleCtx(ctx: AppContext): ResaleContext {
  return {
    kaspa: ctx.kaspa,
    network: ctx.network,
    networkId: ctx.networkId,
    byCovenantId: (covenantId: string) => ctx.events.byCovenantId(covenantId),
    listings: ctx.listings,
  };
}

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: { organizer_address?: string } }>(
    "/v1/events",
    async (req) => {
      const entries = ctx.events.list(req.query.organizer_address);
      const verified = await verifyAll(entries, ctx);
      return verified.map(toEventSummary);
    },
  );

  const deployCtx = {
    kaspa: ctx.kaspa,
    networkId: ctx.networkId,
    network: ctx.network,
    register: (e: { deployTxId: string; covenantId: string; organizerAddress: string }) =>
      ctx.events.register(e),
  };

  app.post("/v1/events/deploy/prepare", async (req) => {
    const result = await deployPrepare(req.body, deployCtx);
    req.log.info(
      { deploy_id: result.deploy_id, template_inputs: result.template.inputs.length },
      "deploy prepare",
    );
    return result;
  });

  app.post("/v1/events/deploy/finalize", async (req) => {
    logSignatureOutcome(req, "deploy finalize", req.body as FinalizeBody);
    const result = await deployFinalize(req.body, deployCtx);
    req.log.info(
      { deploy_id: (req.body as { deploy_id?: unknown })?.deploy_id, covenant_id: result.covenant_id },
      "deploy finalize",
    );
    return result;
  });

  app.post("/v1/events", async (req) => {
    try {
      const deployTxId = parseRegisterEventBody(req.body);

      const verified = await verifyEventFromChain(ctx.kaspa, ctx.network, deployTxId);

      await ctx.events.register({
        deployTxId: verified.deploy_txid,
        covenantId: verified.covenant_id,
        organizerAddress: verified.organizer_address,
      });
      return { covenant_id: verified.covenant_id };
    } catch (err) {
      if (isApiError(err)) {
        req.log.error({ detail: err.detail }, "event registration failed");
      }
      throw err;
    }
  });

  app.get<{ Params: { covenantId: string } }>("/v1/events/:covenantId", async (req) => {
    const { covenantId: id } = req.params;
    const entry = ctx.events.byCovenantId(id);
    if (!entry) throw notFoundError(`event ${id} not found`);

    const verified = await ctx.verified.verify(ctx.kaspa, ctx.network, entry.deployTxId);

    return {
      event: toEventSummary(verified),
      raw_chain: verified.raw_chain,
    };
  });

  app.get<{ Querystring: { owner_pkh?: string } }>("/v1/tickets", async (req) => {
    const ownerPkh = req.query.owner_pkh;
    if (!ownerPkh) throw invalidError("owner_pkh query parameter is required");

    // Normalize to the 32-byte x-coordinate (strip the 02/03 prefix) — the same
    // owner identifier the buy path mints tickets to, so the derived address
    // matches the on-chain ticket covenant output.
    const ownerBytes = hexToBytes(organizerPkh(ownerPkh));

    // Verify every event in parallel (memoized), then ask the chain about all
    // the owner's ticket addresses in a single batch request.
    const verified = await verifyAll(ctx.events.list(), ctx);
    const eventByAddress = new Map<string, VerifiedEvent>();
    for (const event of verified) {
      const address = addressFor(
        event.artifact,
        { owner: ownerBytes, identifierType: 0, amount: 1, isMinter: false, used: false, salePrice: 0 },
        ctx.network,
      );
      eventByAddress.set(address, event);
    }

    if (eventByAddress.size === 0) return [];

    const utxos = await ctx.kaspa.getUtxosForAddresses([...eventByAddress.keys()]);
    const unlisted = utxos.flatMap((u) => {
      const event = u.address ? eventByAddress.get(u.address) : undefined;
      if (!event) return [];
      return [{
        ticket_id: `${u.outpoint.transactionId}:${u.outpoint.index}`,
        covenant_id: event.covenant_id,
        event_name: event.name,
        event_date: event.date,
        event_time: event.time,
      }];
    });

    // Listed tickets this caller owns: the index proposes (seller match), the
    // chain disposes (the live coin must sit on the derived listed-state
    // address). Without this walk a listed ticket would vanish from My Tickets
    // — its address moved when sale_price was set.
    const ownerHex = bytesToHex(ownerBytes);
    const listed = (
      await Promise.all(
        verified.map(async (event) =>
          Promise.all(
            ctx.listings
              .byCovenantId(event.covenant_id)
              .filter((l) => l.sellerPkh === ownerHex)
              .map(async (l): Promise<Record<string, unknown> | undefined> => {
                try {
                  const { txid, index } = parseTicketId(l.ticketId);
                  const tx = await ctx.kaspa.getTransaction(txid);
                  const script = tx?.outputs[index]?.script_public_key;
                  if (!script) return undefined;
                  const actual = addressFromScriptHash(script, ctx.network);
                  const expected = listedStateAddress(
                    event.artifact,
                    ownerBytes,
                    l.price,
                    ctx.network,
                  );
                  if (actual !== expected) return undefined;
                  return {
                    ticket_id: l.ticketId,
                    covenant_id: event.covenant_id,
                    event_name: event.name,
                    event_date: event.date,
                    event_time: event.time,
                    listed: true,
                    price: l.price,
                  };
                } catch {
                  return undefined;
                }
              }),
          ),
        ),
      )
    ).flat();

    return [...unlisted, ...listed.filter((l): l is Record<string, unknown> => l !== undefined)];
  });

  const useCtx = {
    kaspa: ctx.kaspa,
    networkId: ctx.networkId,
    network: ctx.network,
    byCovenantId: (covenantId: string) => ctx.events.byCovenantId(covenantId),
    listings: ctx.listings,
  };

  app.post<{ Params: { ticketId: string } }>(
    "/v1/tickets/:ticketId/use/prepare",
    async (req) => {
      const result = await usePrepare(req.params.ticketId, req.body, useCtx);
      req.log.info(
        {
          use_id: result.use_id,
          ticket_id: req.params.ticketId,
          sign_inputs: result.sign_inputs_owner.length,
          event: result.event.name,
        },
        "use prepare",
      );
      return result;
    },
  );

  app.post<{ Params: { ticketId: string } }>(
    "/v1/tickets/:ticketId/use/sign-template",
    async (req) => {
      const result = await useSignTemplate(req.params.ticketId, req.body, useCtx);
      req.log.info(
        { ticket_id: req.params.ticketId, signing_template_bytes: result.signing_template.length },
        "use sign-template",
      );
      return result;
    },
  );

  app.post<{ Params: { ticketId: string } }>(
    "/v1/tickets/:ticketId/use/finalize",
    async (req) => {
      const body = req.body as FinalizeBody;
      logSignatureOutcome(req, "use finalize", body, body.owner_signed, body.gate_signed);
      const result = await useFinalize(req.params.ticketId, req.body, useCtx);
      req.log.info(
        {
          use_id: (req.body as { use_id?: unknown })?.use_id,
          ticket_id: req.params.ticketId,
          txid: result.txid,
        },
        "use finalize",
      );
      return result;
    },
  );

  const buyCtx = {
    kaspa: ctx.kaspa,
    networkId: ctx.networkId,
    network: ctx.network,
    byCovenantId: (covenantId: string) => ctx.events.byCovenantId(covenantId),
  };

  app.post<{ Params: { covenantId: string } }>(
    "/v1/events/:covenantId/buy/prepare",
    async (req) => {
      const result = await buyPrepare(req.params.covenantId, req.body, buyCtx);
      req.log.info(
        {
          buy_id: result.buy_id,
          covenant_id: req.params.covenantId,
          sign_inputs: result.sign_inputs.length,
          price: result.price,
        },
        "buy prepare",
      );
      return result;
    },
  );

  app.post<{ Params: { covenantId: string } }>(
    "/v1/events/:covenantId/buy/finalize",
    async (req) => {
      logSignatureOutcome(req, "buy finalize", req.body as FinalizeBody);
      const result = await buyFinalize(req.body, buyCtx);
      req.log.info(
        {
          buy_id: (req.body as { buy_id?: unknown })?.buy_id,
          covenant_id: req.params.covenantId,
          txid: result.txid,
        },
        "buy finalize",
      );
      return result;
    },
  );

  // --- resale (KTK-151) ------------------------------------------------------

  app.get<{ Params: { covenantId?: string } }>(
    "/v1/listings",
    async (req) => listingsDirectory(undefined, resaleCtx(ctx)),
  );

  app.get<{ Params: { covenantId: string } }>(
    "/v1/events/:covenantId/listings",
    async (req) => {
      const listings = await listingsDirectory(req.params.covenantId, resaleCtx(ctx));
      req.log.info({ covenant_id: req.params.covenantId, count: listings.length }, "listings");
      return listings;
    },
  );

  app.post<{ Params: { ticketId: string } }>(
    "/v1/tickets/:ticketId/list/prepare",
    async (req) => {
      const result = await listPrepare(req.params.ticketId, req.body, resaleCtx(ctx));
      req.log.info(
        {
          list_id: result.list_id,
          ticket_id: req.params.ticketId,
          price: result.price,
        },
        "list prepare",
      );
      return result;
    },
  );

  app.post<{ Params: { ticketId: string } }>(
    "/v1/tickets/:ticketId/list/finalize",
    async (req) => {
      logSignatureOutcome(req, "list finalize", req.body as FinalizeBody);
      const result = await listFinalize(req.params.ticketId, req.body, resaleCtx(ctx));
      req.log.info({ ticket_id: req.params.ticketId, txid: result.txid }, "list finalize");
      return result;
    },
  );

  app.post<{ Params: { ticketId: string } }>(
    "/v1/tickets/:ticketId/delist/prepare",
    async (req) => {
      const result = await delistPrepare(req.params.ticketId, req.body, resaleCtx(ctx));
      req.log.info(
        { delist_id: result.delist_id, ticket_id: req.params.ticketId },
        "delist prepare",
      );
      return result;
    },
  );

  app.post<{ Params: { ticketId: string } }>(
    "/v1/tickets/:ticketId/delist/finalize",
    async (req) => {
      logSignatureOutcome(req, "delist finalize", req.body as FinalizeBody);
      const result = await delistFinalize(req.params.ticketId, req.body, resaleCtx(ctx));
      req.log.info({ ticket_id: req.params.ticketId, txid: result.txid }, "delist finalize");
      return result;
    },
  );

  app.post<{ Params: { ticketId: string } }>(
    "/v1/tickets/:ticketId/purchase/prepare",
    async (req) => {
      const result = await purchasePrepare(req.params.ticketId, req.body, resaleCtx(ctx));
      req.log.info(
        {
          purchase_id: result.purchase_id,
          ticket_id: req.params.ticketId,
          price: result.price,
        },
        "purchase prepare",
      );
      return result;
    },
  );

  app.post<{ Params: { ticketId: string } }>(
    "/v1/tickets/:ticketId/purchase/finalize",
    async (req) => {
      logSignatureOutcome(req, "purchase finalize", req.body as FinalizeBody);
      const result = await purchaseFinalize(req.params.ticketId, req.body, resaleCtx(ctx));
      req.log.info({ ticket_id: req.params.ticketId, txid: result.txid }, "purchase finalize");
      return result;
    },
  );

}

function parseRegisterEventBody(raw: unknown): string {
  if (!isRecord(raw)) {
    throw invalidError("request body must be an object");
  }
  // Discovery-only registration: the deploy txid is the retrieval key. Accept
  // the legacy `genesis_txid` alias for backward compatibility.
  const deployTxId = raw.deploy_txid ?? raw.genesis_txid;
  const value = hex64(deployTxId, "deploy_txid");
  if (!HEX64.test(value)) {
    throw invalidError("deploy_txid must be 64 hex chars");
  }
  return value;
}

/**
 * Verify every registry entry against the chain, hiding entries that fail
 * verification (poisoned or stale registry data). Non-verification errors
 * (e.g. upstream outages) propagate — the whole directory fails rather than
 * silently dropping events we could not check.
 */
async function verifyAll(
  entries: readonly StoredEvent[],
  ctx: AppContext,
): Promise<VerifiedEvent[]> {
  const outcomes = await Promise.all(entries.map((entry) => verifyIfValid(entry, ctx)));
  return outcomes.filter(isVerifiedEvent);
}

async function verifyIfValid(
  entry: StoredEvent,
  ctx: AppContext,
): Promise<VerifiedEvent | undefined> {
  try {
    return await ctx.verified.verify(ctx.kaspa, ctx.network, entry.deployTxId);
  } catch (err) {
    if (isApiError(err) && err.type === "invalid") return undefined;
    throw err;
  }
}

function isVerifiedEvent(event: VerifiedEvent | undefined): event is VerifiedEvent {
  return event !== undefined;
}

/** The chain-verified facts shown on the homepage card and the detail page. */
function toEventSummary(verified: VerifiedEvent) {
  return {
    covenant_id: verified.covenant_id,
    deploy_txid: verified.deploy_txid,
    name: verified.name,
    date: verified.date,
    time: verified.time,
    ticker: verified.ticker,
    decimals: verified.decimals,
    image: verified.image,
    image_hash: verified.image_hash,
    price: verified.price,
    capacity: verified.capacity,
    organizer_address: verified.organizer_address,
    verified: true,
  };
}
