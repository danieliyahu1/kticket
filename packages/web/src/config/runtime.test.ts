import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FALLBACK_RUNTIME_CONFIG,
  loadRuntimeConfig,
  parseRuntimeConfig,
  resetRuntimeConfig,
} from "./runtime";

const CONFIG = {
  network: "testnet10",
  network_id: "testnet-10",
  wallet_network: "kaspa_testnet_10",
  address_prefix: "kaspatest:",
};

function response(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  resetRuntimeConfig();
});

describe("parseRuntimeConfig (KTK-176)", () => {
  it("accepts the server's identity and maps it to camelCase", () => {
    expect(parseRuntimeConfig(CONFIG)).toEqual({
      network: "testnet10",
      networkId: "testnet-10",
      walletNetwork: "kaspa_testnet_10",
      addressPrefix: "kaspatest:",
    });
  });

  it("rejects missing or empty fields", () => {
    expect(parseRuntimeConfig(null)).toBeNull();
    expect(parseRuntimeConfig({ ...CONFIG, network: "" })).toBeNull();
    expect(parseRuntimeConfig({ ...CONFIG, address_prefix: 42 })).toBeNull();
    expect(parseRuntimeConfig({ network: "testnet10" })).toBeNull();
  });
});

describe("loadRuntimeConfig (KTK-176)", () => {
  it("loads the runtime identity from GET /v1/config", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(CONFIG));
    await expect(loadRuntimeConfig(fetchImpl)).resolves.toEqual({
      network: "testnet10",
      networkId: "testnet-10",
      walletNetwork: "kaspa_testnet_10",
      addressPrefix: "kaspatest:",
    });
    expect(fetchImpl).toHaveBeenCalledWith("/v1/config", expect.objectContaining({ method: "GET" }));
  });

  it("falls back to the build-time network when the request fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(loadRuntimeConfig(fetchImpl)).resolves.toEqual(FALLBACK_RUNTIME_CONFIG);
  });

  it("falls back on a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ error: "nope" }, false));
    await expect(loadRuntimeConfig(fetchImpl)).resolves.toEqual(FALLBACK_RUNTIME_CONFIG);
  });

  it("falls back on a malformed body instead of crashing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ network: "testnet10" }));
    await expect(loadRuntimeConfig(fetchImpl)).resolves.toEqual(FALLBACK_RUNTIME_CONFIG);
  });

  it("keeps the build-time fallback for local development", () => {
    expect(FALLBACK_RUNTIME_CONFIG.network).toBe("testnet10");
    expect(FALLBACK_RUNTIME_CONFIG.addressPrefix).toBe("kaspatest:");
  });
});
