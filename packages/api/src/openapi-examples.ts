// Example values for the contract (KTK-154). They are realistic fixtures, not
// runtime data: the docs render them, and the tests validate each one against
// the schema it illustrates.

const DEPLOY_TXID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const COVENANT_ID = "234f446748ff76774c8ca9c99531a34111066f902daa95663a399f4a2893a3ba";
const ORGANIZER =
  "kaspatest:qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszapw00vun";
const ORG_PKH = `01${"02".repeat(31)}`;
const ORG_SPK = `20${ORG_PKH}ac`;
const AUTHORIZING_TXID = "ab".repeat(32);

/** A funded testnet wallet used wherever a request names a buyer or holder. */
export const EXAMPLE_WALLET = {
  publicKey: `02${"02".repeat(31)}`,
  address: ORGANIZER,
} as const;

/** A second wallet for resale examples (the buyer of a listed ticket). */
export const EXAMPLE_BUYER_WALLET = {
  publicKey: `04${"05".repeat(31)}`,
  address: ORGANIZER,
} as const;

export const EXAMPLE_DEPLOY_TXID = DEPLOY_TXID;
export const EXAMPLE_COVENANT_ID = COVENANT_ID;
export const EXAMPLE_ORGANIZER = ORGANIZER;
export const EXAMPLE_ORG_PKH = ORG_PKH;
export const EXAMPLE_ORG_SPK = ORG_SPK;
export const EXAMPLE_AUTHORIZING_TXID = AUTHORIZING_TXID;
export const EXAMPLE_TICKET_ID = `bb${"00".repeat(31)}:0`;
export const EXAMPLE_SELLER_PKH = `02${"03".repeat(31)}`;

export const OPENAPI_EXAMPLES = {
  event: {
    covenant_id: COVENANT_ID,
    deploy_txid: DEPLOY_TXID,
    name: "Testnet Rave",
    date: "2026-12-31",
    time: "20:00",
    ticker: "",
    decimals: 0,
    image: "",
    image_hash: "",
    price: 1_000,
    capacity: 2,
    organizer_address: ORGANIZER,
    verified: true,
  },
  wireTransaction: {
    version: 0,
    inputs: [
      {
        previous_outpoint: { transaction_id: DEPLOY_TXID, index: 0 },
        signature_script: "",
        sequence: 0,
        sig_op_count: 1,
      },
    ],
    outputs: [
      {
        value: 50_000_000,
        script_public_key: { version: 0, script: ORG_SPK },
        covenant: { authorizing_input: 0, covenant_id: COVENANT_ID },
      },
    ],
    lock_time: 0,
  },
  error: {
    error: {
      type: "invalid",
      message: "capacity must be 0..100",
      retryable: false,
    },
  },
} as const;

export const EVENT_EXAMPLE = OPENAPI_EXAMPLES.event;
export const WIRE_TRANSACTION_EXAMPLE = OPENAPI_EXAMPLES.wireTransaction;
