// Shared request-validation helpers (HLD §2.2 error taxonomy). Every helper
// throws an `invalid` `ApiError` (HTTP 400) so wire-level validation is
// consistent across the tx build / broadcast and events paths.

import { invalidError } from "./errors.js";

export const HEX64 = /^[0-9a-fA-F]{64}$/;
export const HEX = /^[0-9a-fA-F]+$/;
/** Standard Kaspa P2SH output script: `aa20 <32-byte hash> 87`. */
export const P2SH_SCRIPT = /^aa20[0-9a-fA-F]{64}87$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function str(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function hex64(value: unknown, label: string): string {
  const s = str(value, label).toLowerCase();
  if (!HEX64.test(s)) throw invalidError(`${label} must be 64 hex chars`);
  return s;
}

export function hex(value: unknown, label: string): string {
  const s = str(value, label).toLowerCase();
  if (!HEX.test(s) || s.length === 0) throw invalidError(`${label} must be hex`);
  return s;
}

export function int(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw invalidError(`${label} must be an integer`);
  }
  return value;
}

export function uint(value: unknown, label: string): number {
  const n = int(value, label);
  if (n < 0) throw invalidError(`${label} must be non-negative`);
  return n;
}
