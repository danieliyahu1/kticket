# kticket

On-chain event ticketing on Kaspa: tickets are covenant-bound assets, and entry is
controlled by a guard-side "Door" client. This repository is the monorepo.

## Packages

| Package | Path | Stack | Responsibility |
| --- | --- | --- | --- |
| `@kticket/kit` | `packages/kit` | TypeScript (over `kaspa-wasm` + SilverScript artifacts) | Covenant WASM kit — on-chain ticket rules, tx building, covenant state decoding. Shared by api / web / door. |
| `@kticket/api` | `packages/api` | Node.js + TypeScript (Fastify) | Stateless API — reads / build / broadcast via `api-tn10.kaspa.org`. |
| `@kticket/web` | `packages/web` | React + Vite + TypeScript | Web SPA (buyer / organiser flows). |
| `@kticket/door` | `packages/door` | React + Vite + TypeScript (PWA) | Door client — the guard's device app (access gate). |

## Prerequisites

- Node.js >= 20.19
- npm >= 10

## Getting started

```sh
npm install
npm run dev:api   # or dev:web / dev:door
```

## Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Builds every package (`build` script in each workspace). |
| `npm run lint` | Lints + formats + organizes imports (Biome). |
| `npm run lint:fix` | Applies lint/format fixes. |
| `npm run format` | Formats the whole repo. |
| `npm run typecheck` | Type-checks every workspace. |
| `npm test` | Runs the test suite (Vitest). |
| `npm run dev:*` | Dev servers for the api / web / door apps. |

CI runs build, lint, typecheck and tests (`.github/workflows/ci.yml`).

## Network selection (`KASPANET`)

Only **testnet-10** is supported (HLD v0.23: mainnet is out of scope). The REST
host is `api-tn10.kaspa.org`.

Each package reads its own gitignored `.env` file when present; when unset or
invalid, every host falls back to `testnet10`.

- **API** reads `KASPANET` (and `PORT`, `HOST`, `TLS_KEY`, `TLS_CERT`) from
  `packages/api/.env` at boot (`packages/api/src/env.ts`), or from the
  environment directly. Real shell/CI env always wins over the file.
- **Web / Door** read `VITE_KASPANET` from `packages/web/.env` / `packages/door/.env`
  (Vite convention, exposed via `import.meta.env`).
- **Kit** exposes the shared resolver (`getNetworkConfig`) used by all hosts.
