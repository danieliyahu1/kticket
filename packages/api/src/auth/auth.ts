// SIWS-style wallet authentication (mirrors daftari `backend/auth.ts`):
//
//   POST /v1/auth/challenge  {address}  -> { nonce, message }
//   POST /v1/auth/session    {message, signature} -> { token, expires_in_seconds }
//
// The client signs the structured message with its Kaspa wallet; the backend
// strictly re-parses the message, consumes the one-time nonce, verifies the
// Schnorr signature recovers the claimed address, and issues a short-lived JWT
// whose subject is the authenticated address. Protected routes present the
// bearer token; `verifyToken` recovers the address.

import { SignJWT, jwtVerify } from "jose";
import { isRecord, str } from "../validate.js";
import { unauthorizedError } from "../errors.js";
import type { AuthStore } from "./auth-store.js";
import { verifySignature } from "./kaspa-signature.js";

export const SESSION_TTL_MS = 15 * 60_000;

const MESSAGE_VERSION = "1";
const STATEMENT = "kticket";

export interface AuthConfig {
  origin: string;
  secret: Uint8Array;
  networkId: string;
  sessionTtlMs?: number;
}

export interface AuthUser {
  address: string;
}

export function buildSignInMessage(input: {
  address: string;
  origin: string;
  networkId: string;
  nonce: string;
  issuedAt: string;
}): string {
  return [
    STATEMENT,
    "",
    "kticket wants you to sign in with your Kaspa account:",
    input.address,
    "",
    `URI: ${input.origin}`,
    `Version: ${MESSAGE_VERSION}`,
    `Chain ID: ${input.networkId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
  ].join("\n");
}

interface ParsedMessage {
  address: string;
  origin: string;
  networkId: string;
  nonce: string;
}

// Strictly parses a sign-in message back into its fields so the backend only
// trusts values it can reconstruct, never anything the client asserts alone.
export function parseSignInMessage(message: string): ParsedMessage | null {
  const lines = message.split("\n");
  if (lines.length !== 10) return null;
  if (lines[0] !== STATEMENT) return null;
  if (lines[1] !== "") return null;
  if (!lines[2].startsWith("kticket wants you to sign in with your Kaspa account:")) {
    return null;
  }
  const address = lines[3].trim();
  if (lines[4] !== "") return null;
  const uri = lines[5];
  if (!uri.startsWith("URI: ")) return null;
  const origin = uri.slice("URI: ".length).trim();
  if (lines[6] !== `Version: ${MESSAGE_VERSION}`) return null;
  if (!lines[7].startsWith("Chain ID: ")) return null;
  const networkId = lines[7].slice("Chain ID: ".length).trim();
  const nonceLine = lines[8];
  if (!nonceLine.startsWith("Nonce: ")) return null;
  const nonce = nonceLine.slice("Nonce: ".length).trim();
  if (!lines[9].startsWith("Issued At: ")) return null;
  return { address, origin, networkId, nonce };
}

export interface CreateChallengeResult {
  nonce: string;
  message: string;
}

export async function handleCreateChallenge(
  store: AuthStore,
  input: unknown,
  config: AuthConfig,
): Promise<CreateChallengeResult> {
  if (!isRecord(input)) throw unauthorizedError("request body must be an object");
  const address = str(input.address, "address");
  const record = await store.create(address);
  return {
    nonce: record.nonce,
    message: buildSignInMessage({
      address,
      origin: config.origin,
      networkId: config.networkId,
      nonce: record.nonce,
      issuedAt: new Date().toISOString(),
    }),
  };
}

export interface CreateSessionResult {
  token: string;
  expires_in_seconds: number;
}

export async function handleCreateSession(
  store: AuthStore,
  input: unknown,
  config: AuthConfig,
): Promise<CreateSessionResult> {
  if (!isRecord(input)) throw unauthorizedError("request body must be an object");
  const message = str(input.message, "message");
  const signature = str(input.signature, "signature");

  const parsed = parseSignInMessage(message);
  if (parsed === null) {
    throw unauthorizedError("The signed message is not valid");
  }
  if (parsed.origin !== config.origin) {
    throw unauthorizedError("The signed message is not for this app");
  }
  if (parsed.networkId !== config.networkId) {
    throw unauthorizedError("The signed message is not for this network");
  }
  const record = await store.consume(parsed.nonce, parsed.address);
  if (record === null) {
    throw unauthorizedError("This sign-in attempt is no longer valid. Try again.");
  }
  const valid = await verifySignature({ address: parsed.address, message, signature });
  if (!valid) {
    throw unauthorizedError("The signature does not match this wallet");
  }

  const ttlMs = config.sessionTtlMs ?? SESSION_TTL_MS;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(parsed.address)
    .setIssuedAt()
    .setExpirationTime(`${Math.floor(ttlMs / 1000)}s`)
    .sign(config.secret);

  return { token, expires_in_seconds: Math.floor(ttlMs / 1000) };
}

// Verifies a bearer token and returns the authenticated address, or null.
export async function verifyToken(
  bearer: string | undefined,
  secret: Uint8Array,
): Promise<AuthUser | null> {
  if (typeof bearer !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(bearer.trim());
  if (match === null) return null;
  try {
    const { payload } = await jwtVerify(match[1], secret, { algorithms: ["HS256"] });
    const address = payload.sub;
    if (typeof address !== "string" || address === "") return null;
    return { address };
  } catch {
    return null;
  }
}
