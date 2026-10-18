import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config";

const DEFAULT_PORT = 3000;
const EXPLICIT_PORT = 8080;

describe("loadConfig (KASPANET wiring)", () => {
  it("defaults to testnet10 when KASPANET is unset", () => {
    expect(loadConfig({}).kaspaNet).toBe("testnet10");
  });

  it("resolves testnet10", () => {
    expect(loadConfig({ KASPANET: "testnet10" }).kaspaNet).toBe("testnet10");
  });

  it("treats mainnet as invalid and falls back to testnet10", () => {
    expect(loadConfig({ KASPANET: "mainnet" }).kaspaNet).toBe("testnet10");
  });

  it("falls back to testnet10 for invalid values", () => {
    expect(loadConfig({ KASPANET: "banana" }).kaspaNet).toBe("testnet10");
  });

  it("parses PORT with a sane default", () => {
    expect(loadConfig({}).port).toBe(DEFAULT_PORT);
    expect(loadConfig({ PORT: "8080" }).port).toBe(EXPLICIT_PORT);
  });

  it("ignores invalid PORT values", () => {
    expect(loadConfig({ PORT: "-1" }).port).toBe(DEFAULT_PORT);
    expect(loadConfig({ PORT: "abc" }).port).toBe(DEFAULT_PORT);
  });

  it("defaults HOST and reads an explicit one", () => {
    expect(loadConfig({}).host).toBe("0.0.0.0");
    expect(loadConfig({ HOST: "127.0.0.1" }).host).toBe("127.0.0.1");
  });

  it("exposes the upstream API base URL for the network", () => {
    expect(loadConfig({ KASPANET: "testnet10" }).apiBaseUrl).toBe("https://api-tn10.kaspa.org");
  });
});

describe("loadConfig (PUBLIC_ORIGIN)", () => {
  it("defaults the shareable origin to the local app", () => {
    expect(loadConfig({}).publicOrigin).toBe("http://localhost:3000");
  });

  it("reads an explicit public origin and normalizes it", () => {
    expect(loadConfig({ PUBLIC_ORIGIN: "https://kticket.example.com/" }).publicOrigin).toBe(
      "https://kticket.example.com",
    );
    expect(loadConfig({ PUBLIC_ORIGIN: "https://kticket.example.com/app" }).publicOrigin).toBe(
      "https://kticket.example.com",
    );
  });

  it("falls back to AUTH_ORIGIN outside production", () => {
    expect(loadConfig({ AUTH_ORIGIN: "https://kticket.example.com" }).publicOrigin).toBe(
      "https://kticket.example.com",
    );
  });

  it("refuses to guess in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production", AUTH_SECRET: "secret" })).toThrow(
      ConfigError,
    );
    expect(
      loadConfig({
        NODE_ENV: "production",
        AUTH_SECRET: "secret",
        PUBLIC_ORIGIN: "https://kticket.example.com",
      }).publicOrigin,
    ).toBe("https://kticket.example.com");
  });

  it("rejects a non-http origin", () => {
    expect(() => loadConfig({ PUBLIC_ORIGIN: "ftp://kticket.example.com" })).toThrow(ConfigError);
    expect(() => loadConfig({ PUBLIC_ORIGIN: "not a url" })).toThrow(ConfigError);
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

describe("loadConfig (Turso registry)", () => {
  it("keeps the file store when no Turso env vars are set", () => {
    expect(loadConfig({}).turso).toBeUndefined();
  });

  it("resolves the database url without a token (local file: mode)", () => {
    expect(loadConfig({ TURSO_DATABASE_URL: "file:registry.db" }).turso).toEqual({
      url: "file:registry.db",
    });
  });

  it("resolves url and auth token together", () => {
    expect(
      loadConfig({
        TURSO_DATABASE_URL: "libsql://kticket.turso.io",
        TURSO_AUTH_TOKEN: "tok",
      }).turso,
    ).toEqual({ url: "libsql://kticket.turso.io", authToken: "tok" });
  });

  it("rejects a token without a database url", () => {
    expect(() => loadConfig({ TURSO_AUTH_TOKEN: "tok" })).toThrow(ConfigError);
  });
});
