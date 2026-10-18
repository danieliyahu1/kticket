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
  /** Dedicated internal metrics port; 0 disables the metrics listener. */
  metricsPort: number;
  kaspaNet: KaspaNetwork;
  networkId: string;
  /** The wallet's network name (Kasware vocabulary), e.g. "kaspa_testnet_10". */
  walletNetworkName: string;
  /** The bech32 address prefix, including the trailing colon. */
  addressPrefix: string;
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
  /**
   * The absolute origin used for shareable event URLs (canonical, Open Graph,
   * sitemap). Never derived from the request's Host header, so a preview cannot
   * be pointed at an attacker-controlled origin.
   */
  publicOrigin: string;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const DEFAULT_PORT = 3000;
const DEFAULT_METRICS_PORT = 9090;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_EVENTS_FILE = "events.json";
const DEFAULT_LISTINGS_FILE = "listings.json";
const DEFAULT_AUTH_ORIGIN = "http://localhost:3000";
const DEFAULT_PUBLIC_ORIGIN = "http://localhost:3000";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const network = getNetworkConfig(env.KASPANET);
  const parsedPort = Number(env.PORT ?? DEFAULT_PORT);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;
  const host = env.HOST?.trim() || DEFAULT_HOST;
  const metricsPort = portOrZero(env.METRICS_PORT, DEFAULT_METRICS_PORT);

  const tls = resolveTls(env);
  const turso = resolveTurso(env);
  const auth = resolveAuth(env, port);
  const publicOrigin = resolvePublicOrigin(env);

  return {
    port,
    host,
    metricsPort,
    kaspaNet: network.net,
    networkId: network.networkId,
    walletNetworkName: network.walletNetworkName,
    addressPrefix: network.addressPrefix,
    apiBaseUrl: network.apiBaseUrl,
    publicOrigin,
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

/**
 * Resolve the public origin for shareable links. Deployment sets it explicitly;
 * development falls back to AUTH_ORIGIN (the same site) and then to the local
 * API origin. Production refuses to guess: a wrong origin silently breaks every
 * preview and sitemap entry, so it is a boot-time error instead.
 */
function resolvePublicOrigin(env: NodeJS.ProcessEnv): string {
  const explicit = env.PUBLIC_ORIGIN?.trim();
  if (explicit) return normalizeOrigin(explicit, "PUBLIC_ORIGIN");

  if (env.NODE_ENV === "production") {
    throw new ConfigError("PUBLIC_ORIGIN is required in production");
  }

  const authOrigin = env.AUTH_ORIGIN?.trim();
  return authOrigin
    ? normalizeOrigin(authOrigin, "AUTH_ORIGIN")
    : DEFAULT_PUBLIC_ORIGIN;
}

function normalizeOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${label} must be an absolute http(s) URL (got ${value})`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${label} must use http or https (got ${value})`);
  }
  return url.origin;
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** A TCP port, allowing 0 (the ephemeral-port / disabled sentinel). */
function portOrZero(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 65_535 ? n : fallback;
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
