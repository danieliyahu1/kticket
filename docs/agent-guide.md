# Headless access

kticket sells event tickets on Kaspa, and its HTTP API is the product. An agent
that holds a Kaspa key can do everything the browser app does, with no browser.
Identity is wallet ownership: you prove it by signing a server-issued challenge,
and every user-specific request is scoped to that wallet.

There is no agent-specific account, token, or permission. The same API serves
every client.

This guide covers the flow the schemas cannot: what to sign, in what order, and
what the server does with it. The endpoints themselves, with request/response
schemas and examples, live in the OpenAPI document at
[`/openapi.json`](/openapi.json) and the rendered reference at
[`/docs/api`](/docs/api).

## Prerequisites

Bring your own Kaspa keypair. kticket never issues a key, an account, or a
token — the wallet's key is the identity.

Create and sign with any Kaspa SDK. A headless client needs:

- `PrivateKey` to derive the address and sign messages;
- a transaction signer that understands kaspa-wasm safe JSON (the browser app
  uses Kasware's `signPskt`).

The server tells you which network it runs on: `GET /v1/config` returns the
runtime identity as `{ "network": "testnet10", "network_id": "testnet-10",
"wallet_network": "kaspa_testnet_10", "address_prefix": "kaspatest:" }`. Derive
your address on that network, so the prefix matches (`kaspatest:` vs `kaspa:`).
The sign-in message also carries the wRPC network id (`Chain ID: testnet-10`);
never choose either value yourself. `GET /health` remains the liveness probe.

Amounts in this guide are **sompi** unless a field is explicitly named
`price_kas`. 1 KAS = 100,000,000 sompi.

## Authentication

The only credential is a signature over a server-issued, single-use challenge.

1. **Ask for a challenge.**

```http
POST /v1/auth/challenge
Content-Type: application/json

{ "address": "kaspatest:..." }
```

```json
{
  "nonce": "b7c9e1f4a2d84c6e9f0a1b2c3d4e5f60",
  "message": "kticket\n\nkticket wants you to sign in with your Kaspa account:\nkaspatest:...\n\nURI: https://...\nVersion: 1\nChain ID: testnet-10\nNonce: b7c9...\nIssued At: 2026-10-18T19:00:00.000Z"
}
```

2. **Sign `message` verbatim** with the wallet's private key. The signature is a
   standard Kaspa message signature (Schnorr), hex or base64.

3. **Exchange it for a session token.**

```http
POST /v1/auth/session
Content-Type: application/json

{ "message": "...", "signature": "..." }
```

```json
{ "token": "eyJ...", "expires_in_seconds": 900 }
```

4. **Send the token on every user-specific request.**

```http
Authorization: Bearer <token>
```

The nonce is consumed on first use: reuse returns `401`. A token expires; ask
for a new challenge rather than reusing the signed message.

Which calls need the token:

| Call | Auth |
| --- | --- |
| `GET /v1/events` | public |
| `GET /v1/events/{covenant_id}` | public |
| `GET /v1/listings`, `GET /v1/events/{covenant_id}/listings` | public |
| `GET /v1/events?organizer_address=...` | bearer, and the address must match |
| `GET /v1/tickets` | bearer |
| every `prepare` / `finalize` | no bearer: the signed transaction is the proof |

A browser receives the same token as an `HttpOnly` cookie; a bearer header wins
when both are present.

## Reading events

`GET /v1/events` returns every verified event. The server re-derives each row
from the deploy transaction on every read, so the fields are chain facts, not
registry claims:

```json
[
  {
    "covenant_id": "234f...",
    "deploy_txid": "aaaa...",
    "name": "Testnet Rave",
    "date": "2026-12-31",
    "time": "20:00",
    "ticker": "",
    "decimals": 0,
    "image": "",
    "image_hash": "",
    "price": 1000,
    "capacity": 2,
    "organizer_address": "kaspatest:...",
    "verified": true
  }
]
```

`price` is sompi. `GET /v1/events/{covenant_id}` adds `raw_chain`: the deploy
txid, authorizing txid, maker address, decoded constants, decoded state, and the
raw payload. Use `raw_chain` if you need to re-check a displayed value yourself.

### Covenant model

The event covenant is a **KCC20-fork**, not an implementation of KCC-20 Final.
Its chain state is kticket's own six-field layout (`owner`, `identifier_type`,
`amount`, `is_minter`, `used`, `sale_price`) and its entrypoints are
ticket-specific `mint` / `use` / `mark_used` / `list` / `purchase` / `delist` —
there is no `transfer` or `transfer_delegator`, no borrow support, and no
`extension_commitment`. Decode `raw_chain.state` as kticket state, not as a
KCC-20 `KCC20State`. The field mapping is recorded in the repository at
`packages/kit/docs/decisions/kcc20-fork.md`.

