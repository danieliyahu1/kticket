import { getNetworkConfig, KASPANETS } from "@kticket/kit";
import { describe, expect, it } from "vitest";

describe("door network wiring (VITE_KASPANET)", () => {
  it("supports only testnet10", () => {
    expect(KASPANETS).toEqual(["testnet10"]);
  });

  it("resolves the browser-visible network config", () => {
    expect(getNetworkConfig("testnet10").net).toBe("testnet10");
    expect(getNetworkConfig("mainnet").net).toBe("testnet10");
  });
});
