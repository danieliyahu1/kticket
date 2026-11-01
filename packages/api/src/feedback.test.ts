// Anonymous feedback: validation, write-ahead ordering, and the delivery
// semantics the browser relies on (`delivered: false` means queued, not sent).

import { describe, expect, it, vi } from "vitest";
import {
  FEEDBACK_MAX_MESSAGE,
  FeedbackService,
  MemoryFeedbackOutbox,
  TelegramFeedback,
  formatFeedbackMessage,
  validateFeedback,
  type FeedbackEntry,
  type FeedbackLogger,
} from "./feedback.js";

const ENTRY: FeedbackEntry = {
  id: "00000000-0000-4000-8000-000000000001",
  message: "The check-in page was confusing.",
  receivedAt: "2026-11-02T10:00:00.000Z",
};

function silentLogger(): FeedbackLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("validateFeedback", () => {
  it("trims the message", () => {
    expect(validateFeedback({ message: "  hello  " })).toEqual({ message: "hello" });
  });

  it("rejects a missing or whitespace-only message", () => {
    expect(() => validateFeedback({})).toThrow("message is required");
    expect(() => validateFeedback({ message: "   " })).toThrow("message is required");
    expect(() => validateFeedback(null)).toThrow("message is required");
  });

  it("caps the message length", () => {
    expect(() => validateFeedback({ message: "x".repeat(FEEDBACK_MAX_MESSAGE + 1) })).toThrow(
      `message must be at most ${FEEDBACK_MAX_MESSAGE} characters`,
    );
    expect(validateFeedback({ message: "x".repeat(FEEDBACK_MAX_MESSAGE) }).message).toHaveLength(
      FEEDBACK_MAX_MESSAGE,
    );
  });
});

describe("FeedbackService", () => {
  it("stores before delivering, then acknowledges a delivered note", async () => {
    const outbox = new MemoryFeedbackOutbox();
    const order: string[] = [];
    const enqueue = outbox.enqueue.bind(outbox);
    outbox.enqueue = async (entry) => {
      order.push("enqueue");
      await enqueue(entry);
    };
    const service = new FeedbackService({
      outbox,
      deliverer: {
        enabled: true,
        deliver: async () => {
          order.push("deliver");
        },
      },
      logger: silentLogger(),
    });

    const result = await service.submit({ message: "Nice app" });

    expect(result).toEqual({ accepted: true, delivered: true });
    expect(order).toEqual(["enqueue", "deliver"]);
    expect(await outbox.pendingCount()).toBe(0);
  });

  it("keeps a note queued when delivery fails, and never logs its text", async () => {
    const outbox = new MemoryFeedbackOutbox();
    const logger = silentLogger();
    const service = new FeedbackService({
      outbox,
      deliverer: {
        enabled: true,
        deliver: async () => {
          throw new Error("Telegram is down");
        },
      },
      logger,
    });

    const result = await service.submit({ message: "private note" });

    expect(result).toEqual({ accepted: true, delivered: false });
    expect(await outbox.pendingCount()).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.not.objectContaining({ message: "private note" }),
      "feedback_delivery_failed",
    );
    const fields = vi.mocked(logger.error).mock.calls[0]![0];
    expect(JSON.stringify(fields)).not.toContain("private note");
  });

  it("accepts and queues while delivery is not configured", async () => {
    const outbox = new MemoryFeedbackOutbox();
    const logger = silentLogger();
    const service = new FeedbackService({
      outbox,
      deliverer: { enabled: false, deliver: vi.fn() },
      logger,
    });

    const result = await service.submit({ message: "No bot yet" });

    expect(result).toEqual({ accepted: true, delivered: false });
    expect(await outbox.pendingCount()).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ pending: 1 }),
      "feedback_delivery_disabled",
    );
  });

  it("drains queued entries and clears them once delivered", async () => {
    const outbox = new MemoryFeedbackOutbox();
    await outbox.enqueue(ENTRY);
    const delivered: FeedbackEntry[] = [];
    const service = new FeedbackService({
      outbox,
      deliverer: {
        enabled: true,
        deliver: async (entry) => {
          delivered.push(entry);
        },
      },
      logger: silentLogger(),
    });

    expect(await service.drainPending()).toBe(1);
    expect(delivered).toEqual([ENTRY]);
    expect(await outbox.pendingCount()).toBe(0);
  });
});

describe("TelegramFeedback", () => {
  it("posts the message to the configured chat", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const deliverer = new TelegramFeedback({
      botToken: "token",
      chatId: "42",
      fetchImpl,
    });

    await deliverer.deliver(ENTRY);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.telegram.org/bottoken/sendMessage",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(vi.mocked(fetchImpl).mock.calls[0]![1]!.body as string) as {
      chat_id: string;
      text: string;
    };
    expect(body.chat_id).toBe("42");
    expect(body.text).toBe(formatFeedbackMessage(ENTRY));
  });

  it("reports a Telegram failure so the entry stays queued", async () => {
    const deliverer = new TelegramFeedback({
      botToken: "token",
      chatId: "42",
      fetchImpl: vi.fn(async () =>
        new Response(JSON.stringify({ description: "chat not found" }), { status: 400 }),
      ),
    });

    await expect(deliverer.deliver(ENTRY)).rejects.toThrow(
      "Telegram sendMessage failed with HTTP 400: chat not found",
    );
  });

  it("is disabled unless both credentials are set", () => {
    expect(new TelegramFeedback({ botToken: "token" }).enabled).toBe(false);
    expect(new TelegramFeedback({ chatId: "42" }).enabled).toBe(false);
    expect(new TelegramFeedback({ botToken: "token", chatId: "42" }).enabled).toBe(true);
  });
});
