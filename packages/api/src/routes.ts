// kticket API routes (HLD v0.27 §2.2):
//   GET  /v1/events                              — directory of verified events (from the registry)
//   POST /v1/events                              — register an event after deploy (discovery only)
//   GET  /v1/events/{covenant_id}                — verified event + availability + raw chain facts
//   POST /v1/events/deploy/prepare               — backend-owned deploy: build the unsigned template
//   POST /v1/events/deploy/finalize              — backend-owned deploy: merge, broadcast, register
//   POST /v1/events/{covenant_id}/buy/prepare    — backend-owned buy: verify event, build template
//   POST /v1/events/{covenant_id}/buy/finalize   — backend-owned buy: merge, broadcast, confirm
//   GET  /v1/tickets                             — user's on-chain tickets (?owner_pkh=)
//
// KTK-89 (stateless backend): the identifier registry holds only
// `{deploy_txid, covenant_id, organizer_address}` for discovery. Every event
// read calls `verifyEventFromChain` — the chain is the source of truth, and the
// response carries raw chain facts so any displayed value can be re-checked.
// Events that fail on-chain verification are hidden from the directory.

import {
  addressFor,
  organizerPkh,
  type KaspaNetwork,
} from "@kticket/kit";
import { hexToBytes } from "@noble/hashes/utils.js";
import type { FastifyInstance } from "fastify";
import { buyFinalize, buyPrepare } from "./buy.js";
import { invalidError, isApiError, notFoundError } from "./errors.js";
import { deployFinalize, deployPrepare } from "./deploy.js";
import { eventAvailability } from "./events.js";
import type { EventStore } from "./eventstore.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import { verifyEventFromChain } from "./provenance.js";
import { HEX64, hex64, isRecord } from "./validate.js";

export interface AppContext {
  kaspa: KaspaClientLike;
  events: EventStore;
  network: KaspaNetwork;
  networkId: string;
}

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: { organizer_address?: string } }>(
    "/v1/events",
    async (req) => {
      const entries = ctx.events.list(req.query.organizer_address);
      // KTK-89: the directory shows only identifiers. Full event data (name,
      // price, capacity, availability) is fetched from the chain on demand when
      // a user opens an event (`GET /v1/events/{covenant_id}`).
      return entries.map((entry) => ({
        covenant_id: entry.covenantId,
        deploy_txid: entry.deployTxId,
        organizer_address: entry.organizerAddress,
      }));
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

      ctx.events.register({
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

    const verified = await verifyEventFromChain(ctx.kaspa, ctx.network, entry.deployTxId);
    const availability = await eventAvailability(verified, ctx.kaspa, ctx.network);

    return {
      event: {
        covenant_id: verified.covenant_id,
        deploy_txid: verified.deploy_txid,
        name: verified.name,
        date: verified.date,
        time: verified.time,
        price: verified.price,
        capacity: verified.capacity,
        organizer_address: verified.organizer_address,
        verified: true,
      },
      availability,
      buy_info: {
        event_owner: verified.owner_pkh,
        org_spk: verified.org_spk,
        burn_template_hash: verified.burn_template_hash,
        authorizing_txid: verified.authorizing_txid,
        event_covenant_id: availability.event_covenant_id,
        event_txid: availability.event_txid,
        event_index: availability.event_index,
        remaining: availability.left,
      },
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
    const entries = ctx.events.list();
    const tickets = [];

    for (const entry of entries) {
      let verified;
      try {
        verified = await verifyEventFromChain(ctx.kaspa, ctx.network, entry.deployTxId);
      } catch (err) {
        if (isApiError(err) && err.type === "invalid") continue;
        throw err;
      }
      const addr = addressFor(
        verified.artifact,
        { owner: ownerBytes, identifierType: 0, amount: 1, isMinter: false },
        ctx.network,
      );

      const utxos = await ctx.kaspa.getUtxos(addr);
      for (const u of utxos) {
        tickets.push({
          ticket_id: `${u.outpoint.transactionId}:${u.outpoint.index}`,
          covenant_id: verified.covenant_id,
          event_name: verified.name,
          event_date: verified.date,
          event_time: verified.time,
        });
      }
    }

    return tickets;
  });

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
