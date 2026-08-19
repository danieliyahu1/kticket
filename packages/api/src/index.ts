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
