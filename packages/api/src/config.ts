import { getNetworkConfig, type KaspaNetwork } from "@kticket/kit";
import { parseRegisteredEvents, type RegisteredEvent } from "./events.js";

export interface TlsConfig {
  keyFile: string;
  certFile: string;
}

export interface UpstreamConfig {
  /** Per-request timeout to api-tn10.kaspa.org in ms. */
  timeoutMs: number;
  /** Total attempts for 503/rate-limited responses. */
  maxAttempts: number;
}

export interface ApiConfig {
  port: number;
  host: string;
  kaspaNet: KaspaNetwork;
  /** wRPC network id for broadcast ("testnet-10"). */
  networkId: string;
  /** Kaspa public REST API base URL for the selected network. */
  apiBaseUrl: string;
  /** HTTPS key/cert file paths. Undefined = plain HTTP. */
  tls?: TlsConfig;
  /** Upstream api-tn10.kaspa.org handling (HLD §2.2 error taxonomy). */
  upstream: UpstreamConfig;
  /** Registry of known events served by the reader (the directory). */
  events: RegisteredEvent[];
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Load runtime configuration. `KASPANET` selects the Kaspa network
 * (testnet10 only); `PORT` sets the HTTP port, `HOST` the bind address.
 * `TLS_KEY` / `TLS_CERT` point at PEM files to serve HTTPS; both or neither
 * must be set. `KTICKET_EVENTS` is the JSON events directory;
 * `KASPA_TIMEOUT_MS` / `KASPA_MAX_ATTEMPTS` tune the upstream client.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const network = getNetworkConfig(env.KASPANET);
  const parsedPort = Number(env.PORT ?? DEFAULT_PORT);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;
  const host = env.HOST?.trim() || DEFAULT_HOST;

  const tls = resolveTls(env);

  let events: RegisteredEvent[];
  try {
    events = parseRegisteredEvents(env.KTICKET_EVENTS);
  } catch (err) {
    throw new ConfigError(err instanceof Error ? err.message : "invalid KTICKET_EVENTS");
  }

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
    events,
    ...(tls ? { tls } : {}),
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
