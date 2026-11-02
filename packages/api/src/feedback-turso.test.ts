// TursoFeedbackOutbox — real SQL through libsql's local file: mode. The
// write-ahead property and the lease are what the endpoint depends on.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import type { FeedbackEntry } from "./feedback.js";
import { TursoFeedbackOutbox } from "./feedback-turso.js";

const cleanup: { store: TursoFeedbackOutbox; dir: string }[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "kticket-feedback-"));
  return join(dir, "feedback.db");
}

function openStore(path = tempDbPath()): TursoFeedbackOutbox {
  const store = new TursoFeedbackOutbox(createClient({ url: `file:${path}` }));
  cleanup.push({ store, dir: dirname(path) });
  return store;
}

function entry(id: string, message: string, receivedAt: string): FeedbackEntry {
  return { id, message, receivedAt };
}

afterEach(async () => {
  while (cleanup.length > 0) {
    const { store, dir } = cleanup.pop()!;
    await store.close();
    // libsql releases the Windows file handle asynchronously after close().
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});

describe("TursoFeedbackOutbox", () => {
  it("stores an entry before it is delivered", async () => {
    const store = openStore();
    await store.init();

    await store.enqueue(entry("a", "first note", "2026-11-02T10:00:00.000Z"));

    expect(await store.pendingCount()).toBe(1);
  });

  it("claims in arrival order, leases the entry, and acknowledges it", async () => {
    const store = openStore();
    await store.init();
    await store.enqueue(entry("a", "first", "2026-11-02T10:00:00.000Z"));
    await store.enqueue(entry("b", "second", "2026-11-02T10:01:00.000Z"));

    const first = await store.claim(10, 60_000, 1_000);
    expect(first.map((row) => row.id)).toEqual(["a", "b"]);

    // A drain that overlaps the lease sees nothing new.
    expect(await store.claim(10, 60_000, 2_000)).toEqual([]);

    await store.acknowledge("a");
    await store.acknowledge("b");
    expect(await store.pendingCount()).toBe(0);
  });

  it("releases a failed entry so a later drain can retry it", async () => {
    const store = openStore();
    await store.init();
    await store.enqueue(entry("a", "retry me", "2026-11-02T10:00:00.000Z"));

    expect((await store.claim(10, 60_000, 1_000)).map((row) => row.id)).toEqual(["a"]);
    await store.release("a", 5_000);

    expect(await store.claim(10, 60_000, 4_999)).toEqual([]);
    expect((await store.claim(10, 60_000, 5_000)).map((row) => row.id)).toEqual(["a"]);
  });

  it("persists queued entries across a reconnect", async () => {
    const path = tempDbPath();
    const first = openStore(path);
    await first.init();
    await first.enqueue(entry("a", "survives a rollout", "2026-11-02T10:00:00.000Z"));

    const second = openStore(path);
    await second.init();
    expect(await second.pendingCount()).toBe(1);
    expect((await second.claim(10, 60_000, 1_000))[0]?.message).toBe("survives a rollout");
  });
});
