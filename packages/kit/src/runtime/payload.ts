// Door-flow codecs (KTK-122, parent KTK-118) — shared by api + web, no
// signing and no compiling.
//
//   encodeTicketId / decodeTicketId — an inert ticket identity codec:
//       {v, e: event_cov_id, t: ticket_txid, i: index}
//     The ticket's identity, not a credential.
//
//   encodeUsePayload / decodeUsePayload — the owner's check-in QR payload
//     (HLD v7 Option B, FR-4):
//       {use_id, template, owner_signed}
//     compressed with deflate + base64url to roughly 0.5-0.7 KB for a single,
//     reliably scannable QR (C3). The `signing_template` is deliberately NOT
//     carried: it is a different serialization of the same tx, rebuildable
//     deterministically from chain facts (the gate's sign-template endpoint).
//
// Both codecs throw on malformed input — a decode failure on the gate renders
// red "Not a valid ticket code." (FR-23).

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export interface TicketId {
  /** Codec version (1). */
  v: number;
  /** The event covenant id (64 hex). */
  e: string;
  /** The ticket's mint transaction id (64 hex). */
  t: string;
  /** The ticket output index in the mint tx. */
  i: number;
}

export interface UsePayload {
  /** Correlation id issued by use/prepare — a fresh prepare invalidates prior QRs. */
  use_id: string;
  /** The unsigned mark_used tx template the owner pre-signs. */
  template: unknown;
  /** The wallet's raw signature output for the owner's inputs. */
  owner_signed: unknown;
}

const TICKET_ID_VERSION = 1;
const HEX64 = /^[0-9a-f]{64}$/;

function assertTicketId(id: TicketId): void {
  if (id.v !== TICKET_ID_VERSION) {
    throw new Error(`unsupported ticket id version ${id.v}`);
  }
  if (!HEX64.test(id.e) || !HEX64.test(id.t)) {
    throw new Error("ticket id event/tx must be 64 hex chars");
  }
  if (!Number.isSafeInteger(id.i) || id.i < 0) {
    throw new Error("ticket id index must be a non-negative integer");
  }
}

/**
 * Pack a ticket id as a compact binary blob:
 * `version u8 | event_cov_id[32] | ticket_txid[32] | index u32 LE`.
 */
function packTicketId(id: TicketId): Uint8Array {
  const e = hexToBytes(id.e);
  const t = hexToBytes(id.t);
  const out = new Uint8Array(1 + 32 + 32 + 4);
  out[0] = id.v;
  out.set(e, 1);
  out.set(t, 1 + 32);
  new DataView(out.buffer).setUint32(1 + 32 + 32, id.i, true);
  return out;
}

function unpackTicketId(bytes: Uint8Array): TicketId {
  if (bytes.length !== 1 + 32 + 32 + 4) {
    throw new Error("ticket id has an invalid length");
  }
  const id: TicketId = {
    v: bytes[0] ?? 0,
    e: bytesToHex(bytes.subarray(1, 1 + 32)),
    t: bytesToHex(bytes.subarray(1 + 32, 1 + 32 + 32)),
    i: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1 + 32 + 32, true),
  };
  assertTicketId(id);
  return id;
}

/** Encode a ticket id as a base64url string (the gate's bare ticket-id QR). */
export function encodeTicketId(id: TicketId): string {
  assertTicketId(id);
  return bytesToBase64Url(packTicketId(id));
}

/** Decode a ticket id from its base64url form. Throws on malformed input. */
export function decodeTicketId(payload: string): TicketId {
  return unpackTicketId(base64UrlToBytes(payload));
}

// --- deflate + base64url (the QR payload compression, HLD v7 Option B) -----

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  // Native in browsers and Node >=20 (the repo engine floor) — no polyfill or
  // node:zlib import needed, so the kit stays environment-agnostic.
  const stream = new CompressionStream("deflate");
  const writer = stream.writable.getWriter();
  await writer.write(data as Parameters<typeof writer.write>[0]);
  await writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate");
  const writer = stream.writable.getWriter();
  await writer.write(data as Parameters<typeof writer.write>[0]);
  await writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

const BASE64_URL_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function bytesToBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    out += BASE64_URL_CHARS[b0 >> 2];
    out += BASE64_URL_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? BASE64_URL_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)] : "";
    out += i + 2 < bytes.length ? BASE64_URL_CHARS[b2 & 0x3f] : "";
  }
  return out;
}

function base64UrlToBytes(payload: string): Uint8Array {
  const clean = payload.replace(/[^A-Za-z0-9_-]/g, "");
  if (clean.length !== payload.length || clean.length % 4 === 1) {
    throw new Error("invalid base64url payload");
  }
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = BASE64_URL_CHARS.indexOf(char);
    if (value < 0) throw new Error("invalid base64url payload");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** Encode the check-in payload as a compressed base64url QR string (Option B). */
export async function encodeUsePayload(payload: UsePayload): Promise<string> {
  const json = JSON.stringify(payload);
  const data = new TextEncoder().encode(json);
  return bytesToBase64Url(await deflate(data));
}

/**
 * Decode a compressed check-in payload from its QR string. Throws on garbage —
 * the gate maps that to red "Not a valid ticket code." (FR-23).
 */
export async function decodeUsePayload(payload: string): Promise<UsePayload> {
  const data = await inflate(base64UrlToBytes(payload));
  const json = new TextDecoder().decode(data);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("invalid use payload");
  }
  if (!isUsePayload(parsed)) {
    throw new Error("invalid use payload");
  }
  return parsed;
}

function isUsePayload(value: unknown): value is UsePayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.use_id === "string" &&
    typeof record.template === "object" &&
    record.template !== null &&
    typeof record.owner_signed !== "undefined"
  );
}
