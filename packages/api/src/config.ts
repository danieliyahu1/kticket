import { getNetworkConfig, type KaspaNetwork } from "@kticket/kit";
import { SESSION_TTL_MS, type AuthConfig } from "./auth/auth.js";

export interface TlsConfig {
  keyFile: string;
  certFile: string;
}

export interface UpstreamConfig {
  timeoutMs: number;
  maxAttempts: number;
}

export interface TursoConfig {
  url: string;
  authToken?: string;
}

export interface ApiConfig {
  port: number;
  host: string;
  kaspaNet: KaspaNetwork;
  networkId: string;
  apiBaseUrl: string;
  tls?: TlsConfig;
  upstream: UpstreamConfig;
  eventsFilePath: string;
  /** The listings index file (resale discovery store, KTK-151). */
  listingsFilePath: string;
  /** Set when TURSO_DATABASE_URL is configured; otherwise the file store is used. */
  turso?: TursoConfig;
  /** Set when AUTH_SECRET is configured; otherwise the app refuses to boot (fail-closed). */
  auth?: AuthConfig;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_EVENTS_FILE = "events.json";
const DEFAULT_LISTINGS_FILE = "listings.json";
const DEFAULT_AUTH_ORIGIN = "http://localhost:3000";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const network = getNetworkConfig(env.KASPANET);
  const parsedPort = Number(env.PORT ?? DEFAULT_PORT);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;
  const host = env.HOST?.trim() || DEFAULT_HOST;

  const tls = resolveTls(env);
  const turso = resolveTurso(env);
  const auth = resolveAuth(env, port);

  return {
    port,
    host,
    kaspaNet: network.net,
    networkId: network.networkId,
    apiBaseUrl: network.apiBaseUrl,
    upstream: {
      timeoutMs: positiveInt(env.KASPA_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
      maxAttempts: positiveInt(env.KASPA_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS),
    },
    eventsFilePath: env.EVENTS_FILE?.trim() || DEFAULT_EVENTS_FILE,
    listingsFilePath: env.LISTINGS_FILE?.trim() || DEFAULT_LISTINGS_FILE,
    ...(tls ? { tls } : {}),
    ...(turso ? { turso } : {}),
    ...(auth ? { auth } : {}),
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function resolveTls(env: NodeJS.ProcessEnv): TlsConfig | undefined {
  const keyFile = env.TLS_KEY?.trim();
  const certFile = env.TLS_CERT?.trim();

  if (!(keyFile || certFile)) {
    return undefined;
  }
  if (!(keyFile && certFile)) {
    throw new ConfigError("TLS_KEY and TLS_CERT must both be set to enable HTTPS");
  }

  return { keyFile, certFile };
}

/**
 * The registry backend: TURSO_DATABASE_URL selects the durable Turso store,
 * anything unset keeps the local file store. A token without a URL is a
 * misconfiguration; a URL without a token is valid (local file: databases).
 */
function resolveTurso(env: NodeJS.ProcessEnv): TursoConfig | undefined {
  const url = env.TURSO_DATABASE_URL?.trim();
  const authToken = env.TURSO_AUTH_TOKEN?.trim();

  if (!url && !authToken) return undefined;
  if (!url) {
    throw new ConfigError("TURSO_AUTH_TOKEN requires TURSO_DATABASE_URL");
  }

  return { url, ...(authToken ? { authToken } : {}) };
}

/**
 * Resolve the auth config from `AUTH_SECRET`. When unset, `auth` is undefined
 * and `buildApp` refuses to boot (fail-closed). `AUTH_ORIGIN` is the expected
 * `URI` field of the signed claim; it defaults to the local dev origin.
 */
function resolveAuth(env: NodeJS.ProcessEnv, port: number): AuthConfig | undefined {
  const secret = env.AUTH_SECRET?.trim();
  if (!secret) return undefined;
  return {
    secret: new TextEncoder().encode(secret),
    origin: env.AUTH_ORIGIN?.trim() || DEFAULT_AUTH_ORIGIN,
    networkId: getNetworkConfig(env.KASPANET).networkId,
    sessionTtlMs: positiveInt(env.AUTH_SESSION_TTL_MS, SESSION_TTL_MS),
  };
}
