// Operations for the OpenAPI document (KTK-154). Each builder owns one flow;
// `buildOperations` is only the composition. Request/response examples share
// named ids so prepare and finalize read as one story.

import { TICKET_DUST } from "@kticket/kit";
import type { JsonObject } from "./json.js";
import {
  BEARER_SECURITY,
  COVENANT_ID_PARAMETER,
  OPTIONAL_BEARER_SECURITY,
  TICKET_ID_PARAMETER,
  errorResponse,
  jsonRef,
  jsonRequestBody,
  jsonResponse,
  operation,
  type OpenApiOptions,
} from "./openapi-helpers.js";
import {
  EVENT_EXAMPLE,
  EXAMPLE_AUTHORIZING_TXID,
  EXAMPLE_BUYER_WALLET,
  EXAMPLE_COVENANT_ID,
  EXAMPLE_DEPLOY_TXID,
  EXAMPLE_ORG_PKH,
  EXAMPLE_ORG_SPK,
  EXAMPLE_ORGANIZER,
  EXAMPLE_SELLER_PKH,
  EXAMPLE_TICKET_ID,
  EXAMPLE_WALLET,
  WIRE_TRANSACTION_EXAMPLE,
} from "./openapi-examples.js";

export interface DocumentedOperation {
  method: "get" | "post";
  route: string;
  operation: JsonObject;
}

const EXAMPLE_NONCE = "b7c9e1f4a2d84c6e9f0a1b2c3d4e5f60";
const DEPLOY_ID = "f2b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d";
const BUY_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const USE_ID = "c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f";
const LIST_ID = "d4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f70";
const DELIST_ID = "e5f6a7b8-c9d0-4e1f-8a2b-3c4d5e6f7081";
const PURCHASE_ID = "f6a7b8c9-d0e1-4f2a-9b3c-4d5e6f708192";

/** A kaspa-wasm `signPskt` result for one input, as the docs show it. */
function signedInput(index: number, fill: string): JsonObject {
  return {
    inputs: [
      {
        transactionId: EXAMPLE_DEPLOY_TXID,
        index,
        signatureScript: `41${fill.repeat(64)}`,
      },
    ],
  };
}

const SIGNING_TEMPLATE_EXAMPLE = JSON.stringify(WIRE_TRANSACTION_EXAMPLE);

const EVENT_REF_EXAMPLE = {
  name: EVENT_EXAMPLE.name,
  date: EVENT_EXAMPLE.date,
} as const;

function eventListResponse(): JsonObject {
  return jsonResponse(
    "The verified events.",
    { type: "array", items: jsonRef("EventSummary") },
    [EVENT_EXAMPLE],
  );
}

function authOperations(options: OpenApiOptions): DocumentedOperation[] {
  return [
    {
      method: "post",
      route: "/v1/auth/challenge",
      operation: operation({
        operationId: "authChallenge",
        tag: "auth",
        summary: "Ask for a sign-in challenge",
        description:
          "Returns a single-use nonce and the exact message to sign. The message names the server's network id — never choose a network yourself.",
        body: jsonRequestBody(jsonRef("ChallengeRequest"), {
          address: EXAMPLE_ORGANIZER,
        }),
        responses: {
          200: jsonResponse("The challenge to sign.", jsonRef("ChallengeResponse"), {
            nonce: EXAMPLE_NONCE,
            message:
              `kticket\n\nkticket wants you to sign in with your Kaspa account:\n${EXAMPLE_ORGANIZER}\n\nURI: ${options.origin}\nVersion: 1\nChain ID: ${options.networkId}\nNonce: ${EXAMPLE_NONCE}\nIssued At: 2026-10-18T19:00:00.000Z`,
          }),
          400: errorResponse(400),
        },
      }),
    },
    {
      method: "post",
      route: "/v1/auth/session",
      operation: operation({
        operationId: "authSession",
        tag: "auth",
        summary: "Exchange a signed challenge for a session token",
        description:
          "The nonce is consumed on first use. The response carries the bearer token required by user-specific reads.",
        body: jsonRequestBody(jsonRef("SessionRequest"), {
          message: "kticket\n\nkticket wants you to sign in with your Kaspa account:\n...",
          signature: `41${"ab".repeat(64)}`,
        }),
        responses: {
          200: jsonResponse("The session token.", jsonRef("SessionResponse"), {
            token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ...",
            expires_in_seconds: 900,
          }),
          400: errorResponse(400),
          401: errorResponse(401),
        },
      }),
    },
  ];
}

