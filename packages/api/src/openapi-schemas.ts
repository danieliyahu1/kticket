// Component schemas for the OpenAPI document (KTK-154). Each builder owns one
// area of the wire surface; `buildComponents` is only the composition.

import { MAX_EVENT_CAPACITY } from "@kticket/kit";
import type { JsonObject } from "./json.js";
import {
  HEX64_PATTERN,
  HEX_PATTERN,
  PUBLIC_KEY_PATTERN,
  TICKET_ID_PATTERN,
  jsonContent,
  jsonRef,
} from "./openapi-helpers.js";

const PUBLIC_KEY_SCHEMA: JsonObject = {
  type: "string",
  pattern: PUBLIC_KEY_PATTERN,
  description: "Compressed (66 hex) or bare x-coordinate (64 hex) Kaspa public key.",
};

const ADDRESS_SCHEMA: JsonObject = {
  type: "string",
  description: "The wallet's bech32 address; the backend fetches its UTXOs itself.",
};

const SIGNING_OUTPUT_SCHEMA: JsonObject = {
  description:
    "The wallet's signing output. A kaspa-wasm `signPskt` result (object) or a safe-JSON string; the server only merges signatures over the template it issued.",
  anyOf: [{ type: "object" }, { type: "string" }],
};

const INPUT_INDEX_SCHEMA: JsonObject = {
  type: "object",
  required: ["index"],
  properties: { index: { type: "integer", minimum: 0 } },
};

const EVENT_REF_SCHEMA: JsonObject = {
  type: "object",
  required: ["name", "date"],
  properties: { name: { type: "string" }, date: { type: "string" } },
};

function errorEnvelopeSchema(): JsonObject {
  return {
    type: "object",
    description:
      "Every failure uses this envelope. `type` is stable and machine-readable; `retryable` says whether the same request may succeed on retry.",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["type", "message", "retryable"],
        properties: {
          type: {
            type: "string",
            description:
              "One of `invalid`, `conflict`, `policy`, `network`, `upstream`, `unauthorized`, or `unknown-*`.",
          },
          message: { type: "string", description: "Human-readable explanation." },
          retryable: {
            type: "boolean",
            description: "True when the same request may succeed later without changes.",
          },
          retryAfter: {
            type: "integer",
            minimum: 0,
            description: "Seconds to wait before retrying, when the server knows.",
          },
          detail: { description: "Optional machine-readable context." },
        },
      },
    },
  };
}

function finalizeResultSchema(): JsonObject {
  return {
    type: "object",
    required: ["txid"],
    properties: { txid: { type: "string", pattern: HEX64_PATTERN } },
  };
}

function authSchemas(): JsonObject {
  return {
    ChallengeRequest: {
      type: "object",
      required: ["address"],
      properties: { address: ADDRESS_SCHEMA },
    },
    ChallengeResponse: {
      type: "object",
      required: ["nonce", "message"],
      properties: {
        nonce: {
          type: "string",
          description: "Single-use nonce, consumed by session exchange.",
        },
        message: {
          type: "string",
          description: "Sign this verbatim with the wallet's private key.",
        },
      },
    },
    SessionRequest: {
      type: "object",
      required: ["message", "signature"],
      properties: {
        message: {
          type: "string",
          description: "The `message` from the challenge response.",
        },
        signature: {
          type: "string",
          description: "Kaspa Schnorr message signature over `message`, hex or base64.",
        },
      },
    },
    SessionResponse: {
      type: "object",
      required: ["token", "expires_in_seconds"],
      properties: {
        token: { type: "string", description: "Bearer token for authenticated routes." },
        expires_in_seconds: { type: "integer", minimum: 0 },
      },
    },
  };
}

