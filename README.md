# kticket

On-chain event ticketing on Kaspa: tickets are covenant-bound assets, deployed
by event organisers and bought / held by attendees — all on chain.

## Packages

| Package | Path | Stack | Responsibility |
| --- | --- | --- | --- |
| `@kticket/kit` | `packages/kit` | TypeScript (over `kaspa-wasm` + SilverScript artifacts) | Covenant WASM kit — on-chain ticket rules, tx building, covenant state decoding. Shared by api / web. |
| `@kticket/api` | `packages/api` | Node.js + TypeScript (Fastify) | Stateless API — reads / build / broadcast via `api-tn10.kaspa.org`. |
| `@kticket/web` | `packages/web` | React + Vite + TypeScript | Monolith SPA — buyer, organiser, and door scanner flows. |

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
