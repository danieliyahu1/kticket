// kticket API routes (HLD v0.27 §2.2):
//   GET  /v1/events                   — directory of verified events (from the registry)
//   POST /v1/events                   — register an event after deploy (discovery only)
//   GET  /v1/events/{covenant_id}     — verified event + availability + raw chain facts
//   GET  /v1/tickets                  — user's on-chain tickets (?owner_pkh=)
//   GET  /v1/tickets/{ticket_id}      — verify walk (alive | gone | unknown)
//   POST /v1/tx/build                 — unsigned v1 template (fee-aware)
//   POST /v1/tx/broadcast             — relay signed tx -> {txid}
//
// KTK-89 (stateless backend): the identifier registry holds only
// `{deploy_txid, covenant_id, organizer_address}` for discovery. Every event
// read calls `verifyEventFromChain` — the chain is the source of truth, and the
// response carries raw chain facts so any displayed value can be re-checked.
// Events that fail on-chain verification are hidden from the directory.

import {
  addressFor,
  type KaspaNetwork,
} from "@kticket/kit";
import { hexToBytes } from "@noble/hashes/utils.js";
import type { FastifyInstance } from "fastify";
import { invalidError, isApiError, notFoundError } from "./errors.js";
import { deployFinalize, deployPrepare } from "./deploy.js";
import { eventAvailability } from "./events.js";
import type { EventStore } from "./eventstore.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import { verifyEventFromChain } from "./provenance.js";
import { verifyTicket } from "./reader.js";
import { broadcastTransaction, buildTransaction } from "./tx.js";
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

  app.post("/v1/events/deploy", async (req) => {
    try {
      const body = req.body;
      const phase =
        typeof body === "object" && body !== null && "phase" in body
          ? (body as { phase: unknown }).phase
          : undefined;
      if (phase === "prepare") {
        return await deployPrepare(body, {
          kaspa: ctx.kaspa,
          networkId: ctx.networkId,
          network: ctx.network,
          register: (e) => ctx.events.register(e),
        });
      }
      if (phase === "finalize") {
        return await deployFinalize(body, {
          kaspa: ctx.kaspa,
          networkId: ctx.networkId,
          network: ctx.network,
          register: (e) => ctx.events.register(e),
        });
      }
      throw invalidError("phase must be prepare|finalize");
    } catch (err) {
      if (isApiError(err)) {
        req.log.error({ detail: err.detail }, "deploy failed");
      }
      throw err;
    }
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

    const ownerBytes = hexToBytes(ownerPkh);
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
        });
      }
    }

    return tickets;
  });

  app.get<{ Params: { ticketId: string } }>("/v1/tickets/:ticketId", async (req) => {
    const { ticketId } = req.params;
    return verifyTicket(ticketId, {
      kaspa: ctx.kaspa,
      network: ctx.network,
      events: {
        resolve: async (covenantId) => {
          const entry = ctx.events.byCovenantId(covenantId);
          if (!entry) return undefined;
          try {
            const verified = await verifyEventFromChain(ctx.kaspa, ctx.network, entry.deployTxId);
            return {
              authorizingTxId: verified.authorizing_txid,
              name: verified.name,
              date: verified.date,
              price: verified.price,
            };
          } catch {
            return undefined;
          }
        },
      },
    });
  });

  app.post("/v1/tx/build", async (req) => {
    try {
      return await buildTransaction(req.body, { kaspa: ctx.kaspa, networkId: ctx.networkId });
    } catch (err) {
      if (isApiError(err)) {
        req.log.error({ detail: err.detail }, "build failed");
      }
      throw err;
    }
  });

  app.post("/v1/tx/broadcast", async (req) => {
    try {
      return await broadcastTransaction(req.body, { kaspa: ctx.kaspa, networkId: ctx.networkId });
    } catch (err) {
      if (isApiError(err)) {
        req.log.error({ detail: err.detail }, "broadcast rejected by node");
      }
      throw err;
    }
  });
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
