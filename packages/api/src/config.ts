import { getNetworkConfig, type KaspiaNet } from "@kticket/kit";

export interface TlsConfig {
  keyFile: string;
  certFile: string;
}

export interface ApiConfig {
  port: number;
  host: string;
  kaspaNet: KaspiaNet;
  /** Kaspa public REST API base URL for the selected network. */
  apiBaseUrl: string;
  /** HTTPS key/cert file paths. Undefined = plain HTTP. */
  tls?: TlsConfig;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "0.0.0.0";

/**
 * Load runtime configuration. `KASPANET` selects the Kaspa network
 * (testnet10 | mainnet, identical semantics); `PORT` sets the HTTP port,
 * `HOST` the bind address. `TLS_KEY` / `TLS_CERT` point at PEM files to
 * serve HTTPS; both or neither must be set.
 */
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
    apiBaseUrl: network.apiBaseUrl,
    ...(tls ? { tls } : {}),
  };
}

function resolveTls(env: NodeJS.ProcessEnv): TlsConfig | undefined {
  const keyFile = env.TLS_KEY?.trim();
  const certFile = env.TLS_CERT?.trim();

  if (!keyFile && !certFile) {
    return undefined;
  }
  if (!keyFile || !certFile) {
    throw new ConfigError("TLS_KEY and TLS_CERT must both be set to enable HTTPS");
  }

  return { keyFile, certFile };
}
