import { describe, expect, it } from "vitest";
import { getNetworkConfig, isKaspiaNet, KASPANETS, NETWORKS, resolveNetwork } from "./network";

describe("network selection (KASPANET)", () => {
  it("supports exactly the two documented networks", () => {
    expect(KASPANETS).toEqual(["testnet10", "mainnet"]);
  });

  it("defines a config for every supported network", () => {
    for (const net of KASPANETS) {
      expect(NETWORKS[net].net).toBe(net);
    }
  });

  it("recognises valid KASPANET values", () => {
    expect(isKaspiaNet("testnet10")).toBe(true);
    expect(isKaspiaNet("mainnet")).toBe(true);
  });

  it("rejects invalid KASPANET values", () => {
    expect(isKaspiaNet("banana")).toBe(false);
    expect(isKaspiaNet("")).toBe(false);
    expect(isKaspiaNet(undefined)).toBe(false);
  });

  it("resolves valid values as-is", () => {
    expect(resolveNetwork("testnet10")).toBe("testnet10");
    expect(resolveNetwork("mainnet")).toBe("mainnet");
  });

  it("falls back to testnet10 for missing or invalid values", () => {
    expect(resolveNetwork(undefined)).toBe("testnet10");
    expect(resolveNetwork("banana")).toBe("testnet10");
  });

  it("honours an explicit fallback", () => {
    expect(resolveNetwork("banana", "mainnet")).toBe("mainnet");
  });

  it("getNetworkConfig returns the matching network config", () => {
    expect(getNetworkConfig("mainnet").apiBaseUrl).toBe(NETWORKS.mainnet.apiBaseUrl);
    expect(getNetworkConfig("testnet10").networkId).toBe("testnet-10");
    expect(getNetworkConfig("banana").net).toBe("testnet10");
  });
});
