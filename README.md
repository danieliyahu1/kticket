# kticket

On-chain event ticketing on Kaspa: tickets are covenant-bound assets, deployed
by event organisers and bought / held by attendees — all on chain.

**Live:** https://kticket.danieliyahu.com/

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
  Turso is **required** in the deployed environments: `compose.yaml` and the
  Kubernetes `ExternalSecret` both make `TURSO_DATABASE_URL` mandatory, so the
  ephemeral file store is a local-development fallback only.
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
  **verified** badge.

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

- Node.js >= 20.19 (see `engines`) for local development.
- Rust, to build the covenant compiler — only needed to deploy events locally.
- Docker (with the Compose plugin) for the containerized run.

## Getting started

### Local development (no Docker)

```sh
npm install
npm run dev
```

`npm run dev` starts the API in watch mode and the Vite dev server, which
proxies `/v1` to the API:

- Web SPA (Vite, hot reload): `http://localhost:5173`
- API: `http://localhost:3000`

Config is read from `.env` (shared with Compose) and `.env.local` (dev-only,
git-ignored); the real environment wins over both, and an empty value in
`.env.local` unsets a key — `TURSO_DATABASE_URL=` therefore forces the local
`events.json` / `listings.json` file store. Auth is fail-closed, so when
`AUTH_SECRET` is unset the runner generates an ephemeral one for the session and
sets `AUTH_ORIGIN` to the Vite origin automatically. Override the ports with
`PORT` / `WEB_PORT`.

Deploying events also needs the covenant compiler; build it once with:

```sh
npm run build:silverc
```

Run one side only with `npm run dev:api` or `npm run dev:web`.

### Docker (production-shaped)

The app ships as one image; the API serves the built SPA.

```sh
cp example.env .env   # then fill in TURSO_DATABASE_URL / TURSO_AUTH_TOKEN
docker compose up --build
```

The API (which serves the built web SPA) listens on `http://localhost:3000`.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Runs the app locally: API (watch) + Vite dev server (no Docker). |
| `npm run dev:api` | Runs only the API in watch mode. |
| `npm run dev:web` | Runs only the Vite dev server. |
| `npm run build` | Builds every package (`build` script in each workspace). |
| `npm run build:silverc` | Builds the `kticket-silverc` covenant compiler (Rust, release). |
| `npm run typecheck` | Type-checks every workspace (`tsc --noEmit`). |
| `npm test` | Runs the test suite (Vitest). |
| `npm run validate:deploy` | Validates the delivery contract in `deploy/` (image pin, probes, scrape, dashboard metric names). |

## Deployment & operations

The API and the built SPA ship as one image. A push to `main` starts
`.github/workflows/build-and-push.yaml`, which:

1. verifies the repository (typecheck, tests, covenant VM tests, committed
   artifact check, production build, manifest schema + delivery-contract
   validation),
2. builds `linux/arm64` and publishes `sha-<commit>` + `latest` to GHCR,
3. smoke-tests the published image non-root with a read-only root filesystem,
4. rewrites `deploy/deployment.yaml` to the immutable
   `sha-<commit>@sha256:<digest>` reference and commits it.

Argo CD watches `deploy/` on `main` and applies the result to the `kticket`
namespace. All application-owned manifests live under `deploy/`.

Runtime contract:

- **Public Service** — `kticket` (ClusterIP, port 3000). The environment's
  routing layer reaches it directly; it serves the API and the SPA.
- **Metrics** — the API also listens on the internal `METRICS_PORT` (9090),
  exposed only through the `kticket-metrics` Service and discovered by the
  `kticket` `VMServiceScrape`. A Grafana overview dashboard (`kticket-dashboard`)
  is delivered as a ConfigMap in the `observability` namespace.
- **Secrets** — `deploy/externalsecret.yaml` maps three OCI Vault entries
  (`k3s-01-kticket-turso-url`, `k3s-01-kticket-turso-token`,
  `k3s-01-kticket-auth-secret`) through the `oci-vault` `ClusterSecretStore`
  into the `kticket-secrets` Secret. Those key names must match what is created
  in OCI Vault; the repository only ever stores the names, never the values.
- **Scaling** — one replica. Wallet sign-in nonces and the in-process index
  mirrors are process-local, so horizontal scaling would need shared state
  first.
- **Shutdown** — a finalize can wait ~95s for chain confirmation, so the
  process drains for up to 120s and the pod's
  `terminationGracePeriodSeconds` is 150s.

## Network selection (`KASPANET`)

Only **testnet-10** is supported (HLD v0.23: mainnet is out of scope). The REST
host is `api-tn10.kaspa.org`.

Configuration comes from the compose `.env` (see `example.env`); when a value is
unset or invalid, every host falls back to `testnet10`.

- **API** reads `KASPANET` (and `PORT`, `HOST`, `METRICS_PORT`, `TLS_KEY`,
  `TLS_CERT`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`) from the environment set
  by `compose.yaml`.
- **Web** reads `VITE_KASPANET` at build time (`import.meta.env`); the API
  serves the built SPA.
- **Kit** exposes the shared resolver (`getNetworkConfig`) used by all hosts.

## Wallet authentication (SIWS, daftari-style)

User-specific reads that carry no transaction signature (My Tickets, My Events)
require the caller to prove they control the wallet they claim. The model
mirrors Daftari: a one-time nonce challenge → the wallet signs a structured
message (`kasware.signMessage`) → the API verifies the Schnorr signature and
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

## Support

If you like this repo, you can tip me at [https://kas.coffee/danieliyahu](https://kas.coffee/danieliyahu).
