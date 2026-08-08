export const KASPA_NETWORK_IDS = ["testnet10"] as const;

export type KaspaNetwork = (typeof KASPA_NETWORK_IDS)[number];

export interface NetworkConfig {
  /** Canonical network id, e.g. "testnet10". */
  net: KaspaNetwork;
  /** Kaspa public REST API base URL. */
  apiBaseUrl: string;
  /** Network id passed to kaspa-wasm. */
  networkId: string;
  /** Human-readable label. */
  label: string;
}

/** Only testnet-10 is supported (HLD v0.23: mainnet out of scope). */
export const NETWORKS: Record<KaspaNetwork, NetworkConfig> = {
  testnet10: {
    net: "testnet10",
    apiBaseUrl: "https://api-tn10.kaspa.org",
    networkId: "testnet-10",
    label: "Testnet 10",
  },
};

export function isKaspaNetwork(value: unknown): value is KaspaNetwork {
  return typeof value === "string" && KASPA_NETWORK_IDS.includes(value as KaspaNetwork);
}

/**
 * Resolve a raw `KASPANET` value. Invalid or missing values fall back to
 * `testnet10` so every host is safe by default.
 */
export function resolveNetwork(value: unknown, fallback: KaspaNetwork = "testnet10"): KaspaNetwork {
  return isKaspaNetwork(value) ? value : fallback;
}

export function getNetworkConfig(
  value: unknown,
  fallback: KaspaNetwork = "testnet10",
): NetworkConfig {
  return NETWORKS[resolveNetwork(value, fallback)];
}