function wireSchemas(): JsonObject {
  return {
    WireScriptPublicKey: {
      type: "object",
      description: "A Kaspa script public key: version plus hex-encoded script.",
      required: ["version", "script"],
      properties: {
        version: { type: "integer", minimum: 0 },
        script: { type: "string", pattern: HEX_PATTERN, description: "Hex-encoded script." },
      },
    },
    WireOutpoint: {
      type: "object",
      required: ["transaction_id", "index"],
      properties: {
        transaction_id: { type: "string", pattern: HEX64_PATTERN },
        index: { type: "integer", minimum: 0 },
      },
    },
    WireCovenant: {
      type: "object",
      required: ["authorizing_input", "covenant_id"],
      properties: {
        authorizing_input: { type: "integer", minimum: 0 },
        covenant_id: { type: "string", pattern: HEX64_PATTERN },
      },
    },
    WireInput: {
      type: "object",
      required: ["previous_outpoint", "signature_script", "sequence", "sig_op_count"],
      properties: {
        previous_outpoint: jsonRef("WireOutpoint"),
        signature_script: { type: "string", pattern: HEX_PATTERN },
        sequence: { type: "integer", minimum: 0 },
        sig_op_count: { type: "integer", minimum: 0 },
      },
    },
    WireOutput: {
      type: "object",
      required: ["value", "script_public_key", "covenant"],
      properties: {
        value: { type: "integer", minimum: 0, description: "Amount in sompi." },
        script_public_key: jsonRef("WireScriptPublicKey"),
        covenant: {
          description: "The covenant binding, or null for an ordinary output.",
          anyOf: [jsonRef("WireCovenant"), { type: "null" }],
        },
      },
    },
    WireTransaction: {
      type: "object",
      description:
        "The unsigned transaction template. It is also carried inside `signing_template` as kaspa-wasm safe JSON.",
      required: ["version", "inputs", "outputs", "lock_time"],
      properties: {
        version: { type: "integer", minimum: 0 },
        inputs: { type: "array", items: jsonRef("WireInput") },
        outputs: { type: "array", items: jsonRef("WireOutput") },
        lock_time: { type: "integer", minimum: 0 },
        payload: {
          type: "string",
          pattern: HEX_PATTERN,
          description:
            "Hex-encoded transaction payload. On a KCC-23 preparation tx it is the metadata declaration: `0x00` (JSON codec) followed by the UTF-8 JSON object, e.g. `007b7d` for `{}`.",
        },
      },
    },
  };
}

function eventSchemas(): JsonObject {
  return {
    EventSummary: {
      type: "object",
      description:
        "Chain-verified event facts. Every field is re-derived from the deploy transaction on each read.",
      required: [
        "covenant_id",
        "deploy_txid",
        "name",
        "date",
        "time",
        "ticker",
        "decimals",
        "image",
        "image_hash",
        "price",
        "capacity",
        "organizer_address",
        "verified",
      ],
      properties: {
        covenant_id: { type: "string", pattern: HEX64_PATTERN },
        deploy_txid: { type: "string", pattern: HEX64_PATTERN },
        name: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD; empty when absent." },
        time: { type: "string", description: "Local wall-clock HH:MM; empty when absent." },
        ticker: { type: "string" },
        decimals: { type: "integer", minimum: 0 },
        image: {
          type: "string",
          description: "https:// or ipfs:// URI; empty when absent.",
        },
        image_hash: { type: "string", description: "Lowercase hex; empty when absent." },
        price: { type: "integer", minimum: 0, description: "Ticket price in sompi." },
        capacity: { type: "integer", minimum: 0, maximum: MAX_EVENT_CAPACITY },
        organizer_address: { type: "string", description: "The event's trust anchor." },
        verified: { type: "boolean", const: true },
      },
    },
    EventDetail: {
      type: "object",
      required: ["event", "raw_chain"],
      properties: {
        event: jsonRef("EventSummary"),
        raw_chain: jsonRef("RawChainFacts"),
      },
    },
    RawChainFacts: {
      type: "object",
      description:
        "Raw on-chain facts behind an event, so any displayed value can be re-checked.",
      required: [
        "deploy_txid",
        "authorizing_txid",
        "metadata_txid",
        "maker_address",
        "decoded_constants",
        "decoded_state",
        "payload",
      ],
      properties: {
        deploy_txid: { type: "string", pattern: HEX64_PATTERN },
        authorizing_txid: { type: "string", pattern: HEX64_PATTERN },
        metadata_txid: {
          type: ["string", "null"],
          pattern: HEX64_PATTERN,
          description:
            "Transaction whose payload carried the KCC-23 metadata declaration (the preparation tx); legacy deploys carry it on the genesis tx. Null when the event declares no metadata.",
        },
        maker_address: { type: "string" },
        decoded_constants: {
          type: "object",
          required: ["price", "org_spk", "burn_template_hash"],
          properties: {
            price: { type: "integer", minimum: 0 },
            org_spk: { type: "string", pattern: HEX_PATTERN },
            burn_template_hash: { type: "string", pattern: HEX64_PATTERN },
          },
        },
        decoded_state: {
          type: "object",
          required: ["owner", "capacity"],
          properties: {
            owner: { type: "string", pattern: HEX64_PATTERN },
            capacity: { type: "integer", minimum: 0, maximum: MAX_EVENT_CAPACITY },
          },
        },
        payload: {
          type: ["string", "null"],
          description:
            "The hex-encoded metadata payload, read from `metadata_txid`. Null when the event declares no metadata.",
        },
      },
    },
    RegisterEventRequest: {
      type: "object",
      description: "Discovery-only registration: the deploy txid is the retrieval key.",
      anyOf: [{ required: ["deploy_txid"] }, { required: ["genesis_txid"] }],
      properties: {
        deploy_txid: { type: "string", pattern: HEX64_PATTERN },
        genesis_txid: {
          type: "string",
          pattern: HEX64_PATTERN,
          deprecated: true,
          description: "Legacy alias for `deploy_txid`.",
        },
      },
    },
    RegisterEventResponse: {
      type: "object",
      required: ["covenant_id"],
      properties: { covenant_id: { type: "string", pattern: HEX64_PATTERN } },
    },
  };
}