## Shareable event pages

The browser page and the link preview are the same URL: `/events/{covenant_id}`.
It serves the SPA shell with the verified event's title, description, canonical
URL, Open Graph, and Twitter tags — a chat client that does not run JavaScript
still sees the real event. If the event is unknown, unverified, or the chain is
briefly unavailable, the page still returns `200` with the generic site
metadata. Never treat a preview as proof; the JSON read above remains the
authoritative event fact.

Search discovery follows the same verification policy: `/sitemap.xml` lists
verified event pages with absolute URLs, and `/robots.txt` points at it while
excluding check-in, ticket, and API routes.

## The two-step flow

Every state-changing ticket operation uses the same stateless shape:

1. `POST .../prepare` builds an unsigned template, returns
   `signing_template` (kaspa-wasm safe JSON), the same transaction as
   `template`, and the input indices you must sign.
2. The client signs **only those inputs**, leaving every other input and every
   output exactly as prepared.
3. `POST .../finalize` merges the signatures into the template it issued,
   validates it is still the operation it claims, broadcasts, and waits for the
   ledger to accept it. The response's `status` says whether acceptance was
   established (`settled`) or not yet (`pending`).

Do not rebuild, reorder, re-encode, or "fix" the template between the two calls.
The server checks what it broadcasts against the prepared shape; a changed
template is rejected.

The returned `*_id` (for example `buy_id`, `deploy_id`, `list_id`) is a
correlation id so an operator can match a prepare with its finalize. It is not a
server-side session, and there is no pending state to clean up: a prepare that
is never finalized costs nothing.

### Signing the template with Kasware

The browser app uses Kasware, and a headless client with a Kasware-compatible
signer can do the same:

```js
const signed = await kasware.signPskt({
  txJsonString: prepared.signing_template,
  options: {
    signInputs: prepared.sign_inputs.map(({ index }) => ({
      index,
      sighashType: 1, // SIGHASH_ALL
    })),
  },
});
```

`signing_template` is the JSON string, not the object. Send the signer's result
back as `signed` (an object is what Kasware returns; a safe-JSON string is also
accepted).

## Deploying an event

Deploying is two transactions under **KCC-23 "Metadata JSON"**: a *preparation*
transaction carries the metadata declaration and creates one output, then the
*genesis* transaction spends that output to create the event covenant. The
covenant id commits to the preparation txid, which commits to the payload, so
the declaration is bound to the token. Three stateless calls and two wallet
signatures:

```http
POST /v1/events/deploy/prepare
Content-Type: application/json

{
  "capacity": 2,
  "price_kas": 0.00001,
  "publicKey": "02...",
  "address": "kaspatest:...",
  "name": "Testnet Rave",
  "date": "2026-12-31",
  "time": "20:00"
}
```

- `capacity` is 0–100 tickets.
- `price_kas` is the ticket price in KAS (the server converts to sompi).
- `publicKey` is compressed (66 hex) or bare x-coordinate (64 hex).
- `address` is where the server fetches funding UTXOs; it must hold spendable
  funds.
- `name` and `date` must be provided together; `time` requires `date`.
- Optional metadata keys: `ticker`, `decimals`, `image`, `image_hash`.

The response is the preparation round:

```json
{ "deploy_id": "...", "preparation": { "template": { ... }, "signing_template": "{...}" } }
```

`template.payload` is the KCC-23 declaration — `0x00` (the JSON codec byte)
followed by the UTF-8 JSON object, hex-encoded, so `{}` would be `007b7d`. Sign
`preparation.signing_template`, then send the same request fields plus the
signed preparation transaction:

```http
POST /v1/events/deploy/genesis
Content-Type: application/json

{
  ...same fields as prepare...,
  "deploy_id": "...",
  "preparation": { "template": { ... }, "signed": { ... } }
}
```

The server relays the preparation transaction, waits until it is accepted, and
returns the genesis round:

```json
{
  "preparation_txid": "abab...",
  "event_covenant_id": "234f...",
  "genesis": { "template": { ... }, "signing_template": "{...}" }
}
```

Sign `genesis.signing_template` and finalize with the genesis template:

```http
POST /v1/events/deploy/finalize
Content-Type: application/json

{ "deploy_id": "...", "template": { ... }, "signed": { ... } }
```

```json
{ "covenant_id": "234f...", "deploy_txid": "aaaa..." }
```

A successful finalize registers the event for discovery. To register an event
deployed by another client, `POST /v1/events` with `{ "deploy_txid": "..." }`;
the server verifies it on chain before recording it.

