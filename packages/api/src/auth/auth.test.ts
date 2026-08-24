import { describe, expect, it } from "vitest";
import {
  buildSignInMessage,
  handleCreateChallenge,
  handleCreateSession,
  parseSignInMessage,
  verifyToken,
} from "./auth.js";
import { InMemoryAuthStore } from "./auth-store.js";

const ORIGIN = "https://tickets.example.com";
const NETWORK_ID = "testnet-10";
const SECRET = new TextEncoder().encode("test-secret-for-kticket-api");
const CONFIG = { origin: ORIGIN, secret: SECRET, networkId: NETWORK_ID };

const PRIVATE_KEY_HEX = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";

interface KaspaWasm {
  PrivateKey: new (key: string) => {
    toAddress: (network: string) => { toString(): string };
  };
  signMessage: (input: { message: string; privateKey: unknown }) => string;
}

async function loadWasm(): Promise<KaspaWasm> {
  return (await import("../../vendor/kaspa-wasm/kaspa.js")) as unknown as KaspaWasm;
}

async function signedInAddress() {
  const mod = await loadWasm();
  const priv = new mod.PrivateKey(PRIVATE_KEY_HEX);
  return { priv, address: priv.toAddress("testnet-10").toString() };
}

describe("buildSignInMessage / parseSignInMessage", () => {
  it("round-trips a message", () => {
    const msg = buildSignInMessage({
      address: "kaspatest:abc",
      origin: ORIGIN,
      networkId: NETWORK_ID,
      nonce: "nonce123",
      issuedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(parseSignInMessage(msg)).toEqual({
      address: "kaspatest:abc",
      origin: ORIGIN,
      networkId: NETWORK_ID,
      nonce: "nonce123",
    });
  });

  it("rejects a tampered message", () => {
    expect(parseSignInMessage("garbage")).toBeNull();
  });
});

describe("handleCreateChallenge", () => {
  it("returns a nonce + structured message", async () => {
    const store = new InMemoryAuthStore();
    const { address } = await signedInAddress();
    const result = await handleCreateChallenge(store, { address }, CONFIG);
    expect(result.nonce).toBeTruthy();
    expect(parseSignInMessage(result.message)?.address).toBe(address);
  });

  it("rejects a missing address", async () => {
    const store = new InMemoryAuthStore();
    await expect(handleCreateChallenge(store, {}, CONFIG)).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe("handleCreateSession", () => {
  it("issues a token for a genuine signature (challenge -> sign -> session)", async () => {
    const mod = await loadWasm();
    const store = new InMemoryAuthStore();
    const { priv, address } = await signedInAddress();
    const challenge = await handleCreateChallenge(store, { address }, CONFIG);
    const signature = mod.signMessage({ message: challenge.message, privateKey: priv });
    const result = await handleCreateSession(store, { message: challenge.message, signature }, CONFIG);
    expect(result.token).toBeTruthy();
    expect(result.expires_in_seconds).toBe(900);
    await expect(verifyToken(`Bearer ${result.token}`, SECRET)).resolves.toEqual({ address });
  });

  it("rejects a signature from a different key", async () => {
    const mod = await loadWasm();
    const store = new InMemoryAuthStore();
    const { address } = await signedInAddress();
    const challenge = await handleCreateChallenge(store, { address }, CONFIG);
    const other = new mod.PrivateKey("5f6b27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da30");
    const signature = mod.signMessage({ message: challenge.message, privateKey: other });
    await expect(
      handleCreateSession(store, { message: challenge.message, signature }, CONFIG),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects a nonce after it is consumed once (no replay)", async () => {
    const mod = await loadWasm();
    const store = new InMemoryAuthStore();
    const { priv, address } = await signedInAddress();
    const challenge = await handleCreateChallenge(store, { address }, CONFIG);
    const signature = mod.signMessage({ message: challenge.message, privateKey: priv });
    await handleCreateSession(store, { message: challenge.message, signature }, CONFIG);
    await expect(
      handleCreateSession(store, { message: challenge.message, signature }, CONFIG),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects a message signed for a different origin", async () => {
    const mod = await loadWasm();
    const store = new InMemoryAuthStore();
    const { priv, address } = await signedInAddress();
    const foreignMessage = buildSignInMessage({
      address,
      origin: "https://evil.example.com",
      networkId: NETWORK_ID,
      nonce: "x",
      issuedAt: new Date().toISOString(),
    });
    const signature = mod.signMessage({ message: foreignMessage, privateKey: priv });
    await expect(
      handleCreateSession(store, { message: foreignMessage, signature }, CONFIG),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects a message signed for a different network", async () => {
    const mod = await loadWasm();
    const store = new InMemoryAuthStore();
    const { priv, address } = await signedInAddress();
    const wrongNetMessage = buildSignInMessage({
      address,
      origin: ORIGIN,
      networkId: "mainnet",
      nonce: "x",
      issuedAt: new Date().toISOString(),
    });
    const signature = mod.signMessage({ message: wrongNetMessage, privateKey: priv });
    await expect(
      handleCreateSession(store, { message: wrongNetMessage, signature }, CONFIG),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects a malformed message", async () => {
    const store = new InMemoryAuthStore();
    await expect(
      handleCreateSession(store, { message: "not a message", signature: "ff".repeat(64) }, CONFIG),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe("verifyToken", () => {
  it("returns null for no/malformed/garbage bearer", async () => {
    await expect(verifyToken(undefined, SECRET)).resolves.toBeNull();
    await expect(verifyToken("Basic abc", SECRET)).resolves.toBeNull();
    await expect(verifyToken("Bearer garbage", SECRET)).resolves.toBeNull();
  });
});
