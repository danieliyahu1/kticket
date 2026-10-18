// The server's runtime network identity (KTK-176).
//
// The browser never decides which chain it is on from a build-time variable.
// It loads `GET /v1/config` once at boot and everything — the wallet network
// name, the address prefix, the display label — is read from that answer. The
// build-time value survives only as a fallback for local development when the
// request fails, so a failed config fetch never crashes or blocks the app.

import { NETWORKS } from "@kticket/kit";
import { fallbackNetwork } from "../network";

export interface RuntimeConfig {
  /** Canonical network id, e.g. `testnet10`. */
  network: string;
  /** wRPC network id, e.g. `testnet-10`. */
  networkId: string;
  /** The wallet's network name, e.g. `kaspa_testnet_10`. */
  walletNetwork: string;
  /** The bech32 address prefix, including the trailing colon. */
  addressPrefix: string;
}

export const FALLBACK_RUNTIME_CONFIG: RuntimeConfig = {
  network: fallbackNetwork.net,
  networkId: fallbackNetwork.networkId,
  walletNetwork: fallbackNetwork.walletNetworkName,
  addressPrefix: fallbackNetwork.addressPrefix,
};

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Validate a `/v1/config` payload; anything malformed is treated as absent. */
export function parseRuntimeConfig(value: unknown): RuntimeConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { network, network_id, wallet_network, address_prefix } = record;
  if (
    !nonEmptyString(network) ||
    !nonEmptyString(network_id) ||
    !nonEmptyString(wallet_network) ||
    !nonEmptyString(address_prefix)
  ) {
    return null;
  }
  return {
    network,
    networkId: network_id,
    walletNetwork: wallet_network,
    addressPrefix: address_prefix,
  };
}

/** A human label for the loaded network, falling back to its raw id. */
export function networkLabel(config: RuntimeConfig): string {
  return (
    Object.values(NETWORKS).find((candidate) => candidate.net === config.network)?.label ??
    config.network
  );
}

interface RuntimeSnapshot {
  config: RuntimeConfig;
  /** False until the first `/v1/config` attempt settles (success or fallback). */
  loaded: boolean;
}

let snapshot: RuntimeSnapshot = { config: FALLBACK_RUNTIME_CONFIG, loaded: false };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** The one authority: both React and non-React readers see this snapshot. */
export function getRuntimeSnapshot(): RuntimeSnapshot {
  return snapshot;
}

/** The identity in force for non-React modules (signing, the wallet guard). */
export function getRuntimeConfig(): RuntimeConfig {
  return snapshot.config;
}

export function setRuntimeConfig(next: RuntimeConfig): void {
  snapshot = { config: next, loaded: true };
  emit();
}

/** Test seam: return to the pre-boot state. */
export function resetRuntimeConfig(): void {
  snapshot = { config: FALLBACK_RUNTIME_CONFIG, loaded: false };
  emit();
}

export function subscribeToRuntimeConfig(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const CONFIG_PATH = "/v1/config";
const CONFIG_TIMEOUT_MS = 5_000;

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(ms)
    : undefined;
}

/**
 * Fetch the runtime identity. Never throws: an unreachable server, a non-2xx
 * response, a stalled request, or a malformed body all resolve to the fallback.
 */
export async function loadRuntimeConfig(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = CONFIG_TIMEOUT_MS,
): Promise<RuntimeConfig> {
  try {
    const signal = timeoutSignal(timeoutMs);
    const response = await fetchImpl(CONFIG_PATH, {
      method: "GET",
      headers: { Accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return FALLBACK_RUNTIME_CONFIG;
    const parsed = parseRuntimeConfig(await response.json());
    return parsed ?? FALLBACK_RUNTIME_CONFIG;
  } catch {
    return FALLBACK_RUNTIME_CONFIG;
  }
}
