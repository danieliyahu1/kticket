// Kaspa message-signature verification (the daftari `kaspa-signature` model,
// implemented on the vendored kaspa-wasm `verifyMessage` — the consensus
// reference for `PersonalMessageSigningHash` BLAKE2b + Schnorr). The claimed
// address's x-only pubkey is recovered with the kit's bech32 decode.

import { decodeAddress } from "@kticket/kit";
import { bytesToHex } from "@noble/hashes/utils.js";
import { loadKaspaWasm } from "../kaspa-wasm.js";

// Only testnet-10 is supported (README); its bech32 HRP is `kaspatest`.
const TESTNET_PREFIX = "kaspatest";

interface KaspaWasmSign {
  verifyMessage: (input: {
    message: string;
    signature: string;
    publicKey: string;
  }) => boolean;
}

const SIGNATURE_HEX = /^[0-9a-fA-F]{128}$/;
const X_PUBKEY_HEX = /^[0-9a-fA-F]{64}$/;

/**
 * The 32-byte x-only public key payload of a v0 P2PK address, or null when the
 * address is not a v0 P2PK address (e.g. a P2SH or unknown version).
 */
export async function addressXPubkey(address: string): Promise<string | null> {
  const decoded = decodeAddress(address, TESTNET_PREFIX);
  if (decoded === null) return null;
  // AddressVersion.PubKey = 0, payload = the 32-byte x-coordinate.
  if (decoded.version !== 0 || decoded.payload.length !== 32) return null;
  const hex = bytesToHex(decoded.payload);
  return X_PUBKEY_HEX.test(hex) ? hex : null;
}

/**
 * Verify a Kaspa message signature against a claimed v0 P2PK address.
 * Returns true only when the address payload is a 32-byte x-only pubkey and the
 * Schnorr signature verifies over `PersonalMessageSigningHash(message)`.
 */
export async function verifySignature(input: {
  address: string;
  message: string;
  signature: string;
}): Promise<boolean> {
  if (!SIGNATURE_HEX.test(input.signature)) return false;
  const mod = await loadKaspaWasm<KaspaWasmSign>();
  const pubkey = await addressXPubkey(input.address);
  if (pubkey === null) return false;
  return mod.verifyMessage({
    message: input.message,
    signature: input.signature,
    publicKey: pubkey,
  });
}
