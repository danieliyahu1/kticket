import { describe, expect, it } from "vitest";
import {
  getNetworkConfig,
  isKaspaNetwork,
  KASPA_NETWORK_IDS,
  NETWORKS,
  resolveNetwork,
} from "./network";

describe("network selection (KASPANET)", () => {
  it("supports only testnet10", () => {
    expect(KASPA_NETWORK_IDS).toEqual(["testnet10"]);
  });

  it("defines a config for every supported network", () => {
    for (const net of KASPA_NETWORK_IDS) {
      expect(NETWORKS[net].net).toBe(net);
    }
  });

  it("recognises valid KASPANET values", () => {
    expect(isKaspaNetwork("testnet10")).toBe(true);
  });

  it("rejects invalid KASPANET values (incl. mainnet)", () => {
    expect(isKaspaNetwork("mainnet")).toBe(false);
    expect(isKaspaNetwork("banana")).toBe(false);
    expect(isKaspaNetwork("")).toBe(false);
    expect(isKaspaNetwork(undefined)).toBe(false);
  });

  it("resolves valid values as-is", () => {
    expect(resolveNetwork("testnet10")).toBe("testnet10");
  });

  it("falls back to testnet10 for missing or invalid values (incl. mainnet)", () => {
    expect(resolveNetwork(undefined)).toBe("testnet10");
    expect(resolveNetwork("mainnet")).toBe("testnet10");
    expect(resolveNetwork("banana")).toBe("testnet10");
  });

  it("honours an explicit fallback", () => {
    expect(resolveNetwork("banana", "testnet10")).toBe("testnet10");
  });

  it("getNetworkConfig returns the matching network config", () => {
    expect(getNetworkConfig("testnet10").apiBaseUrl).toBe(NETWORKS.testnet10.apiBaseUrl);
    expect(getNetworkConfig("testnet10").networkId).toBe("testnet-10");
    expect(getNetworkConfig("banana").net).toBe("testnet10");
    expect(getNetworkConfig("mainnet").net).toBe("testnet10");
  });
});
