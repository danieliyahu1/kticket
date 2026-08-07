import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

describe("loadConfig (KASPANET wiring)", () => {
  it("defaults to testnet10 when KASPANET is unset", () => {
    expect(loadConfig({}).kaspiaNet).toBe("testnet10");
  });

  it("resolves testnet10", () => {
    expect(loadConfig({ KASPANET: "testnet10" }).kaspiaNet).toBe("testnet10");
  });

  it("resolves mainnet", () => {
    expect(loadConfig({ KASPANET: "mainnet" }).kaspiaNet).toBe("mainnet");
  });

  it("falls back to testnet10 for invalid values", () => {
    expect(loadConfig({ KASPANET: "banana" }).kaspiaNet).toBe("testnet10");
  });

  it("parses PORT with a sane default", () => {
    expect(loadConfig({}).port).toBe(3000);
    expect(loadConfig({ PORT: "8080" }).port).toBe(8080);
  });

  it("ignores invalid PORT values", () => {
    expect(loadConfig({ PORT: "-1" }).port).toBe(3000);
    expect(loadConfig({ PORT: "abc" }).port).toBe(3000);
  });
});
