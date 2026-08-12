import { buildApp } from "./app";
import { loadConfig } from "./config";
import { loadEnvFile } from "./env";

loadEnvFile();

const config = loadConfig();
const app = await buildApp(config, undefined, { warmup: true });

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
