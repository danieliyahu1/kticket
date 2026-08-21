import { buildApp } from "./app";
import { loadConfig } from "./config";
import { loadEnvFile } from "./env";

loadEnvFile();

const config = loadConfig();
const webDist = process.env.WEB_DIST?.trim();
const app = await buildApp(config, undefined, { warmup: true, serveStatic: webDist });

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Graceful shutdown: stop accepting connections, drain in-flight requests
// (e.g. a finalize whose broadcast already went out), then exit. A deploy that
// sends SIGTERM must not cut a request between broadcast and response.
const SHUTDOWN_TIMEOUT_MS = 10_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  const forceExit = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
  try {
    await app.close();
    clearTimeout(forceExit);
    app.log.info("shutdown complete");
    process.exit(0);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
