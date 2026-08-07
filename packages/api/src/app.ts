import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { loadConfig } from "./config";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  const config = loadConfig();

  app.get("/health", async () => ({ status: "ok", network: config.kaspiaNet }));

  app.get("/v1/events", async () => []);

  return app;
}
