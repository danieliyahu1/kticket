# AGENTS.md

kticket's HTTP API is the product, and agents are first-class clients. This file
is the map of the machine-readable surface: what is published, where it is
served, and which file owns it. Read these when you need to understand the app;
update them in the same commit when the app changes.

## Published surface

| Artifact | Source | Served at |
| --- | --- | --- |
| OpenAPI 3.1 contract | `packages/api/src/openapi.ts` (composer), `openapi-schemas.ts`, `openapi-operations.ts`, `openapi-examples.ts` | `/openapi.json`, `/.well-known/openapi.json` |
| Rendered API reference | `packages/api/src/docs-page.ts` (renders the contract) | `/docs/api` |
| Agent guide | `docs/agent-guide.md` (read by `packages/api/src/agent-guide.ts`) | `/docs/agent-guide.md` |
| Machine entry point | `packages/api/src/llms.ts` | `/llms.txt` |
| Homepage discovery | `packages/web/index.html` (head links + static body explainer) | `/` |
| Route handlers | `packages/api/src/routes.ts` | — |
| Event shell with per-event previews | `packages/api/src/event-shell.ts` (metadata builder: `packages/kit/src/event-meta.ts`) | `/events/{covenant_id}` |
| Search discovery | `packages/api/src/discovery.ts`, `packages/api/src/discovery-routes.ts` | `/sitemap.xml`, `/robots.txt` |
| Error envelope | `packages/api/src/errors.ts`, `packages/api/src/error-handler.ts` | every failure |
| Path constants | `packages/api/src/docs-paths.ts` | all of the above |

All of these are registered by `packages/api/src/docs-routes.ts`,
`packages/api/src/discovery-routes.ts`, and `packages/api/src/event-shell.ts`
**before** the static SPA and its catch-all, so they never fall through to a
generic `index.html`. Shareable event pages are the same built shell with the
verified event's metadata injected; the sitemap uses the events directory's
verification path, so only verified events are advertised.

## The update rule

A route change updates the contract **and** the agent guide in the same commit:

1. Add or change the route in `packages/api/src/routes.ts`.
2. Describe it in the contract modules (`openapi-schemas.ts` for its types,
   `openapi-operations.ts` for the operation, `openapi-examples.ts` for any new
   fixture).
3. If the flow's *mechanics* changed (what to sign, ordering, retry safety),
   update `docs/agent-guide.md` too.
4. If a new published path appears, name it in `packages/api/src/llms.ts`, link
   it from the homepage shell (`packages/web/index.html`), and add it to the
   table above.

`packages/api/src/openapi.test.ts` fails when the contract and the Fastify route
table disagree in either direction, and validates every example against its
schema. `packages/api/src/docs.test.ts` fails when a served document stops
linking or listing what it should.

## Why it is shaped this way

- **The contract is code.** It is authored in the contract modules so it can be
  served, rendered, and tested from one source. Never hand-write a parallel JSON
  file.
- **No agent-only access.** Identity is the wallet: a signed challenge becomes a
  bearer token. Everything else is public or proven by the signed transaction.
- **The docs are self-contained.** `/docs/api` has no scripts and no external
  network calls; it renders the same JSON contract the server already has.
- **Error shape is stable.** Every failure is `{ error: { type, message,
  retryable, retryAfter?, detail? } }`; clients branch on `type`, not prose.

## Repo layout

| Path | What it is |
| --- | --- |
| `packages/kit` | Covenant kit — on-chain ticket rules, tx building, provenance helpers. |
| `packages/api` | Fastify API; every read re-verifies from chain (memoized). |
| `packages/web` | Vite SPA and the browser wallet client (one client of the API). |
| `docs/agent-guide.md` | The headless client guide, served at runtime. |
| `deploy/` | The Kubernetes delivery contract (also validated in CI). |

## Design references

- **Kticket — Product Surface — HLD addendum** (Plane) — this published-surface
  design.
- **Kticket — HLD v0.27** (Plane) — the system design this surface extends.
- `README.md` — local development, deployment, and the operations contract.
