// The durable feedback outbox (Turso / libsql).
//
// This is the write-ahead queue behind `POST /v1/feedback`: an entry is
// committed here before delivery is attempted, so a Telegram outage or a pod
// restart cannot lose it. `claim` leases entries atomically, which keeps two
// replicas (or a drain overlapping a submit) from delivering the same note
// twice.

import type { Client } from "@libsql/client";
import { FEEDBACK_LEASE_MS, type FeedbackEntry, type FeedbackOutbox } from "./feedback.js";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS feedback_outbox (
    id          TEXT PRIMARY KEY,
    message     TEXT NOT NULL,
    received_at TEXT NOT NULL,
    lease_until INTEGER NOT NULL DEFAULT 0,
    attempts    INTEGER NOT NULL DEFAULT 0
  )
`;

const INDEX = `
  CREATE INDEX IF NOT EXISTS feedback_outbox_received_at
    ON feedback_outbox (received_at)
`;

export class TursoFeedbackOutbox implements FeedbackOutbox {
  readonly #client: Client;

  constructor(client: Client) {
    this.#client = client;
  }

  async init(): Promise<void> {
    await this.#client.execute(SCHEMA);
    await this.#client.execute(INDEX);
  }

  async close(): Promise<void> {
    this.#client.close();
  }

  async enqueue(entry: FeedbackEntry): Promise<void> {
    await this.#client.execute({
      sql: "INSERT INTO feedback_outbox (id, message, received_at) VALUES (?, ?, ?)",
      args: [entry.id, entry.message, entry.receivedAt],
    });
  }

  async pendingCount(): Promise<number> {
    const result = await this.#client.execute({
      sql: "SELECT COUNT(*) AS count FROM feedback_outbox",
      args: [],
    });
    return Number(result.rows[0]?.count ?? 0);
  }

  async claim(limit: number, leaseMs: number, now = Date.now()): Promise<FeedbackEntry[]> {
    const result = await this.#client.execute({
      sql: `UPDATE feedback_outbox
              SET lease_until = ?, attempts = attempts + 1
            WHERE id IN (
              SELECT id FROM feedback_outbox
               WHERE lease_until <= ?
               ORDER BY received_at, rowid
               LIMIT ?
            )
            RETURNING id, message, received_at`,
      args: [now + leaseMs, now, limit],
    });

    return result.rows.map((row) => ({
      id: String(row.id),
      message: String(row.message),
      receivedAt: String(row.received_at),
    }));
  }

  async acknowledge(id: string): Promise<void> {
    await this.#client.execute({
      sql: "DELETE FROM feedback_outbox WHERE id = ?",
      args: [id],
    });
  }

  async release(id: string, retryAt = Date.now() + FEEDBACK_LEASE_MS): Promise<void> {
    await this.#client.execute({
      sql: "UPDATE feedback_outbox SET lease_until = ? WHERE id = ?",
      args: [retryAt, id],
    });
  }
}
