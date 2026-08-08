import { getNetworkConfig, KASPA_NETWORK_IDS } from "@kticket/kit";
import { describe, expect, it } from "vitest";

describe("door network wiring (VITE_KASPANET)", () => {
  it("supports only testnet10", () => {
    expect(KASPA_NETWORK_IDS).toEqual(["testnet10"]);
  });

  it("resolves the browser-visible network config", () => {
    expect(getNetworkConfig("testnet10").net).toBe("testnet10");
    expect(getNetworkConfig("mainnet").net).toBe("testnet10");
  });
});