function eventOperations(): DocumentedOperation[] {
  return [
    {
      method: "get",
      route: "/v1/events",
      operation: operation({
        operationId: "listEvents",
        tag: "events",
        summary: "List verified events",
        description:
          "Every registry entry is re-verified from the chain on read; entries that fail verification are hidden. Without `organizer_address` the call is public. With it, the call requires a bearer token and the address must match the signed-in wallet.",
        security: OPTIONAL_BEARER_SECURITY,
        parameters: [
          {
            name: "organizer_address",
            in: "query",
            required: false,
            description:
              "Filter to one organizer. Requires `Authorization: Bearer <token>` for that same address.",
            schema: { type: "string" },
          },
        ],
        responses: {
          200: eventListResponse(),
          401: errorResponse(401),
        },
      }),
    },
    {
      method: "post",
      route: "/v1/events",
      operation: operation({
        operationId: "registerEvent",
        tag: "events",
        summary: "Register a deployed event for discovery",
        description:
          "Looks the deploy transaction up on chain, verifies it, and adds its identifiers to the discovery registry. Deploying already registers the event; this exists for recovery and third-party clients.",
        body: jsonRequestBody(jsonRef("RegisterEventRequest"), {
          deploy_txid: EXAMPLE_DEPLOY_TXID,
        }),
        responses: {
          200: jsonResponse(
            "The registered event's covenant id.",
            jsonRef("RegisterEventResponse"),
            { covenant_id: EXAMPLE_COVENANT_ID },
          ),
          400: errorResponse(400),
          404: errorResponse(404),
        },
      }),
    },
    {
      method: "get",
      route: "/v1/events/:covenantId",
      operation: operation({
        operationId: "getEvent",
        tag: "events",
        summary: "Read one verified event",
        description:
          "Re-verifies the event from its deploy transaction and returns both the friendly facts and the raw chain facts they were derived from.",
        parameters: [COVENANT_ID_PARAMETER],
        responses: {
          200: jsonResponse("The event and its raw chain facts.", jsonRef("EventDetail"), {
            event: EVENT_EXAMPLE,
            raw_chain: {
              deploy_txid: EXAMPLE_DEPLOY_TXID,
              authorizing_txid: EXAMPLE_AUTHORIZING_TXID,
              maker_address: EXAMPLE_ORGANIZER,
              decoded_constants: {
                price: 1_000,
                org_spk: EXAMPLE_ORG_SPK,
                burn_template_hash: EXAMPLE_AUTHORIZING_TXID,
              },
              decoded_state: { owner: EXAMPLE_ORG_PKH, capacity: 2 },
              payload: null,
            },
          }),
          404: errorResponse(404),
        },
      }),
    },
  ];
}