function deploySchemas(): JsonObject {
  const prepareProperties: JsonObject = {
    capacity: {
      type: "integer",
      minimum: 0,
      maximum: MAX_EVENT_CAPACITY,
      description: "Number of tickets the event can mint.",
    },
    price_kas: {
      type: "number",
      minimum: 0,
      description: "Ticket price in KAS (not sompi).",
    },
    publicKey: PUBLIC_KEY_SCHEMA,
    address: ADDRESS_SCHEMA,
    name: { type: "string" },
    date: { type: "string", description: "YYYY-MM-DD; required with `name`." },
    time: { type: "string", description: "HH:MM; requires `date`." },
    ticker: {
      type: "string",
      description: "Ecosystem token ticker, declared in the KCC-23 metadata.",
    },
    decimals: { type: "integer", minimum: 0, maximum: 255 },
    image: { type: "string", description: "https:// or ipfs:// poster URI." },
    image_hash: { type: "string", description: "sha256 of the poster, 64 hex." },
  };
  const signingRound: JsonObject = {
    type: "object",
    required: ["template", "signing_template"],
    properties: {
      template: jsonRef("WireTransaction"),
      signing_template: {
        type: "string",
        description: "kaspa-wasm safe JSON the wallet signs.",
      },
    },
  };
  const signedTemplate: JsonObject = {
    type: "object",
    required: ["template", "signed"],
    properties: {
      template: jsonRef("WireTransaction"),
      signed: jsonRef("SigningOutput"),
    },
  };
  return {
    DeployPrepareRequest: {
      type: "object",
      description:
        "The event to deploy. The backend derives the organizer payout and preparation output scripts from `publicKey`; it never trusts a caller-supplied owner or script.",
      required: ["capacity", "price_kas", "publicKey", "address"],
      properties: prepareProperties,
    },
    DeployPrepareResult: {
      type: "object",
      description:
        "The KCC-23 preparation round: sign `preparation.signing_template`, then post it back with this request to `deploy/genesis`.",
      required: ["deploy_id", "preparation"],
      properties: {
        deploy_id: {
          type: "string",
          description: "Correlation id echoed on genesis and finalize.",
        },
        preparation: signingRound,
      },
    },
    DeployGenesisRequest: {
      type: "object",
      description:
        "The prepare request again, plus the deploy id and the signed preparation transaction. The backend relays it and returns the genesis template to sign.",
      required: ["deploy_id", "preparation", "capacity", "price_kas", "publicKey", "address"],
      properties: {
        ...prepareProperties,
        deploy_id: { type: "string" },
        preparation: signedTemplate,
      },
    },
    DeployGenesisResult: {
      type: "object",
      description:
        "The genesis round: `preparation_txid` is the transaction whose payload commits the metadata; sign `genesis.signing_template` and post it to `deploy/finalize`.",
      required: ["preparation_txid", "event_covenant_id", "genesis"],
      properties: {
        preparation_txid: { type: "string", pattern: HEX64_PATTERN },
        event_covenant_id: { type: "string", pattern: HEX64_PATTERN },
        genesis: signingRound,
      },
    },
    DeployFinalizeRequest: {
      type: "object",
      required: ["deploy_id", "template", "signed"],
      properties: {
        deploy_id: { type: "string" },
        template: jsonRef("WireTransaction"),
        signed: jsonRef("SigningOutput"),
      },
    },
    DeployFinalizeResult: {
      type: "object",
      required: ["covenant_id", "deploy_txid"],
      properties: {
        covenant_id: { type: "string", pattern: HEX64_PATTERN },
        deploy_txid: {
          type: "string",
          pattern: HEX64_PATTERN,
          description: "The genesis transaction id.",
        },
      },
    },
  };
}

