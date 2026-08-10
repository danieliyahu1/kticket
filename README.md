# kticket

On-chain event ticketing on Kaspa: tickets are covenant-bound assets, deployed
by event organisers and bought / held by attendees — all on chain.

## Packages

| Package | Path | Stack | Responsibility |
| --- | --- | --- | --- |
| `@kticket/kit` | `packages/kit` | TypeScript (over `kaspa-wasm` + SilverScript artifacts) | Covenant WASM kit — on-chain ticket rules, tx building, covenant state decoding, provenance helpers. Shared by api / web. |
| `@kticket/api` | `packages/api` | Node.js + TypeScript (Fastify) | Stateless API — every read re-verifies event data from the chain; only an identifier registry (`deploy_txid`, `covenant_id`, `organizer_address`) is stored, for discovery. |
| `@kticket/web` | `packages/web` | React + Vite + TypeScript | Monolith SPA — buyer, organiser, and door scanner flows, with a trust-anchor "Organized by" UI and anchor-based discovery links. |

## Stateless backend & trustless provenance (KTK-89)

The chain is the source of truth; the app is a thin wrapper:

- The identifier registry stores only `{ deploy_txid, covenant_id, organizer_address }`
  for discovery — never authoritative.
- `GET /v1/events/{covenant_id}` verifies the event from the chain on each read:
  it fetches the deploy tx, decodes the KCC-0021 payload, checks the maker
  (the deploy funding UTXO owner pubkey), and verifies the address commitment
  (`P2SH(blake3(redeem))` reproduces the on-chain covenant output, which also
  recovers capacity). Events that fail verification are hidden.
- Responses carry raw chain facts (`deploy_txid`, `authorizing_txid`,
  `maker_address`, decoded constants + state, payload) so any displayed value
  can be independently re-checked.
- The frontend shows **"Organized by: <address>"** as the trust anchor with a
  **verified** badge, and saves opened events as local anchor links.

## Prerequisites

- Node.js >= 20.19
- npm >= 10

## Getting started

```sh
npm install
npm run dev:api   # start the API
npm run dev       # start the web app (in another terminal)
```

## Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Builds every package (`build` script in each workspace). |
| `npm test` | Runs the test suite (Vitest). |
| `npm run dev:api` | Dev server for the API. |
| `npm run dev` | Dev server for the web SPA. |

## Network selection (`KASPANET`)

Only **testnet-10** is supported (HLD v0.23: mainnet is out of scope). The REST
host is `api-tn10.kaspa.org`.

Each package reads its own gitignored `.env` file when present; when unset or
invalid, every host falls back to `testnet10`.

- **API** reads `KASPANET` (and `PORT`, `HOST`, `TLS_KEY`, `TLS_CERT`) from
  `packages/api/.env` at boot (`packages/api/src/env.ts`), or from the
  environment directly. Real shell/CI env always wins over the file.
- **Web** reads `VITE_KASPANET` from `packages/web/.env`
  (Vite convention, exposed via `import.meta.env`).
- **Kit** exposes the shared resolver (`getNetworkConfig`) used by all hosts.
