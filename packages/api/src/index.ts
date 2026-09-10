import { buildApp } from "./app";
import { loadConfig } from "./config";
import { metrics, startMetricsServer, type MetricsServer } from "./metrics";

const config = loadConfig();
const webDist = process.env.WEB_DIST?.trim();
const app = await buildApp(config, undefined, { warmup: true, serveStatic: webDist });

metrics.setBuildInfo(process.env.KTICKET_VERSION?.trim() || "unknown", config.kaspaNet);

const metricsServer: MetricsServer | undefined =
  config.metricsPort > 0
    ? await startMetricsServer({ port: config.metricsPort })
    : undefined;

try {
  await app.listen({ port: config.port, host: config.host });
  if (metricsServer) app.log.info({ port: metricsServer.port }, "metrics listening");
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Graceful shutdown: stop accepting connections, drain in-flight requests
// (e.g. a finalize whose broadcast already went out), then exit. A deploy that
// sends SIGTERM must not cut a request between broadcast and response.
//
// A finalize can poll for chain confirmation for ~95s (nine attempts with
// doubling backoff, capped at 16s). The drain budget must therefore exceed that
// wait, and the pod's terminationGracePeriodSeconds must exceed this budget.
const SHUTDOWN_TIMEOUT_MS = 120_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  const forceExit = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
  try {
    await app.close();
    await metricsServer?.close();
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