function buySchemas(): JsonObject {
  return {
    BuyPrepareRequest: {
      type: "object",
      required: ["publicKey", "address"],
      properties: { publicKey: PUBLIC_KEY_SCHEMA, address: ADDRESS_SCHEMA },
    },
    BuyPrepareResult: {
      type: "object",
      required: [
        "buy_id",
        "signing_template",
        "template",
        "sign_inputs",
        "price",
        "ticket_deposit",
      ],
      properties: {
        buy_id: { type: "string", description: "Correlation id echoed on finalize." },
        signing_template: { type: "string" },
        template: jsonRef("WireTransaction"),
        sign_inputs: {
          type: "array",
          description: "Inputs the wallet must sign — all but the covenant spend at index 0.",
          items: jsonRef("InputIndex"),
        },
        price: { type: "integer", minimum: 0, description: "Ticket price in sompi." },
        ticket_deposit: {
          type: "integer",
          minimum: 0,
          description: "Deposit carried by the newly minted ticket, in sompi.",
        },
      },
    },
    BuyFinalizeRequest: {
      type: "object",
      required: ["buy_id", "template", "signed"],
      properties: {
        buy_id: { type: "string" },
        template: jsonRef("WireTransaction"),
        signed: jsonRef("SigningOutput"),
      },
    },
    BuyFinalizeResult: {
      type: "object",
      required: ["txid"],
      properties: { txid: { type: "string", pattern: HEX64_PATTERN } },
    },
  };
}

function ticketSchemas(): JsonObject {
  return {
    TicketSummary: {
      type: "object",
      required: ["ticket_id", "covenant_id", "event_name", "event_date", "event_time"],
      properties: {
        ticket_id: { type: "string", pattern: TICKET_ID_PATTERN },
        covenant_id: { type: "string", pattern: HEX64_PATTERN },
        event_name: { type: "string" },
        event_date: { type: "string" },
        event_time: { type: "string" },
        listed: { type: "boolean", description: "Present and true for a listed ticket." },
        price: {
          type: "integer",
          minimum: 0,
          description: "Asking price in sompi; present only for a listed ticket.",
        },
      },
    },
  };
}

function useSchemas(): JsonObject {
  return {
    UsePrepareRequest: {
      type: "object",
      required: ["publicKey", "address"],
      properties: { publicKey: PUBLIC_KEY_SCHEMA, address: ADDRESS_SCHEMA },
    },
    UsePrepareResult: {
      type: "object",
      required: ["use_id", "signing_template", "template", "sign_inputs_owner", "event"],
      properties: {
        use_id: { type: "string", description: "Correlation id carried in the QR payload." },
        signing_template: { type: "string" },
        template: jsonRef("WireTransaction"),
        sign_inputs_owner: {
          type: "array",
          description: "The ticket input (index 0) plus the owner's fee inputs.",
          items: jsonRef("InputIndex"),
        },
        event: jsonRef("EventRef"),
      },
    },
    UseSignTemplateRequest: {
      type: "object",
      required: ["template"],
      properties: { template: jsonRef("WireTransaction") },
    },
    UseSignTemplateResult: {
      type: "object",
      required: ["signing_template"],
      properties: { signing_template: { type: "string" } },
    },
    UseFinalizeRequest: {
      type: "object",
      required: ["use_id", "template", "owner_signed", "gate_signed"],
      properties: {
        use_id: { type: "string" },
        template: jsonRef("WireTransaction"),
        owner_signed: jsonRef("SigningOutput"),
        gate_signed: jsonRef("SigningOutput"),
      },
    },
  };
}

function listingSchemas(): JsonObject {
  return {
    ListingSummary: {
      type: "object",
      required: [
        "ticket_id",
        "price",
        "seller_pkh",
        "event_name",
        "event_date",
        "covenant_id",
        "verified",
      ],
      properties: {
        ticket_id: { type: "string", pattern: TICKET_ID_PATTERN },
        price: { type: "integer", minimum: 1, description: "Asking price in sompi." },
        seller_pkh: { type: "string", pattern: HEX64_PATTERN },
        event_name: { type: "string" },
        event_date: { type: "string" },
        covenant_id: { type: "string", pattern: HEX64_PATTERN },
        verified: { type: "boolean", const: true },
      },
    },
  };
}

function listSchemas(): JsonObject {
  return {
    ListPrepareRequest: {
      type: "object",
      required: ["publicKey", "address", "price"],
      properties: {
        publicKey: PUBLIC_KEY_SCHEMA,
        address: ADDRESS_SCHEMA,
        price: {
          type: "integer",
          minimum: 1,
          description: "Asking price in sompi (positive).",
        },
      },
    },
    ListPrepareResult: {
      type: "object",
      required: ["list_id", "signing_template", "template", "sign_inputs", "price", "event"],
      properties: {
        list_id: { type: "string" },
        signing_template: { type: "string" },
        template: jsonRef("WireTransaction"),
        sign_inputs: { type: "array", items: jsonRef("InputIndex") },
        price: { type: "integer", minimum: 1 },
        event: jsonRef("EventRef"),
      },
    },
    ListFinalizeRequest: {
      type: "object",
      required: ["template", "signed", "price"],
      properties: {
        template: jsonRef("WireTransaction"),
        signed: jsonRef("SigningOutput"),
        price: { type: "integer", minimum: 1, description: "The same price sent to prepare." },
      },
    },
  };
}