function deployOperations(): DocumentedOperation[] {
  return [
    {
      method: "post",
      route: "/v1/events/deploy/prepare",
      operation: operation({
        operationId: "prepareDeploy",
        tag: "events",
        summary: "Prepare an event deploy",
        description:
          "The backend fetches the organizer's UTXOs, builds the unsigned deploy template, and returns the safe JSON the wallet signs. Nothing is broadcast until finalize.",
        body: jsonRequestBody(jsonRef("DeployPrepareRequest"), {
          capacity: 2,
          price_kas: 0.00001,
          ...EXAMPLE_WALLET,
          name: "Testnet Rave",
          date: "2026-12-31",
          time: "20:00",
        }),
        responses: {
          200: jsonResponse("The unsigned deploy template.", jsonRef("DeployPrepareResult"), {
            deploy_id: DEPLOY_ID,
            signing_template: SIGNING_TEMPLATE_EXAMPLE,
            event_covenant_id: EXAMPLE_COVENANT_ID,
            template: WIRE_TRANSACTION_EXAMPLE,
          }),
          400: errorResponse(400),
          422: errorResponse(422),
        },
      }),
    },
    {
      method: "post",
      route: "/v1/events/deploy/finalize",
      operation: operation({
        operationId: "finalizeDeploy",
        tag: "events",
        summary: "Finalize an event deploy",
        description:
          "Merges the wallet's signatures into the exact template it signed, validates it is a deploy, broadcasts it, waits for on-chain verification, and registers the event. Success is returned only after registration.",
        body: jsonRequestBody(jsonRef("DeployFinalizeRequest"), {
          deploy_id: DEPLOY_ID,
          template: WIRE_TRANSACTION_EXAMPLE,
          signed: signedInput(0, "ab"),
        }),
        responses: {
          200: jsonResponse("The deployed, registered event.", jsonRef("DeployFinalizeResult"), {
            covenant_id: EXAMPLE_COVENANT_ID,
            deploy_txid: EXAMPLE_DEPLOY_TXID,
          }),
          400: errorResponse(400),
          404: errorResponse(404),
          502: errorResponse(502),
        },
      }),
    },
  ];
}

function buyOperations(): DocumentedOperation[] {
  return [
    {
      method: "post",
      route: "/v1/events/:covenantId/buy/prepare",
      operation: operation({
        operationId: "prepareBuy",
        tag: "events",
        summary: "Prepare a primary ticket purchase",
        description:
          "Verifies the event from the chain, computes remaining capacity, fetches the buyer's UTXOs, and returns the unsigned buy template. The server has already prepared the covenant spend at input 0; sign the indices in `sign_inputs`.",
        parameters: [COVENANT_ID_PARAMETER],
        body: jsonRequestBody(jsonRef("BuyPrepareRequest"), EXAMPLE_WALLET),
        responses: {
          200: jsonResponse("The unsigned buy template.", jsonRef("BuyPrepareResult"), {
            buy_id: BUY_ID,
            signing_template: SIGNING_TEMPLATE_EXAMPLE,
            template: WIRE_TRANSACTION_EXAMPLE,
            sign_inputs: [{ index: 1 }],
            price: EVENT_EXAMPLE.price,
            ticket_deposit: TICKET_DUST,
          }),
          400: errorResponse(400),
          404: errorResponse(404),
          422: errorResponse(422),
        },
      }),
    },
    {
      method: "post",
      route: "/v1/events/:covenantId/buy/finalize",
      operation: operation({
        operationId: "finalizeBuy",
        tag: "events",
        summary: "Finalize a primary ticket purchase",
        description:
          "Merges signatures, validates the template is a buy (it must carry the ticket covenant output), broadcasts, and waits for the mint. Returns the transaction id.",
        parameters: [COVENANT_ID_PARAMETER],
        body: jsonRequestBody(jsonRef("BuyFinalizeRequest"), {
          buy_id: BUY_ID,
          template: WIRE_TRANSACTION_EXAMPLE,
          signed: signedInput(1, "cd"),
        }),
        responses: {
          200: jsonResponse("The confirmed mint transaction.", jsonRef("BuyFinalizeResult"), {
            txid: "1234".repeat(16),
          }),
          400: errorResponse(400),
          502: errorResponse(502),
        },
      }),
    },
  ];
}