The organizer pays the network fee twice (once per transaction). If `genesis`
fails after the preparation tx was relayed, call it again with the same signed
preparation: its txid is derived from the signed bytes, so the server resumes
instead of double-spending. The declaration is fixed once the preparation tx is
signed — change a metadata field and you get a different preparation tx and a
different covenant id.

Reading the binding back: `GET /v1/events/{covenant_id}` returns
`raw_chain.metadata_txid` (the transaction whose payload carried the
declaration) and `raw_chain.payload`. Under KCC-23 `metadata_txid` is the
preparation txid and equals `raw_chain.authorizing_txid`; the genesis
transaction's input 0 spends that transaction's output 0. Older events carried
the payload on the genesis transaction itself; they still verify and report
`metadata_txid` equal to `deploy_txid`.

## Buying a primary ticket

```http
POST /v1/events/{covenant_id}/buy/prepare
Content-Type: application/json

{ "publicKey": "02...", "address": "kaspatest:..." }
```

The server verifies the event from the chain, walks its capacity lineage,
fetches the buyer's UTXOs, and returns:

```json
{
  "buy_id": "...",
  "signing_template": "{...}",
  "template": { "version": 0, "inputs": [...], "outputs": [...], "lock_time": 0 },
  "sign_inputs": [{ "index": 1 }],
  "price": 1000,
  "ticket_deposit": 50000000
}
```

Sign every index in `sign_inputs`. Input 0 is the event covenant spend; the
server has already prepared its redeem script, so `sign_inputs` omits it.
Finalize with:

```http
POST /v1/events/{covenant_id}/buy/finalize
Content-Type: application/json

{ "buy_id": "...", "template": { ... }, "signed": { ... } }
```

```json
{ "txid": "1234...", "status": "settled" }
```

`txid` is always the broadcast transaction id. `status` says what the chain has
established:

