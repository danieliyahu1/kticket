// kticket API routes (HLD v0.21 §2.2):
//   GET  /v1/events                   — directory of registered events
//   POST /v1/events                   — register an event after deploy
//   GET  /v1/events/{covenant_id}     — event + availability (sold / left)
//   GET  /v1/tickets                  — user's on-chain tickets (?owner_pkh=)
//   GET  /v1/tickets/{ticket_id}      — verify walk (alive | gone | unknown)
//   POST /v1/tx/build                 — unsigned v1 template (fee-aware)
//   POST /v1/tx/broadcast             — relay signed tx -> {txid}
//
// NOTE: The route parameter is the event's KIP-20 `covenant_id` (64-hex
// family id). `event_id` (authorizing_txid) is now stored internally.

import {
  addressFor,
  buildRedeemScript,
  covenantId,
  decodeMetadataFromPayload,
  DUST,
  EVENT_ARTIFACT,
  type KaspaNetwork,
  p2shScript,
} from "@kticket/kit";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { FastifyInstance } from "fastify";
import { invalidError, isApiError, notFoundError } from "./errors.js";
import { eventAvailability, parseRegisterEventBody } from "./events.js";
import type { EventStore, StoredEventInternal } from "./eventstore.js";
import type { KaspaClientLike } from "./kaspa-client.js";
import type { TxModel } from "./kaspa-types.js";
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
        price: event.price,
      })),
  );

  app.post("/v1/events", async (req) => {
    try {
      const payload = parseRegisterEventBody(req.body);

      const deploy = await fetchDeployTx(ctx.kaspa, payload.genesisTxId);
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

      const meta = decodeMetadataFromPayload(deploy.payload);

      const event: StoredEventInternal = {
        covenantId: covenantIdHex,
        genesisTxId: payload.genesisTxId,
        orgPkh: payload.orgPkh,
        name: meta?.name ?? payload.name,
        date: meta?.date ?? payload.date,
        price: meta?.price ?? payload.price,
        capacity: payload.capacity,
        orgSpk: payload.orgSpk,
        burnTemplateHash: payload.burnTemplateHash,
      authorizingTxId: payload.authorizingTxId,
    };

    ctx.events.register(event);
    return { covenant_id: covenantIdHex };
    } catch (err) {
      if (isApiError(err)) {
        req.log.error({ detail: err.detail }, "event registration failed");
      }
      throw err;
    }
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

  app.get<{ Querystring: { owner_pkh?: string } }>("/v1/tickets", async (req) => {
    const ownerPkh = req.query.owner_pkh;
    if (!ownerPkh) throw invalidError("owner_pkh query parameter is required");

    const ownerBytes = hexToBytes(ownerPkh);
    const events = ctx.events.list().filter(hasFullConstants);
    if (events.length === 0) return [];

    const addressMap = new Map<string, StoredEventInternal>();
    const addresses: string[] = [];
    for (const event of events) {
      const addr = addressFor(
        { owner: ownerBytes, identifierType: 0, amount: 1, isMinter: false },
        {
          authorizingTxId: hexToBytes(event.authorizingTxId),
          price: event.price,
          orgSpk: hexToBytes(event.orgSpk),
          burnTemplateHash: hexToBytes(event.burnTemplateHash),
        },
        hexToBytes(EVENT_ARTIFACT.code),
        ctx.network,
      );
      addressMap.set(addr, event);
      addresses.push(addr);
    }

    const utxos = await ctx.kaspa.getUtxosForAddresses(addresses);
    return utxos
      .filter((u) => isP2shScript(u.utxoEntry.scriptPublicKey.scriptPublicKey))
      .map((u) => {
        const event = addressMap.get(u.address ?? "");
        if (!event) return null;
        return {
          ticket_id: `${u.outpoint.transactionId}:${u.outpoint.index}`,
          covenant_id: event.covenantId,
          event_name: event.name,
          event_date: event.date,
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
  });

  app.get<{ Params: { ticketId: string } }>("/v1/tickets/:ticketId", async (req) => {
    const { ticketId } = req.params;
    return verifyTicket(ticketId, ctx);
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

const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_RETRIES = 2;

const P2SH_PREFIX = "aa20";
const P2SH_SUFFIX = "87";

function hasFullConstants(event: StoredEventInternal): boolean {
  return event.orgSpk.length > 0 && event.burnTemplateHash.length > 0 && event.authorizingTxId.length > 0;
}

function isP2shScript(script: string): boolean {
  return script.startsWith(P2SH_PREFIX) && script.endsWith(P2SH_SUFFIX);
}

async function fetchDeployTx(kaspa: KaspaClientLike, txId: string): Promise<TxModel | null> {
  let delay = INITIAL_RETRY_DELAY_MS;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const deploy = await kaspa.getTransaction(txId);
    if (deploy) return deploy;

    if (attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }

  return null;
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
