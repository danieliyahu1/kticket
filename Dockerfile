# --- silverc: build the per-event covenant compiler (Rust) ---
FROM rust:1.94-slim AS silverc

WORKDIR /app

COPY packages/kit/silverc packages/kit/silverc

RUN cargo build --release --manifest-path packages/kit/silverc/Cargo.toml

# --- node build ---
FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
COPY packages/kit/package.json packages/kit/

RUN npm ci

COPY packages/kit/src packages/kit/src
COPY packages/kit/scripts packages/kit/scripts
COPY packages/kit/contracts packages/kit/contracts
COPY packages/kit/artifacts packages/kit/artifacts
COPY packages/kit/tsconfig.json packages/kit/
COPY packages/api/src packages/api/src
COPY packages/api/tsup.config.ts packages/api/
COPY packages/api/tsconfig.json packages/api/
COPY packages/api/scripts packages/api/scripts
COPY packages/api/vendor packages/api/vendor
COPY packages/web/src packages/web/src
COPY packages/web/public packages/web/public
COPY packages/web/index.html packages/web/
COPY packages/web/vite.config.ts packages/web/
COPY packages/web/tsconfig.json packages/web/
COPY vitest.config.ts tsconfig.json ./

RUN npm run build --workspace @kticket/api && npm run build --workspace @kticket/web

# --- runtime ---
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
COPY packages/kit/package.json packages/kit/

RUN npm ci --omit=dev

COPY --from=build /app/packages/api/dist packages/api/dist
COPY --from=build /app/packages/web/dist packages/web/dist

# The per-event covenant compiler (kticket-silverc) and its .sil sources, plus
# the vendored kaspa-wasm (loaded as CommonJS at runtime for signing templates).
COPY --from=silverc /app/packages/kit/silverc/target/release/kticket-silverc \
  packages/kit/silverc/target/release/kticket-silverc
COPY --from=build /app/packages/kit/contracts packages/kit/contracts
COPY --from=build /app/packages/api/vendor packages/api/vendor

ENV WEB_DIST=packages/web/dist
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "packages/api/dist/index.js"]
