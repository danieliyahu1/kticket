// Local development runner — run the app without Docker.
//
// Two processes behind one command:
//   api — the Fastify backend in watch mode (tsx)
//   web — the Vite dev server, which proxies /v1 to the API
//
// Production still ships the single image built by the Dockerfile; this script
// only shortens the local inner loop. Config comes from `.env` (shared with
// Compose) and `.env.local` (dev-only overrides, git-ignored); the real
// environment wins over both. An empty value in `.env.local` unsets a key —
// `TURSO_DATABASE_URL=` therefore forces the local file store.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_API_PORT = "3000";
const DEFAULT_WEB_PORT = "5173";
const DEFAULT_NETWORK = "testnet10";
const SILVERC_BIN = join(
  ROOT,
  "packages",
  "kit",
  "silverc",
  "target",
  "release",
  process.platform === "win32" ? "kticket-silverc.exe" : "kticket-silverc",
);

/** `KEY=VALUE` lines; `null` marks an explicitly empty value (an unset). */
function parseEnvFile(path) {
  const entries = {};
  if (!existsSync(path)) return entries;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    if (!key) continue;
    const value = stripQuotes(line.slice(separator + 1).trim());
    entries[key] = value === "" ? null : value;
  }
  return entries;
}

function stripQuotes(value) {
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  return quoted ? value.slice(1, -1) : value;
}

/** Merge `source` into `target`; a `null` value deletes the key. */
function apply(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value === null || value === undefined) delete target[key];
    else target[key] = value;
  }
  return target;
}

/**
 * Resolve both child environments. Precedence: real environment > `.env.local`
 * > `.env`. The API's `AUTH_ORIGIN` and the Vite proxy are derived from the
 * chosen ports so wallet sign-in's `URI` claim always matches the browser
 * origin (the Vite server), not the API's.
 */
function resolveConfig() {
  const base = apply(apply({}, parseEnvFile(join(ROOT, ".env"))), parseEnvFile(join(ROOT, ".env.local")));
  apply(base, process.env);

  const apiPort = base.PORT?.trim() || DEFAULT_API_PORT;
  const webPort = base.WEB_PORT?.trim() || DEFAULT_WEB_PORT;
  const network = base.KASPANET?.trim() || DEFAULT_NETWORK;
  const configuredSecret = base.AUTH_SECRET?.trim();

  const apiEnv = {
    ...base,
    KASPANET: network,
    HOST: base.HOST?.trim() || "127.0.0.1",
    PORT: apiPort,
    AUTH_SECRET: configuredSecret || randomBytes(32).toString("hex"),
    AUTH_ORIGIN: `http://localhost:${webPort}`,
  };
  const webEnv = {
    ...base,
    VITE_KASPANET: network,
    VITE_API_PROXY: `http://localhost:${apiPort}`,
  };

  return {
    apiPort,
    webPort,
    network,
    store: base.TURSO_DATABASE_URL ? "Turso" : "local file",
    ephemeralSecret: !configuredSecret,
    apiEnv,
    webEnv,
  };
}

function localBin(name) {
  return join(ROOT, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
}

function prefix(name, stream) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) process.stdout.write(`[${name}] ${line}\n`);
  });
  stream.on("end", () => {
    if (buffer) process.stdout.write(`[${name}] ${buffer}\n`);
  });
}

function quoteToken(token) {
  return /[\s"]/u.test(token) ? `"${token.replace(/"/g, '""')}"` : token;
}

/** Windows `.cmd` shims need a shell; POSIX bins spawn directly. */
function spawnChild(command, args, options) {
  if (process.platform === "win32") {
    // A single pre-quoted command string avoids DEP0190 (unescaped args + shell).
    return spawn([command, ...args].map(quoteToken).join(" "), { ...options, shell: true });
  }
  return spawn(command, args, { ...options, shell: false });
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

function main() {
  const flags = new Set(process.argv.slice(2));
  const { apiPort, webPort, network, store, ephemeralSecret, apiEnv, webEnv } = resolveConfig();
  const withApi = !flags.has("--web");
  const withWeb = !flags.has("--api");

  const children = [];
  let shuttingDown = false;

  const shutdown = (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) killTree(child);
    setTimeout(() => process.exit(code), 200).unref();
  };

  const start = (name, command, commandArgs, cwd, env) => {
    const child = spawnChild(command, commandArgs, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    prefix(name, child.stdout);
    prefix(name, child.stderr);
    child.on("exit", (code) => {
      if (shuttingDown) return;
      process.stdout.write(`[${name}] exited with code ${code ?? "null"}\n`);
      shutdown(code ?? 1);
    });
    children.push(child);
  };

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  const banner = [
    "",
    "kticket local dev",
    withApi ? `  api   http://localhost:${apiPort}   network ${network}, store: ${store}` : null,
    withWeb ? `  web   http://localhost:${webPort}   /v1 → http://localhost:${apiPort}` : null,
    ephemeralSecret ? "  auth  ephemeral AUTH_SECRET — set AUTH_SECRET in .env.local to persist sessions" : null,
    !existsSync(SILVERC_BIN) ? "  warn  kticket-silverc not built — deploy flows will fail (run: npm run build:silverc)" : null,
    "",
  ].filter(Boolean);
  process.stdout.write(`${banner.join("\n")}\n`);

  if (withApi) start("api", localBin("tsx"), ["watch", "packages/api/src/index.ts"], ROOT, apiEnv);
  if (withWeb) {
    start("web", localBin("vite"), ["--port", webPort, "--strictPort"], join(ROOT, "packages", "web"), webEnv);
  }
}

main();
