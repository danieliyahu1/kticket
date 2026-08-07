import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load a `.env` file when present (package-local first, then cwd). Missing
 * files are a no-op — configuration then comes from `process.env` defaults.
 * Existing variables are never overridden, so real shell env wins.
 *
 * @param dir Directory to look for `.env` in. Defaults to the package root.
 */
export function loadEnvFile(dir = dirname(fileURLToPath(import.meta.url))): void {
  const candidates = [resolve(dir, "../.env"), resolve(dir, ".env")];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path) {
    process.loadEnvFile(path);
  }
}