function delistSchemas(): JsonObject {
  return {
    DelistPrepareRequest: {
      type: "object",
      required: ["publicKey", "address"],
      properties: { publicKey: PUBLIC_KEY_SCHEMA, address: ADDRESS_SCHEMA },
    },
    DelistPrepareResult: {
      type: "object",
      required: ["delist_id", "signing_template", "template", "sign_inputs", "event"],
      properties: {
        delist_id: { type: "string" },
        signing_template: { type: "string" },
        template: jsonRef("WireTransaction"),
        sign_inputs: { type: "array", items: jsonRef("InputIndex") },
        event: jsonRef("EventRef"),
      },
    },
    DelistFinalizeRequest: {
      type: "object",
      required: ["template", "signed"],
      properties: {
        template: jsonRef("WireTransaction"),
        signed: jsonRef("SigningOutput"),
      },
    },
  };
}

function purchaseSchemas(): JsonObject {
  return {
    PurchasePrepareRequest: {
      type: "object",
      required: ["publicKey", "address"],
      properties: { publicKey: PUBLIC_KEY_SCHEMA, address: ADDRESS_SCHEMA },
    },
    PurchasePrepareResult: {
      type: "object",
      required: [
        "purchase_id",
        "signing_template",
        "template",
        "sign_inputs",
        "price",
        "ticket_deposit",
        "seller_proceeds",
        "seller_pkh",
        "event",
      ],
      properties: {
        purchase_id: { type: "string" },
        signing_template: { type: "string" },
        template: jsonRef("WireTransaction"),
        sign_inputs: {
          type: "array",
          description: "Only the buyer's fee inputs; input 0 is signatureless.",
          items: jsonRef("InputIndex"),
        },
        price: { type: "integer", minimum: 1, description: "Asking price in sompi." },
        ticket_deposit: { type: "integer", minimum: 0 },
        seller_proceeds: { type: "integer", minimum: 0 },
        seller_pkh: { type: "string", pattern: HEX64_PATTERN },
        event: jsonRef("EventRef"),
      },
    },
    PurchaseFinalizeRequest: {
      type: "object",
      required: ["template", "signed"],
      properties: {
        template: jsonRef("WireTransaction"),
        signed: jsonRef("SigningOutput"),
      },
    },
  };
}

/** The schemas every document shares, regardless of the flow using them. */
function sharedSchemas(): JsonObject {
  return {
    ErrorEnvelope: errorEnvelopeSchema(),
    SigningOutput: SIGNING_OUTPUT_SCHEMA,
    InputIndex: INPUT_INDEX_SCHEMA,
    EventRef: EVENT_REF_SCHEMA,
    FinalizeResult: finalizeResultSchema(),
    ServerConfig: {
      type: "object",
      description:
        "The deployment's runtime network identity. Read it at boot; never derive the chain from a build-time value.",
      required: ["network", "network_id", "wallet_network", "address_prefix"],
      properties: {
        network: {
          type: "string",
          description: "Canonical network id, e.g. `testnet10`.",
        },
        network_id: {
          type: "string",
          description: "The wRPC network id, e.g. `testnet-10`.",
        },
        wallet_network: {
          type: "string",
          description: "The wallet's network name, e.g. `kaspa_testnet_10`.",
        },
        address_prefix: {
          type: "string",
          description: "The bech32 address prefix, including the trailing colon.",
        },
      },
    },
  };
}

export function buildComponents(): JsonObject {
  return {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description:
          "Session token from `POST /v1/auth/session`. The same token is a JWT whose subject is the wallet address.",
      },
    },
    responses: {
      Error: {
        description: "The shared error envelope.",
        content: jsonContent(jsonRef("ErrorEnvelope")),
      },
    },
    schemas: {
      ...sharedSchemas(),
      ...authSchemas(),
      ...wireSchemas(),
      ...eventSchemas(),
      ...deploySchemas(),
      ...buySchemas(),
      ...ticketSchemas(),
      ...useSchemas(),
      ...listingSchemas(),
      ...listSchemas(),
      ...delistSchemas(),
      ...purchaseSchemas(),
    },
  };
}
