import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvFile } from "./env";

const TEST_KEYS = ["KASPANET", "PORT", "VITE_KASPANET"];

describe("loadEnvFile", () => {
  afterEach(() => {
    for (const key of TEST_KEYS) {
      delete process.env[key];
    }
  });

  it("is a no-op when no .env exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "kticket-env-none-"));
    expect(() => loadEnvFile(dir)).not.toThrow();
  });

  it("loads a .env from the given directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "kticket-env-load-"));
    writeFileSync(join(dir, ".env"), "KASPANET=mainnet\nPORT=4000\n");
    loadEnvFile(dir);
    expect(process.env.KASPANET).toBe("mainnet");
    expect(process.env.PORT).toBe("4000");
  });

  it("never overrides existing shell environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "kticket-env-keep-"));
    writeFileSync(join(dir, ".env"), "KASPANET=mainnet\n");
    process.env.KASPANET = "testnet10";
    loadEnvFile(dir);
    expect(process.env.KASPANET).toBe("testnet10");
  });
});
