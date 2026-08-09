import { getNetworkConfig, type KaspaNetwork } from "@kticket/kit";

export interface TlsConfig {
  keyFile: string;
  certFile: string;
}

export interface UpstreamConfig {
  timeoutMs: number;
  maxAttempts: number;
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
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_EVENTS_FILE = "events.json";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const network = getNetworkConfig(env.KASPANET);
  const parsedPort = Number(env.PORT ?? DEFAULT_PORT);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;
  const host = env.HOST?.trim() || DEFAULT_HOST;

  const tls = resolveTls(env);

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
