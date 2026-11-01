// Anonymous feedback: accept a short note, store it before trying to deliver it,
// and retry until it reaches the maintainers.
//
// There is no account and no wallet here. The only public surface is one POST,
// and the important property is write-ahead: the note is durable before any
// delivery can fail, so a Telegram outage, a missing bot, or a crash mid-flight
// never loses it. The browser is told `delivered: false` while an entry is only
// queued - it must never claim a message was sent when it was not.
//
// The queue is the Turso outbox (`feedback-turso.ts`) in every deployed
// environment. The pod's root filesystem is read-only and its only writable
// path is an emptyDir that a rollout wipes, so a file-backed queue is not an
// option here. The in-memory outbox exists for local development and tests.

import { randomUUID } from "node:crypto";
import { invalidError } from "./errors.js";

/** The public message cap. The browser mirrors it with `maxLength`. */
export const FEEDBACK_MAX_MESSAGE = 1500;

/** How long a claimed entry is hidden from other drainers. */
export const FEEDBACK_LEASE_MS = 120_000;

/** How often the background drain retries queued entries. */
export const FEEDBACK_DRAIN_INTERVAL_MS = 120_000;

export interface FeedbackEntry {
  id: string;
  message: string;
  /** ISO-8601, recorded when the entry was accepted. */
  receivedAt: string;
}

/** The durable queue contract. Only `submit` and the drain touch it. */
export interface FeedbackOutbox {
  enqueue(entry: FeedbackEntry): Promise<void>;
  pendingCount(): Promise<number>;
  claim(limit: number, leaseMs: number, now?: number): Promise<FeedbackEntry[]>;
  acknowledge(id: string): Promise<void>;
  release(id: string, retryAt?: number): Promise<void>;
}

/** What `POST /v1/feedback` accepts. Unknown fields are ignored. */
export function validateFeedback(input: unknown): { message: string } {
  const record =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const message = typeof record.message === "string" ? record.message.trim() : "";
  if (message.length === 0) {
    throw invalidError("message is required");
  }
  if (message.length > FEEDBACK_MAX_MESSAGE) {
    throw invalidError(`message must be at most ${FEEDBACK_MAX_MESSAGE} characters`);
  }
  return { message };
}

/** The Telegram payload. It is the only place the message leaves the server. */
export function formatFeedbackMessage(entry: FeedbackEntry): string {
  return ["New kticket feedback:", "", entry.message].join("\n");
}

export interface TelegramFeedbackOptions {
  botToken?: string;
  chatId?: string;
  fetchImpl?: typeof fetch;
  /** Overrides the Telegram URL; used by tests and local verification. */
  endpoint?: string;
}

/**
 * Telegram is the delivery channel, not the product. It is invisible to the
 * visitor, and the bot token/chat id never reach the browser.
 */
export class TelegramFeedback {
  readonly #botToken: string | undefined;
  readonly #chatId: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #endpoint: string | undefined;

  constructor(options: TelegramFeedbackOptions = {}) {
    this.#botToken = options.botToken;
    this.#chatId = options.chatId;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#endpoint = options.endpoint;
  }

  get enabled(): boolean {
    return Boolean(this.#botToken) && Boolean(this.#chatId);
  }

  async deliver(entry: FeedbackEntry): Promise<void> {
    if (!this.enabled) throw new Error("Telegram feedback is not configured");
    const endpoint =
      this.#endpoint ?? `https://api.telegram.org/bot${this.#botToken}/sendMessage`;
    const response = await this.#fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: this.#chatId,
        text: formatFeedbackMessage(entry),
        disable_web_page_preview: true,
      }),
    });
    if (response.ok) return;

    let detail = "";
    try {
      const parsed = (await response.json()) as { description?: unknown };
      if (typeof parsed.description === "string") detail = `: ${parsed.description.slice(0, 200)}`;
    } catch {
      // Non-JSON body; the HTTP status is enough.
    }
    throw new Error(`Telegram sendMessage failed with HTTP ${response.status}${detail}`);
  }
}

export interface FeedbackLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

const NOOP_LOGGER: FeedbackLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface FeedbackMetrics {
  recordFeedback(outcome: "delivered" | "queued" | "disabled"): void;
}

export interface FeedbackServiceOptions {
  outbox: FeedbackOutbox;
  deliverer: { enabled: boolean; deliver(entry: FeedbackEntry): Promise<void> };
  metrics?: FeedbackMetrics;
  logger?: FeedbackLogger;
  now?: () => Date;
}

