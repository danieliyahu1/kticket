// kticket API routes (HLD v0.21 §2.2):
//   GET  /v1/events            — directory of registered events
//   GET  /v1/events/{event_id} — event + availability (sold / left)
//   GET  /v1/tickets/{ticket_id} — verify walk (alive | gone | unknown)
//   POST /v1/tx/build          — unsigned v1 template (fee-aware)
//   POST /v1/tx/broadcast      — relay signed tx -> {txid}

import type { KaspaNetwork } from "@kticket/kit";
import type { FastifyInstance } from "fastify";
import { invalidError } from "./errors.js";
import { type EventRegistry, eventAvailability } from "./events.js";
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

function toEventJson(event: { eventId: string; name: string; date: string; price: number }) {
  return {
    event_id: event.eventId,
    name: event.name,
    date: event.date,
    price: event.price,
  };
}

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/events", async () =>
    ctx.events.list().map((event) => ({
      event_id: event.eventId,
      genesis_txid: event.genesisTxId,
      name: event.name,
      date: event.date,
      price: event.price,
      capacity: event.capacity,
    })),
  );

  app.get<{ Params: { eventId: string } }>("/v1/events/:eventId", async (req) => {
    const { eventId } = req.params;
    const event = ctx.events.byEventId(eventId);
    if (!event) throw invalidError(`unknown event ${eventId}`);
    const availability = await eventAvailability(event, ctx.kaspa, ctx.network);
    return {
      event: toEventJson(event),
      availability,
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
