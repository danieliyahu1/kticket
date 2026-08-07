import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config";

describe("loadConfig (KASPANET wiring)", () => {
  it("defaults to testnet10 when KASPANET is unset", () => {
    expect(loadConfig({}).kaspaNet).toBe("testnet10");
  });

  it("resolves testnet10", () => {
    expect(loadConfig({ KASPANET: "testnet10" }).kaspaNet).toBe("testnet10");
  });

  it("resolves mainnet", () => {
    expect(loadConfig({ KASPANET: "mainnet" }).kaspaNet).toBe("mainnet");
  });

  it("falls back to testnet10 for invalid values", () => {
    expect(loadConfig({ KASPANET: "banana" }).kaspaNet).toBe("testnet10");
  });

  it("parses PORT with a sane default", () => {
    expect(loadConfig({}).port).toBe(3000);
    expect(loadConfig({ PORT: "8080" }).port).toBe(8080);
  });

  it("ignores invalid PORT values", () => {
    expect(loadConfig({ PORT: "-1" }).port).toBe(3000);
    expect(loadConfig({ PORT: "abc" }).port).toBe(3000);
  });

  it("defaults HOST and reads an explicit one", () => {
    expect(loadConfig({}).host).toBe("0.0.0.0");
    expect(loadConfig({ HOST: "127.0.0.1" }).host).toBe("127.0.0.1");
  });

  it("exposes the upstream API base URL for the network", () => {
    expect(loadConfig({ KASPANET: "testnet10" }).apiBaseUrl).toBe(
      "https://api-testnet-10.kaspa.org",
    );
    expect(loadConfig({ KASPANET: "mainnet" }).apiBaseUrl).toBe("https://api.kaspa.org");
  });
});

describe("loadConfig (TLS)", () => {
  it("serves plain HTTP when TLS is unset", () => {
    expect(loadConfig({}).tls).toBeUndefined();
  });

  it("resolves TLS key/cert when both are set", () => {
    expect(loadConfig({ TLS_KEY: "key.pem", TLS_CERT: "cert.pem" }).tls).toEqual({
      keyFile: "key.pem",
      certFile: "cert.pem",
    });
  });

  it("rejects a TLS key without a cert", () => {
    expect(() => loadConfig({ TLS_KEY: "key.pem" })).toThrow(ConfigError);
  });

  it("rejects a TLS cert without a key", () => {
    expect(() => loadConfig({ TLS_CERT: "cert.pem" })).toThrow(ConfigError);
  });
});