function listingReadOperations(): DocumentedOperation[] {
  return [
    {
      method: "get",
      route: "/v1/listings",
      operation: operation({
        operationId: "listAllListings",
        tag: "resale",
        summary: "List every resale listing",
        description:
          "The workspace-wide resale directory. Each entry is proven on chain exactly as in the per-event listing.",
        responses: {
          200: jsonResponse("Every live resale listing.", {
            type: "array",
            items: jsonRef("ListingSummary"),
          }),
        },
      }),
    },
    {
      method: "get",
      route: "/v1/events/:covenantId/listings",
      operation: operation({
        operationId: "listEventListings",
        tag: "resale",
        summary: "List an event's resale listings",
        description:
          "Each entry is proven on chain: the ticket UTXO must still sit on the listed-state address for its recorded seller and price. Stale index rows are omitted.",
        parameters: [COVENANT_ID_PARAMETER],
        responses: {
          200: jsonResponse(
            "Live resale listings for the event.",
            { type: "array", items: jsonRef("ListingSummary") },
            [
              {
                ticket_id: EXAMPLE_TICKET_ID,
                price: 2_000,
                seller_pkh: EXAMPLE_SELLER_PKH,
                event_name: EVENT_EXAMPLE.name,
                event_date: EVENT_EXAMPLE.date,
                covenant_id: EVENT_EXAMPLE.covenant_id,
                verified: true,
              },
            ],
          ),
          404: errorResponse(404),
        },
      }),
    },
  ];
}

function ticketOperations(): DocumentedOperation[] {
  return [
    {
      method: "get",
      route: "/v1/tickets",
      operation: operation({
        operationId: "listMyTickets",
        tag: "tickets",
        summary: "List the signed-in wallet's tickets",
        description:
          "Returns the tickets held by the bearer token's wallet, including listed ones with their asking price. Any `owner_pkh` query is ignored — the wallet proof is authoritative.",
        security: BEARER_SECURITY,
        responses: {
          200: jsonResponse(
            "The caller's tickets.",
            { type: "array", items: jsonRef("TicketSummary") },
            [
              {
                ticket_id: EXAMPLE_TICKET_ID,
                covenant_id: EVENT_EXAMPLE.covenant_id,
                event_name: EVENT_EXAMPLE.name,
                event_date: EVENT_EXAMPLE.date,
                event_time: EVENT_EXAMPLE.time,
              },
            ],
          ),
          401: errorResponse(401),
        },
      }),
    },
  ];
}

function useOperations(): DocumentedOperation[] {
  return [
    {
      method: "post",
      route: "/v1/tickets/:ticketId/use/prepare",
      operation: operation({
        operationId: "prepareUse",
        tag: "tickets",
        summary: "Prepare a check-in (door flow)",
        description:
          "The owner pre-signs a mark-used template. The returned `use_id` and template travel in the QR payload; the gate co-signs input 0 later.",
        parameters: [TICKET_ID_PARAMETER],
        body: jsonRequestBody(jsonRef("UsePrepareRequest"), EXAMPLE_WALLET),
        responses: {
          200: jsonResponse("The check-in template the owner signs.", jsonRef("UsePrepareResult"), {
            use_id: USE_ID,
            signing_template: SIGNING_TEMPLATE_EXAMPLE,
            template: WIRE_TRANSACTION_EXAMPLE,
            sign_inputs_owner: [{ index: 0 }, { index: 1 }],
            event: EVENT_REF_EXAMPLE,
          }),
          400: errorResponse(400),
          404: errorResponse(404),
          422: errorResponse(422),
        },
      }),
    },
    {
      method: "post",
      route: "/v1/tickets/:ticketId/use/sign-template",
      operation: operation({
        operationId: "signUseTemplate",
        tag: "tickets",
        summary: "Rebuild a check-in signing template at the gate",
        description:
          "Statelessly re-derives the safe JSON from the template's prev-output chain facts, so the gate's co-signature is over exactly the bytes the owner signed.",
        parameters: [TICKET_ID_PARAMETER],
        body: jsonRequestBody(jsonRef("UseSignTemplateRequest"), {
          template: WIRE_TRANSACTION_EXAMPLE,
        }),
        responses: {
          200: jsonResponse("The rebuilt safe JSON.", jsonRef("UseSignTemplateResult"), {
            signing_template: SIGNING_TEMPLATE_EXAMPLE,
          }),
          400: errorResponse(400),
          404: errorResponse(404),
        },
      }),
    },
    {
      method: "post",
      route: "/v1/tickets/:ticketId/use/finalize",
      operation: operation({
        operationId: "finalizeUse",
        tag: "tickets",
        summary: "Finalize a check-in",
        description:
          "Assembles the owner's and the gate's signatures over input 0, broadcasts, and returns the confirmed transaction id.",
        parameters: [TICKET_ID_PARAMETER],
        body: jsonRequestBody(jsonRef("UseFinalizeRequest"), {
          use_id: USE_ID,
          template: WIRE_TRANSACTION_EXAMPLE,
          owner_signed: signedInput(0, "aa"),
          gate_signed: signedInput(0, "bb"),
        }),
        responses: {
          200: jsonResponse("The confirmed check-in transaction.", jsonRef("FinalizeResult"), {
            txid: "5678".repeat(16),
          }),
          400: errorResponse(400),
          404: errorResponse(404),
          422: errorResponse(422),
          502: errorResponse(502),
        },
      }),
    },
  ];
}

