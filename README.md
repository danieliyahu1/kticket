# kticket

On-chain event ticketing on Kaspa: tickets are covenant-bound assets, deployed
by event organisers and bought / held by attendees — all on chain.

## Packages

| Package | Path | Stack | Responsibility |
| --- | --- | --- | --- |
| `@kticket/kit` | `packages/kit` | TypeScript (over `kaspa-wasm` + SilverScript artifacts) | Covenant WASM kit — on-chain ticket rules, tx building, covenant state decoding, provenance helpers. Shared by api / web. |
| `@kticket/api` | `packages/api` | Node.js + TypeScript (Fastify) | Stateless API — every read re-verifies event data from the chain (memoized); only an identifier registry (`deploy_txid`, `covenant_id`, `organizer_address`) is stored, for discovery. |
| `@kticket/web` | `packages/web` | React + Vite + TypeScript | Monolith SPA — buyer and organiser flows, with a trust-anchor "Organized by" UI and anchor-based discovery links. |

## Stateless backend & trustless provenance (KTK-89)

The chain is the source of truth; the app is a thin wrapper:

- The identifier registry stores only `{ deploy_txid, covenant_id, organizer_address }`
  for discovery — never authoritative. It persists to Turso when
  `TURSO_DATABASE_URL` is set (durable across deploys; `TURSO_AUTH_TOKEN` for
  remote databases), and falls back to a local `events.json` file otherwise.
- `GET /v1/events` verifies every registered event from the chain and serves
  the verified facts (name, date, time, price, capacity, organizer) for the
  homepage cards. Events that fail verification are hidden.
- `GET /v1/events/{covenant_id}` verifies the event from the chain on each read:
  it fetches the deploy tx, decodes the KCC-0021 payload, checks the maker
  (the deploy funding UTXO owner pubkey), and verifies the address commitment
  (`P2SH(blake3(redeem))` reproduces the on-chain covenant output, which also
  recovers capacity). Events that fail verification are hidden.
- Responses carry raw chain facts (`deploy_txid`, `authorizing_txid`,
  `maker_address`, decoded constants + state, payload) so any displayed value
  can be independently re-checked.
- Deployed event facts are immutable (baked into the deploy tx), so verified
  reads are memoized in-process (`VerifiedEventCache`, no TTL) and the registry
  is re-verified in the background on boot (warm-up) — steady-state reads are
  instant, and the chain stays authoritative across restarts.
- Availability (sold / tickets left) is derived from the chain only inside the
  buy flow to build transactions; read endpoints and the UI do not surface it.
- The frontend shows **"Organized by: <address>"** as the trust anchor with a
  **verified** badge, and saves opened events as local anchor links.

## Resilience boundaries

The app stays a thin orchestrator — timing and transport concerns are owned by
the layers that already have the context to handle them:

- **Reads (REST)** go through the kaspa-client, which owns per-request
  timeouts and upstream retry/backoff. No app-level deadlines are imposed on
  the events directory; a slow or down chain surfaces to the UI as
  offline/retry.
- **Broadcast (wRPC)** goes through the vendored kaspa-wasm `RpcClient`, which
  owns connect retry/reconnect/failover; only a connect-attempt bound is set.
- **Flow-specific confirmation waits** (deploy "verifiable", buy "visible")
  are owned by their flows via a shared, business-agnostic `pollUntil` helper —
  the data-access layer never knows why it is being polled.

## Prerequisites

- Docker (with the Compose plugin)

## Getting started

The app runs only through Docker Compose.

```sh
cp example.env .env   # then fill in TURSO_DATABASE_URL / TURSO_AUTH_TOKEN
docker compose up --build
```

The API (which serves the built web SPA) listens on `http://localhost:3000`.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Builds every package (`build` script in each workspace). |
| `npm test` | Runs the test suite (Vitest). |

## Network selection (`KASPANET`)

Only **testnet-10** is supported (HLD v0.23: mainnet is out of scope). The REST
host is `api-tn10.kaspa.org`.

Configuration comes from the compose `.env` (see `example.env`); when a value is
unset or invalid, every host falls back to `testnet10`.

- **API** reads `KASPANET` (and `PORT`, `HOST`, `TLS_KEY`, `TLS_CERT`,
  `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`) from the environment set by
  `compose.yaml`.
- **Web** reads `VITE_KASPANET` at build time (`import.meta.env`); the API
  serves the built SPA.
- **Kit** exposes the shared resolver (`getNetworkConfig`) used by all hosts.

## Wallet authentication (SIWS, daftari-style)

User-specific reads that carry no transaction signature (My Tickets, My Events)
require the caller to prove they control the wallet they claim. The model
mirrors Daftari: a one-time nonce challenge → the wallet signs a structured
message (`kastle.signMessage`) → the API verifies the Schnorr signature and
issues a short-lived JWT whose subject is the address → protected reads present
`Authorization: Bearer <token>`.

- `POST /v1/auth/challenge {address}` → `{ nonce, message }`
- `POST /v1/auth/session {message, signature}` → `{ token, expires_in_seconds }`
- `GET /v1/tickets` and `GET /v1/events?organizer_address=` require the token
  and are scoped to the authenticated address; other endpoints are unchanged
  (writes are verified by the chain at broadcast, reads of events/listings are
  public chain facts).

Auth is **fail-closed**: the API refuses to boot without `AUTH_SECRET`. The
nonce store is in-memory (single-instance deploy). Configuration:

- `AUTH_SECRET` — required; the HS256 JWT signing secret.
- `AUTH_ORIGIN` — the origin the SPA is served from; the signed claim's `URI`
  must match it (default `http://localhost:3000`).
- `AUTH_SESSION_TTL_MS` — JWT lifetime in ms (default 15 minutes).
