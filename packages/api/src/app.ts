import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { type ApiConfig, loadConfig } from "./config";
import { registerErrorHandler } from "./error-handler";
import { EventRegistry } from "./events";
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

  const ctx: AppContext = deps ?? {
    kaspa: new KaspaClient(config.apiBaseUrl, {
      timeoutMs: config.upstream.timeoutMs,
      maxAttempts: config.upstream.maxAttempts,
    }),
    events: new EventRegistry(config.events),
    network: config.kaspaNet,
    networkId: config.networkId,
  };

  registerRoutes(app, ctx);

  return app;
}
