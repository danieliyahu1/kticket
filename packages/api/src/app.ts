import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { type ApiConfig, loadConfig } from "./config";
import { registerErrorHandler } from "./error-handler";
import { EventStore, type EventRegistry } from "./eventstore";
import { TursoEventStore } from "./eventstore-turso";
import { ListingStoreFile, type ListingStore } from "./listings";
import { TursoListingStore } from "./listings-turso";
import { KaspaClient } from "./kaspa-client";
import { type AppContext, registerRoutes } from "./routes";
import { VerifiedEventCache } from "./verified-cache";
import { warmVerifiedEvents } from "./warmup";

export interface BuildOptions {
  /** Pre-verify registered events in the background so the first read is warm. */
  warmup?: boolean;
  /** Absolute path to the built web SPA directory. Set to serve static files + SPA fallback. */
  serveStatic?: string;
}

/**
 * The registry backend: Turso when configured (durable across deploys),
 * otherwise the local file store for development.
 */
async function openEventRegistry(config: ApiConfig): Promise<EventRegistry> {
  if (!config.turso) return new EventStore(config.eventsFilePath);
  const client = createClient({
    url: config.turso.url,
    ...(config.turso.authToken ? { authToken: config.turso.authToken } : {}),
  });
  const store = new TursoEventStore(client);
  await store.init();
  return store;
}

/** The listings index backend — same split as the event registry. */
async function openListingStore(config: ApiConfig): Promise<ListingStore> {
  if (!config.turso) return new ListingStoreFile(config.listingsFilePath);
  const client = createClient({
    url: config.turso.url,
    ...(config.turso.authToken ? { authToken: config.turso.authToken } : {}),
  });
  const store = new TursoListingStore(client);
  await store.init();
  return store;
}

export async function buildApp(
  config: ApiConfig = loadConfig(),
  deps?: AppContext,
  options: BuildOptions = {},
): Promise<FastifyInstance> {
  const https = config.tls
    ? {
        key: readFileSync(config.tls.keyFile),
        cert: readFileSync(config.tls.certFile),
      }
    : undefined;

  const app = Fastify({
    logger: true,
    ...(https ? { https } : {}),
  }) as FastifyInstance;

  registerErrorHandler(app, { skipNotFound: !!options.serveStatic });

  app.get("/health", async () => ({ status: "ok", network: config.kaspaNet }));

  const kaspa = deps?.kaspa ?? new KaspaClient(config.apiBaseUrl, {
    timeoutMs: config.upstream.timeoutMs,
    maxAttempts: config.upstream.maxAttempts,
  });

  const events = deps?.events ?? (await openEventRegistry(config));
  const listings = deps?.listings ?? (await openListingStore(config));
  const verified = deps?.verified ?? new VerifiedEventCache();

  const ctx: AppContext = {
    kaspa,
    events,
    listings,
    verified,
    network: deps?.network ?? config.kaspaNet,
    networkId: deps?.networkId ?? config.networkId,
  };

  registerRoutes(app, ctx);

  if (options.serveStatic) {
    const root = resolve(options.serveStatic);
    await app.register(fastifyStatic, {
      root,
      wildcard: false,
    });

    app.setNotFoundHandler(async (req, reply) => {
      if (req.method !== "GET") return reply.code(404).send({ error: "Not Found" });
      if (req.url.startsWith("/v1") || req.url.startsWith("/health")) {
        return reply.code(404).send({ error: "Not Found" });
      }
      return reply.type("text/html").sendFile("index.html");
    });
  }

  if (options.warmup) {
    // Fire-and-forget: never blocks startup or the first request. Failures are
    // swallowed by the warm-up itself; the request path re-verifies on demand.
    void warmVerifiedEvents(ctx);
  }

  return app;
}