function listOperations(): DocumentedOperation[] {
  return [
    {
      method: "post",
      route: "/v1/tickets/:ticketId/list/prepare",
      operation: operation({
        operationId: "prepareList",
        tag: "resale",
        summary: "Prepare a resale listing",
        description:
          "The holder commits an asking price in sompi into the ticket covenant state. Ownership, unused status, and listing status are all proven on chain before the template is built.",
        parameters: [TICKET_ID_PARAMETER],
        body: jsonRequestBody(jsonRef("ListPrepareRequest"), {
          ...EXAMPLE_WALLET,
          price: 2_000,
        }),
        responses: {
          200: jsonResponse("The unsigned listing template.", jsonRef("ListPrepareResult"), {
            list_id: LIST_ID,
            signing_template: SIGNING_TEMPLATE_EXAMPLE,
            template: WIRE_TRANSACTION_EXAMPLE,
            sign_inputs: [{ index: 0 }, { index: 1 }],
            price: 2_000,
            event: EVENT_REF_EXAMPLE,
          }),
          400: errorResponse(400),
          404: errorResponse(404),
          422: errorResponse(422),
        },
      }),
    },
    {
      method: "post",
      route: "/v1/tickets/:ticketId/list/finalize",
      operation: operation({
        operationId: "finalizeList",
        tag: "resale",
        summary: "Finalize a resale listing",
        description:
          "Merges signatures, broadcasts the listed-state spend, and indexes the listing. The price must match the one sent to prepare.",
        parameters: [TICKET_ID_PARAMETER],
        body: jsonRequestBody(jsonRef("ListFinalizeRequest"), {
          template: WIRE_TRANSACTION_EXAMPLE,
          signed: signedInput(0, "ac"),
          price: 2_000,
        }),
        responses: {
          200: jsonResponse("The confirmed listing transaction.", jsonRef("FinalizeResult"), {
            txid: "9abc".repeat(16),
          }),
          400: errorResponse(400),
          404: errorResponse(404),
          502: errorResponse(502),
        },
      }),
    },
  ];
}

