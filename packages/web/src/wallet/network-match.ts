// Pure network predicates (KTK-175/176): no wallet calls, no UI, no state.

import type { RuntimeConfig } from "../config/runtime";

/** True when a wallet-reported network name is the server's network. */
export function matchesWalletNetwork(walletNetwork: string, config: RuntimeConfig): boolean {
  const normalized = walletNetwork.trim().toLowerCase().replace(/-/g, "_");
  if (normalized.length === 0) return false;
  const expected = config.networkId.toLowerCase().replace(/-/g, "_");
  return normalized === expected || normalized === `kaspa_${expected}`;
}

/** True when a wallet account address belongs to the server-reported network. */
export function addressMatchesNetwork(address: string, config: RuntimeConfig): boolean {
  return address.startsWith(config.addressPrefix);
}
