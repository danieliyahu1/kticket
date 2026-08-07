export const KASPANETS = ["testnet10", "mainnet"] as const;

export type KaspiaNet = (typeof KASPANETS)[number];

export interface NetworkConfig {
  /** Canonical network id, e.g. "testnet10". */
  net: KaspiaNet;
  /** Kaspa public REST API base URL. */
  apiBaseUrl: string;
  /** Network id passed to kaspa-wasm. */
  networkId: string;
  /** Human-readable label. */
  label: string;
}

/**
 * Both networks share identical semantics — only endpoints / network id differ.
 * Tests run on testnet10; the demo launch runs on mainnet.
 */
export const NETWORKS: Record<KaspiaNet, NetworkConfig> = {
  testnet10: {
    net: "testnet10",
    apiBaseUrl: "https://api-tn10.kaspa.org",
    networkId: "testnet-10",
    label: "Testnet 10",
  },
  mainnet: {
    net: "mainnet",
    apiBaseUrl: "https://api.kaspa.org",
    networkId: "mainnet",
    label: "Mainnet",
  },
};

export function isKaspiaNet(value: unknown): value is KaspiaNet {
  return typeof value === "string" && KASPANETS.includes(value as KaspiaNet);
}

/**
 * Resolve a raw `KASPANET` value. Invalid or missing values fall back to
 * `testnet10` so every host is safe by default.
 */
export function resolveNetwork(value: unknown, fallback: KaspiaNet = "testnet10"): KaspiaNet {
  return isKaspiaNet(value) ? value : fallback;
}

export function getNetworkConfig(value: unknown, fallback: KaspiaNet = "testnet10"): NetworkConfig {
  return NETWORKS[resolveNetwork(value, fallback)];
}