function delistOperations(): DocumentedOperation[] {
  return [
    {
      method: "post",
      route: "/v1/tickets/:ticketId/delist/prepare",
      operation: operation({
        operationId: "prepareDelist",
        tag: "resale",
        summary: "Prepare a delisting",
        description:
          "Clears a live listing. The recorded price comes from the index and is proven against the chain before the template is built.",
        parameters: [TICKET_ID_PARAMETER],
        body: jsonRequestBody(jsonRef("DelistPrepareRequest"), EXAMPLE_WALLET),
        responses: {
          200: jsonResponse("The unsigned delisting template.", jsonRef("DelistPrepareResult"), {
            delist_id: DELIST_ID,
            signing_template: SIGNING_TEMPLATE_EXAMPLE,
            template: WIRE_TRANSACTION_EXAMPLE,
            sign_inputs: [{ index: 0 }, { index: 1 }],
            event: EVENT_REF_EXAMPLE,
          }),
          400: errorResponse(400),
          404: errorResponse(404),
          422: errorResponse(422),
        },
      }),
    },
    {
      method: "post",
      route: "/v1/tickets/:ticketId/delist/finalize",
      operation: operation({
        operationId: "finalizeDelist",
        tag: "resale",
        summary: "Finalize a delisting",
        description:
          "Merges signatures, broadcasts the unlisted-state spend, and drops the index row.",
        parameters: [TICKET_ID_PARAMETER],
        body: jsonRequestBody(jsonRef("DelistFinalizeRequest"), {
          template: WIRE_TRANSACTION_EXAMPLE,
          signed: signedInput(0, "ad"),
        }),
        responses: {
          200: jsonResponse("The confirmed delisting transaction.", jsonRef("FinalizeResult"), {
            txid: "bcde".repeat(16),
          }),
          400: errorResponse(400),
          404: errorResponse(404),
          502: errorResponse(502),
        },
      }),
    },
  ];
}

function purchaseOperations(): DocumentedOperation[] {
  return [
    {
      method: "post",
      route: "/v1/tickets/:ticketId/purchase/prepare",
      operation: operation({
        operationId: "preparePurchase",
        tag: "resale",
        summary: "Prepare a trustless resale purchase",
        description:
          "The buyer does not need the seller online. The listing is proven on chain (live ticket UTXO on the listed-state address); input 0 is signatureless and only the buyer's fee inputs need signatures.",
        parameters: [TICKET_ID_PARAMETER],
        body: jsonRequestBody(jsonRef("PurchasePrepareRequest"), EXAMPLE_BUYER_WALLET),
        responses: {
          200: jsonResponse("The unsigned purchase template.", jsonRef("PurchasePrepareResult"), {
            purchase_id: PURCHASE_ID,
            signing_template: SIGNING_TEMPLATE_EXAMPLE,
            template: WIRE_TRANSACTION_EXAMPLE,
            sign_inputs: [{ index: 1 }],
            price: 2_000,
            ticket_deposit: TICKET_DUST,
            seller_proceeds: 2_000 + TICKET_DUST,
            seller_pkh: EXAMPLE_SELLER_PKH,
            event: EVENT_REF_EXAMPLE,
          }),
          400: errorResponse(400),
          404: errorResponse(404),
          422: errorResponse(422),
        },
      }),
    },
    {
      method: "post",
      route: "/v1/tickets/:ticketId/purchase/finalize",
      operation: operation({
        operationId: "finalizePurchase",
        tag: "resale",
        summary: "Finalize a trustless resale purchase",
        description:
          "Validates the escrow, broadcasts, and drops the index row. Returns the confirmed purchase transaction.",
        parameters: [TICKET_ID_PARAMETER],
        body: jsonRequestBody(jsonRef("PurchaseFinalizeRequest"), {
          template: WIRE_TRANSACTION_EXAMPLE,
          signed: signedInput(1, "ce"),
        }),
        responses: {
          200: jsonResponse(
            "The confirmed purchase transaction.",
            jsonRef("FinalizeResult"),
            { txid: "def0".repeat(16) },
          ),
          400: errorResponse(400),
          404: errorResponse(404),
          502: errorResponse(502),
        },
      }),
    },
  ];
}

/** Every documented operation, grouped by the flow that owns it. */
export function buildOperations(options: OpenApiOptions): DocumentedOperation[] {
  return [
    ...authOperations(options),
    ...eventOperations(),
    ...deployOperations(),
    ...buyOperations(),
    ...listingReadOperations(),
    ...ticketOperations(),
    ...useOperations(),
    ...listOperations(),
    ...delistOperations(),
    ...purchaseOperations(),
  ];
}
