// kticket API routes (HLD v0.21 §2.2):
//   GET  /v1/events                   — directory of registered events
//   POST /v1/events                   — register an event after deploy
//   GET  /v1/events/{covenant_id}     — event + availability (sold / left)
//   GET  /v1/tickets/{ticket_id}      — verify walk (alive | gone | unknown)
//   POST /v1/tx/build                 — unsigned v1 template (fee-aware)
//   POST /v1/tx/broadcast             — relay signed tx -> {txid}
//
// NOTE: The route parameter is the event's KIP-20 `covenant_id` (64-hex
// family id). `event_id` (authorizing_txid) is now stored internally.

import {
  buildRedeemScript,
  covenantId,
  DUST,
  EVENT_ARTIFACT,
  type KaspaNetwork,
  p2shScript,
} from "@kticket/kit";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { FastifyInstance } from "fastify";
import { invalidError, notFoundError } from "./errors.js";
import { eventAvailability, parseRegisterEventBody } from "./events.js";
import type { EventStore, StoredEventInternal } from "./eventstore.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import { verifyTicket } from "./reader.js";
import { broadcastTransaction, buildTransaction } from "./tx.js";

export interface AppContext {
  kaspa: KaspaClientLike;
  events: EventStore;
  network: KaspaNetwork;
  networkId: string;
}

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: { org_pkh?: string } }>(
    "/v1/events",
    async (req) =>
      ctx.events.list(req.query.org_pkh).map((event) => ({
        covenant_id: event.covenantId,
        genesis_txid: event.genesisTxId,
        name: event.name,
        date: event.date,
      })),
  );

  app.post("/v1/events", async (req) => {
    const payload = parseRegisterEventBody(req.body);

    const deploy = await ctx.kaspa.getTransaction(payload.genesisTxId);
    if (!deploy) {
      throw invalidError(`deploy transaction ${payload.genesisTxId} not found on chain`);
    }

    const authorizingInput = deploy.inputs?.[0];
    if (!authorizingInput) {
      throw invalidError(`deploy transaction ${payload.genesisTxId} has no inputs`);
    }

    const onChainAuthorizingTxId = authorizingInput.previous_outpoint_hash.toLowerCase();
    if (onChainAuthorizingTxId !== payload.authorizingTxId.toLowerCase()) {
      throw invalidError(
        `authorizing_txid ${payload.authorizingTxId} does not match deploy transaction input ${onChainAuthorizingTxId}`,
      );
    }

    const covenantIdHex = computeCovenantId(payload);
    if (!covenantIdHex) {
      throw invalidError("could not compute covenant_id from deploy transaction");
    }

    const event: StoredEventInternal = {
      covenantId: covenantIdHex,
      genesisTxId: payload.genesisTxId,
      orgPkh: payload.orgPkh,
      name: payload.name,
      date: payload.date,
      price: payload.price,
      capacity: payload.capacity,
      orgSpk: payload.orgSpk,
      burnTemplateHash: payload.burnTemplateHash,
      authorizingTxId: payload.authorizingTxId,
    };

    ctx.events.register(event);
    return { covenant_id: covenantIdHex };
  });

  app.get<{ Params: { covenantId: string } }>("/v1/events/:covenantId", async (req) => {
    const { covenantId: id } = req.params;
    const event = ctx.events.byCovenantId(id);
    if (!event) throw notFoundError(`event ${id} not found`);
    const availability = await eventAvailability(event, ctx.kaspa, ctx.network);
    return {
      event: {
        covenant_id: event.covenantId,
        genesis_txid: event.genesisTxId,
        name: event.name,
        date: event.date,
        price: event.price,
        capacity: event.capacity,
      },
      availability,
      buy_info: {
        event_owner: event.orgPkh,
        org_spk: event.orgSpk,
        burn_template_hash: event.burnTemplateHash,
        authorizing_txid: event.authorizingTxId,
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

function computeCovenantId(payload: {
  authorizingTxId: string;
  orgPkh: string;
  price: number;
  capacity: number;
  orgSpk: string;
  burnTemplateHash: string;
}): string | null {
  const eventState = {
    owner: hexToBytes(payload.orgPkh),
    identifierType: 0 as const,
    amount: payload.capacity,
    isMinter: false,
  };
  const constants = {
    authorizingTxId: hexToBytes(payload.authorizingTxId),
    price: payload.price,
    orgSpk: hexToBytes(payload.orgSpk),
    burnTemplateHash: hexToBytes(payload.burnTemplateHash),
  };
  const redeemScript = buildRedeemScript(
    eventState,
    constants,
    hexToBytes(EVENT_ARTIFACT.code),
  );
  const eventScript = p2shScript(redeemScript);

  return bytesToHex(
    covenantId(
      { txId: hexToBytes(payload.authorizingTxId), index: 0 },
      [
        {
          index: 0,
          value: DUST,
          version: 0,
          script: hexToBytes(eventScript.script),
        },
      ],
    ),
  );
}