| `status` | Meaning | What to do |
| --- | --- | --- |
| `settled` | The ledger accepted the transaction. Every output it declares exists. | Read `GET /v1/tickets`; the ticket is there. |
| `pending` | The transaction was relayed, but acceptance is not established within the wait (~95s). It may still settle. | Keep the txid, do **not** re-broadcast, and poll `GET /v1/tickets` (or the ticket's outpoint) to learn the outcome. |

A `pending` finalize is **not** a failure and returns `200`: the signature is out
there, and reporting an error would invite a duplicate broadcast. The same two
values appear on every `*_finalize` response (`use`, `list`, `delist`,
`purchase`). `deploy/finalize` answers differently — it registers the event, so
its success already means the deploy was proven from chain.

The ticket's `ticket_id` is the mint transaction id and output index:
`<64-hex-txid>:<index>`. Read it from `GET /v1/tickets` once the mint is
`settled`.

Common rejections:

| Status | Meaning |
| --- | --- |
| `400` | A field is malformed (address, public key, capacity). |
| `404` | The covenant id is not a registered event. |
| `422` | Sold out, or the buyer address has no spendable UTXOs. |

## My tickets

```http
GET /v1/tickets
Authorization: Bearer <token>
```

Returns the tickets held by the token's wallet. A listed ticket carries
`listed: true` and its `price` in sompi. Any caller-supplied `owner_pkh` is
ignored: the wallet proof is authoritative.

## Check-in (the door)

The owner pre-signs the check-in; the gate co-signs later. The owner and the
gate do not need to share a server-side session.

1. **Owner prepares.**

```http
POST /v1/tickets/{ticket_id}/use/prepare
Content-Type: application/json

{ "publicKey": "02...", "address": "kaspatest:..." }
```

```json
{
  "use_id": "...",
  "signing_template": "{...}",
  "template": { ... },
  "sign_inputs_owner": [{ "index": 0 }, { "index": 1 }],
  "event": { "name": "Testnet Rave", "date": "2026-12-31" }
}
```

The owner signs `sign_inputs_owner` (the ticket input plus its fee inputs). The
`use_id`, `template`, and signing result form the QR payload.

2. **The gate rebuilds the same template.**

```http
POST /v1/tickets/{ticket_id}/use/sign-template
Content-Type: application/json

{ "template": { ... } }
```

This is a stateless re-derivation from the template's prev-output chain facts.
It guarantees the gate co-signs exactly the bytes the owner signed.

3. **The gate co-signs input 0 and finalizes.**

```http
POST /v1/tickets/{ticket_id}/use/finalize
Content-Type: application/json

{
  "use_id": "...",
  "template": { ... },
  "owner_signed": { ... },
  "gate_signed": { ... }
}
```

```json
{ "txid": "5678...", "status": "settled" }
```

Only `status: "settled"` means the ticket is used — the door should treat
`pending` as "not yet", scan again, and never as an error.

A ticket can be used once. An already used or non-owned ticket is rejected
before a template is built.

## Resale

### List a ticket

```http
POST /v1/tickets/{ticket_id}/list/prepare
Content-Type: application/json

{ "publicKey": "02...", "address": "kaspatest:...", "price": 2000 }
```

`price` is the asking price in **sompi** and must be positive. The price is
committed into the covenant state, so the chain — not the index — is the source
of truth. Sign `sign_inputs`, then finalize with the same price:

```http
POST /v1/tickets/{ticket_id}/list/finalize
Content-Type: application/json

{ "template": { ... }, "signed": { ... }, "price": 2000 }
```

The server proves ownership and unlisted state on chain before building the
template, and indexes the listing as soon as the spend is broadcast. The index
row is a hint: every read re-proves it against the chain, so a `pending` or
never-settled listing is simply omitted rather than served.

### Browse listings

`GET /v1/listings` returns every live listing; `GET
/v1/events/{covenant_id}/listings` returns one event's. Each row is proven: the
ticket UTXO must still sit on the listed-state address for its recorded seller
and price. Stale index rows are omitted rather than served.

```json
{
  "ticket_id": "bbbb...:0",
  "price": 2000,
  "seller_pkh": "02...",
  "event_name": "Testnet Rave",
  "event_date": "2026-12-31",
  "covenant_id": "234f...",
  "verified": true
}
```

### Buy a listing (no seller online)

```http
POST /v1/tickets/{ticket_id}/purchase/prepare
Content-Type: application/json

{ "publicKey": "02...", "address": "kaspatest:..." }
```

The server re-proves the listing on chain, then returns a template where input
0 is the signatureless ticket spend and `sign_inputs` covers only the buyer's
fee inputs. The response also reports `price`, `ticket_deposit`,
`seller_proceeds`, and `seller_pkh` so a client can show the exact split before
signing.

Finalize with `{ "template": { ... }, "signed": { ... } }`. The index row is
dropped and the buyer holds a fully usable ticket.

### Delist

`POST /v1/tickets/{ticket_id}/delist/prepare` with `{ publicKey, address }`, then
`/delist/finalize` with `{ template, signed }`. Only the seller can delist, and
the recorded price is proven against the chain before the template is built.

## Errors

Every failure uses one envelope:

```json
{
  "error": {
    "type": "invalid",
    "message": "capacity must be 0..100",
    "retryable": false
  }
}
```

- `type` is stable and machine-readable: `invalid`, `conflict`, `policy`,
  `network`, `upstream`, `unauthorized`, or `unknown-*`.
- `retryable` says whether the same request may succeed later without changes.
- `retryAfter` (seconds) is present when the server knows how long to wait.
- `detail` carries optional machine-readable context.

HTTP status carries the class:

| Status | Meaning |
| --- | --- |
| `400` | Invalid request — a field is missing, malformed, or out of range. |
| `401` | Authentication required, or the session token is missing/expired. |
| `404` | The named resource is not known (or not on chain). |
| `409` | Conflict — the resource changed while you worked. |
| `422` | Rejected by a policy (sold out, not the owner, no spendable funds). |
| `502` | The network refused the signed transaction. |
| `503` | The chain upstream is unavailable; honor `retryAfter`. |

## Concurrency and safety

- `prepare` issues a fresh template every time. Nothing is signed or paid until
  you finalize, so repeating a prepare is harmless.
- A `*_id` correlates a prepare with its finalize; the server keeps no pending
  state.
- Do not retry a finalize blindly: the broadcast may already have gone out.
  A `pending` status means exactly that — read the chain (or `GET /v1/tickets`)
  instead of broadcasting again. Retrying is only safe when the transaction is
  identical (the same signed template), because the txid is derived from it.
- Never alter the template between prepare and finalize.
- Sign only the indices the server returns. Signing extra inputs, or changing
  amounts/scripts, produces a template the server rejects.
- `503` is the retryable class: the chain upstream was unavailable. Honor
  `retryAfter`, then repeat the read — or re-prepare if it was a build.

## Where the contract lives

- [`/openapi.json`](/openapi.json) and `/.well-known/openapi.json` — OpenAPI 3.1.
- [`/docs/api`](/docs/api) — the same contract rendered as HTML.
- [`/llms.txt`](/llms.txt) — a plain-text map for machines.
- `/sitemap.xml` — verified event pages, for search engines.
- `/robots.txt` — the crawler policy and a pointer to the sitemap.
- `GET /v1/config` — the runtime network identity.
- `GET /health` — `{ "status": "ok", "network": "..." }`.
