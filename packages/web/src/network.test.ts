import { getNetworkConfig, KASPANETS } from "@kticket/kit";
import { describe, expect, it } from "vitest";

describe("web network wiring (VITE_KASPANET)", () => {
  it("defines both supported networks", () => {
    expect(KASPANETS).toContain("testnet10");
    expect(KASPANETS).toContain("mainnet");
  });

  it("resolves the browser-visible network config", () => {
    expect(getNetworkConfig("testnet10").net).toBe("testnet10");
    expect(getNetworkConfig("mainnet").net).toBe("mainnet");
  });
});
