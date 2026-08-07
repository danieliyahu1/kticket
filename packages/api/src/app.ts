import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { type ApiConfig, loadConfig } from "./config";
import { registerErrorHandler } from "./error-handler";

export async function buildApp(config: ApiConfig = loadConfig()): Promise<FastifyInstance> {
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

  app.get("/v1/events", async () => []);

  return app;
}
