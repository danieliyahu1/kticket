/**
 * Normalize a Kaspa message signature to the 128-hex form the API verifies.
 *
 * Kasware returns whatever its bundled kaspa-wasm `signMessage` emits: older
 * extensions return base64, newer ones hex. The API's `verifySignature` accepts
 * only exactly 128 hex chars, so a base64 signature is decoded to its 64 raw
 * bytes and re-encoded.
 */
import { devLog } from "../lib/log";

const SIGNATURE_HEX = /^[0-9a-fA-F]{128}$/;
const SIGNATURE_BYTES = 64;

export function normalizeSignature(signature: string): string {
  const trimmed = signature.trim();
  if (SIGNATURE_HEX.test(trimmed)) {
    devLog(`[auth] signature format=hex inLen=${trimmed.length} outLen=${trimmed.length} changed=false`);
    return trimmed.toLowerCase();
  }
  const bytes = base64ToBytes(trimmed);
  if (bytes === null || bytes.length !== SIGNATURE_BYTES) {
    devLog(`[auth] signature format=other inLen=${trimmed.length} outLen=${trimmed.length} changed=false`);
    return trimmed;
  }
  const hex = bytesToHex(bytes);
  devLog(`[auth] signature format=base64 inLen=${trimmed.length} outLen=${hex.length} changed=true`);
  return hex;
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
