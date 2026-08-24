// One-time, short-lived sign-in nonces (daftari `auth-store`, but in-memory).
//
// Nonces are disposable by design: a nonce only exists to be consumed once
// within seconds, and losing one is harmless — the client's session call just
// fails and the sign-in flow re-issues a fresh challenge. There is no durable
// or authoritative data at risk, so no persistence (and no Turso schema / I/O)
// is warranted. The map is swept on every create so it never grows with
// abandoned challenges.
//
// NOTE: an in-memory store assumes a single API instance. If kticket ever runs
// multiple instances behind a load balancer (challenge on A, session on B),
// swap this for the durable Turso-backed store.

import { randomBytes } from "node:crypto";

export const DEFAULT_CHALLENGE_TTL_MS = 5 * 60_000;

export interface ChallengeRecord {
  nonce: string;
  address: string;
  expiresAt: number;
}

export interface AuthStore {
  create(address: string): Promise<ChallengeRecord>;
  /** Redeems a nonce exactly once; returns the record + deletes it, else null. */
  consume(nonce: string, address: string): Promise<ChallengeRecord | null>;
  close(): void;
}

export class InMemoryAuthStore implements AuthStore {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly challenges = new Map<string, ChallengeRecord>();

  constructor(options: { now?: () => number; ttlMs?: number } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? DEFAULT_CHALLENGE_TTL_MS;
  }

  async create(address: string): Promise<ChallengeRecord> {
    this.prune();
    const nonce = randomBytes(16).toString("hex");
    const record: ChallengeRecord = {
      nonce,
      address,
      expiresAt: this.now() + this.ttlMs,
    };
    this.challenges.set(nonce, record);
    return record;
  }

  async consume(nonce: string, address: string): Promise<ChallengeRecord | null> {
    const record = this.challenges.get(nonce);
    if (record === undefined || record.address !== address) return null;
    this.challenges.delete(nonce);
    if (record.expiresAt <= this.now()) return null;
    return record;
  }

  private prune(): void {
    const now = this.now();
    for (const [nonce, record] of this.challenges) {
      if (record.expiresAt <= now) this.challenges.delete(nonce);
    }
  }

  close(): void {
    this.challenges.clear();
  }
}
