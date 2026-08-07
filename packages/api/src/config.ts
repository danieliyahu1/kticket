import { getNetworkConfig } from "@kticket/kit";

export interface ApiConfig {
  port: number;
  kaspaNet: string;
}

const DEFAULT_PORT = 3000;

/**
 * Load runtime configuration. `KASPANET` selects the Kaspa network
 * (testnet10 | mainnet, identical semantics); `PORT` sets the HTTP port.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const network = getNetworkConfig(env.KASPANET);
  const parsedPort = Number(env.PORT ?? DEFAULT_PORT);

  return {
    port: Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT,
    kaspaNet: network.net,
  };
}