/**
 * Write-ahead accept, best-effort deliver, background retry.
 *
 * A submission is always accepted once it is durable: a delivery failure is
 * reported as `delivered: false`, never as an error, because telling the
 * visitor to retry would duplicate the note they already left.
 */
export class FeedbackService {
  readonly #outbox: FeedbackOutbox;
  readonly #deliverer: { enabled: boolean; deliver(entry: FeedbackEntry): Promise<void> };
  readonly #metrics: FeedbackMetrics | undefined;
  readonly #logger: FeedbackLogger;
  readonly #now: () => Date;

  constructor(options: FeedbackServiceOptions) {
    this.#outbox = options.outbox;
    this.#deliverer = options.deliverer;
    this.#metrics = options.metrics;
    this.#logger = options.logger ?? NOOP_LOGGER;
    this.#now = options.now ?? (() => new Date());
  }

  get deliveryEnabled(): boolean {
    return this.#deliverer.enabled;
  }

  pendingCount(): Promise<number> {
    return this.#outbox.pendingCount();
  }

  async submit(input: unknown): Promise<{ accepted: true; delivered: boolean }> {
    const { message } = validateFeedback(input);
    const entry: FeedbackEntry = {
      id: randomUUID(),
      message,
      receivedAt: this.#now().toISOString(),
    };

    await this.#outbox.enqueue(entry);

    if (!this.#deliverer.enabled) {
      this.#metrics?.recordFeedback("disabled");
      this.#logger.warn(
        {
          reason: "TELEGRAM_FEEDBACK_BOT_TOKEN or TELEGRAM_FEEDBACK_CHAT_ID is not set",
          pending: await this.#pendingForLog(),
        },
        "feedback_delivery_disabled",
      );
      return { accepted: true, delivered: false };
    }

    try {
      await this.#deliverer.deliver(entry);
      await this.#outbox.acknowledge(entry.id);
      this.#metrics?.recordFeedback("delivered");
      this.#logger.info({ id: entry.id }, "feedback_delivered");
      return { accepted: true, delivered: true };
    } catch (error) {
      this.#metrics?.recordFeedback("queued");
      // The text itself is never logged; only the failure that kept it queued.
      this.#logger.error(
        {
          id: entry.id,
          error: error instanceof Error ? error.message : String(error),
          pending: await this.#pendingForLog(),
        },
        "feedback_delivery_failed",
      );
      return { accepted: true, delivered: false };
    }
  }

  /**
   * Diagnostics only: a failed count query must never turn an already-stored
   * note into an error response (which would invite a duplicate submission).
   */
  async #pendingForLog(): Promise<number | undefined> {
    try {
      return await this.#outbox.pendingCount();
    } catch {
      return undefined;
    }
  }

  /** Retry queued entries once. Entries that still fail stay queued. */
  async drainPending(): Promise<number> {
    const entries = await this.#outbox.claim(20, FEEDBACK_LEASE_MS);
    let delivered = 0;

    for (const entry of entries) {
      try {
        await this.#deliverer.deliver(entry);
        await this.#outbox.acknowledge(entry.id);
        this.#metrics?.recordFeedback("delivered");
        delivered += 1;
      } catch {
        await this.#outbox.release(entry.id);
      }
    }

    if (delivered > 0) {
      this.#logger.info({ count: delivered }, "feedback_delivered_from_queue");
    }
    return delivered;
  }
}

interface MemoryRow {
  entry: FeedbackEntry;
  leaseUntil: number;
}

/** A non-durable outbox for local development and tests only. */
export class MemoryFeedbackOutbox implements FeedbackOutbox {
  readonly #rows: MemoryRow[] = [];

  async enqueue(entry: FeedbackEntry): Promise<void> {
    this.#rows.push({ entry, leaseUntil: 0 });
  }

  async pendingCount(): Promise<number> {
    return this.#rows.length;
  }

  async claim(limit: number, leaseMs: number, now = Date.now()): Promise<FeedbackEntry[]> {
    const claimed: FeedbackEntry[] = [];
    for (const row of this.#rows) {
      if (claimed.length >= limit) break;
      if (row.leaseUntil > now) continue;
      row.leaseUntil = now + leaseMs;
      claimed.push(row.entry);
    }
    return claimed;
  }

  async acknowledge(id: string): Promise<void> {
    const index = this.#rows.findIndex((row) => row.entry.id === id);
    if (index !== -1) this.#rows.splice(index, 1);
  }

  async release(id: string, retryAt = Date.now() + FEEDBACK_LEASE_MS): Promise<void> {
    const row = this.#rows.find((candidate) => candidate.entry.id === id);
    if (row) row.leaseUntil = retryAt;
  }
}
