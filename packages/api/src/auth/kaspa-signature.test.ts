import { describe, expect, it } from "vitest";
import { addressXPubkey, verifySignature } from "./kaspa-signature.js";

// A real testnet key (generated) used to produce genuine Kaspa message
// signatures via the vendored kaspa-wasm, so the tests exercise the actual
// consensus signing path rather than a mock.
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

const MESSAGE = "kticket message\nline 2";

describe("verifySignature", () => {
  it("accepts a genuine signature from the matching key", async () => {
    const mod = await loadWasm();
    const priv = new mod.PrivateKey(PRIVATE_KEY_HEX);
    const address = priv.toAddress("testnet-10").toString();
    const signature = mod.signMessage({ message: MESSAGE, privateKey: priv });
    await expect(verifySignature({ address, message: MESSAGE, signature })).resolves.toBe(true);
  });

  it("rejects a signature from a different key", async () => {
    const mod = await loadWasm();
    const priv = new mod.PrivateKey(PRIVATE_KEY_HEX);
    const address = priv.toAddress("testnet-10").toString();
    const other = new mod.PrivateKey("5f6b27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da30");
    const signature = mod.signMessage({ message: MESSAGE, privateKey: other });
    await expect(verifySignature({ address, message: MESSAGE, signature })).resolves.toBe(false);
  });

  it("rejects a non-hex signature", async () => {
    const mod = await loadWasm();
    const priv = new mod.PrivateKey(PRIVATE_KEY_HEX);
    const address = priv.toAddress("testnet-10").toString();
    await expect(
      verifySignature({ address, message: MESSAGE, signature: "not-hex" }),
    ).resolves.toBe(false);
  });

  it("rejects a non-v0 / non-P2PK address", async () => {
    const mod = await loadWasm();
    const priv = new mod.PrivateKey(PRIVATE_KEY_HEX);
    const signature = mod.signMessage({ message: MESSAGE, privateKey: priv });
    await expect(
      verifySignature({ address: "kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", message: MESSAGE, signature }),
    ).resolves.toBe(false);
  });
});

describe("addressXPubkey", () => {
  it("recovers the 32-byte x-coordinate for a v0 P2PK address", async () => {
    const mod = await loadWasm();
    const priv = new mod.PrivateKey(PRIVATE_KEY_HEX);
    const address = priv.toAddress("testnet-10").toString();
    const pubkey = await addressXPubkey(address);
    expect(pubkey).toMatch(/^[0-9a-fA-F]{64}$/);
  });

  it("returns null for a garbage string", async () => {
    await expect(addressXPubkey("not-an-address")).resolves.toBeNull();
  });
});
