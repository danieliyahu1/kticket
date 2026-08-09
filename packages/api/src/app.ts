import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { type ApiConfig, loadConfig } from "./config";
import { registerErrorHandler } from "./error-handler";
import { EventStore } from "./eventstore";
import { KaspaClient } from "./kaspa-client";
import { type AppContext, registerRoutes } from "./routes";

export async function buildApp(
  config: ApiConfig = loadConfig(),
  deps?: AppContext,
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

  registerErrorHandler(app);

  app.get("/health", async () => ({ status: "ok", network: config.kaspaNet }));

  const kaspa = deps?.kaspa ?? new KaspaClient(config.apiBaseUrl, {
    timeoutMs: config.upstream.timeoutMs,
    maxAttempts: config.upstream.maxAttempts,
  });

  const events = deps?.events ?? new EventStore(config.eventsFilePath);

  const ctx: AppContext = {
    kaspa,
    events,
    network: deps?.network ?? config.kaspaNet,
    networkId: deps?.networkId ?? config.networkId,
  };

  registerRoutes(app, ctx);

  return app;
}
