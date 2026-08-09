// kticket API routes (HLD v0.21 §2.2):
//   GET  /v1/events                   — directory of registered events
//   POST /v1/events                   — register an event after deploy
//   GET  /v1/events/{event_id}        — event + availability (sold / left)
//   GET  /v1/tickets/{ticket_id}      — verify walk (alive | gone | unknown)
//   POST /v1/tx/build                 — unsigned v1 template (fee-aware)
//   POST /v1/tx/broadcast             — relay signed tx -> {txid}
//
// NOTE: The `event_id` in route paths is the deploy's `authorizing_txid` — the
// 64-hex transaction hash of the authorizing UTXO selected for the deploy.

import type { KaspaNetwork } from "@kticket/kit";
import type { FastifyInstance } from "fastify";
import { invalidError, notFoundError } from "./errors.js";
import { type EventRegistry, eventAvailability, parseRegisterEventBody } from "./events.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import { verifyTicket } from "./reader.js";
import { broadcastTransaction, buildTransaction } from "./tx.js";

export interface AppContext {
  kaspa: KaspaClientLike;
  events: EventRegistry;
  network: KaspaNetwork;
  /** wRPC network id for broadcast ("testnet-10"). */
  networkId: string;
}

function toEventJson(event: {
  eventId: string;
  genesisTxId: string;
  name: string;
  date: string;
  price: number;
  capacity: number;
}) {
  return {
    authorizing_txid: event.eventId,
    genesis_txid: event.genesisTxId,
    name: event.name,
    date: event.date,
    price: event.price,
    capacity: event.capacity,
  };
}

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: { org_pkh?: string } }>(
    "/v1/events",
    async (req) =>
      ctx.events.list(req.query.org_pkh).map((event) => ({
        authorizing_txid: event.eventId,
        genesis_txid: event.genesisTxId,
        name: event.name,
        date: event.date,
        price: event.price,
        capacity: event.capacity,
      })),
  );

  app.post("/v1/events", async (req) => {
    const event = parseRegisterEventBody(req.body);
    ctx.events.register(event);
    return { authorizing_txid: event.eventId };
  });

  app.get<{ Params: { eventId: string } }>("/v1/events/:eventId", async (req) => {
    const { eventId } = req.params;
    const event = ctx.events.byEventId(eventId);
    if (!event) throw notFoundError(`event ${eventId} not found`);
    const availability = await eventAvailability(event, ctx.kaspa, ctx.network);
    return {
      event: toEventJson(event),
      availability,
      buy_info: {
        event_owner: event.orgPkh,
        org_spk: event.orgSpk,
        burn_template_hash: event.burnTemplateHash,
        event_covenant_id: availability.event_covenant_id,
        event_txid: availability.event_txid,
        event_index: availability.event_index,
        remaining: availability.left,
      },
    };
  });

  app.get<{ Params: { ticketId: string } }>("/v1/tickets/:ticketId", async (req) => {
    const { ticketId } = req.params;
    return verifyTicket(ticketId, ctx);
  });

  app.post("/v1/tx/build", async (req) =>
    buildTransaction(req.body, { kaspa: ctx.kaspa, networkId: ctx.networkId }),
  );

  app.post("/v1/tx/broadcast", async (req) =>
    broadcastTransaction(req.body, { kaspa: ctx.kaspa, networkId: ctx.networkId }),
  );
}
