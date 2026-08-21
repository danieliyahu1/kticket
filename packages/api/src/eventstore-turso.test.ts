// TursoEventStore — exercised through libsql's local file: mode (real SQL,
// no network). Covers the same semantics EventStore guarantees: upsert by
// covenant id re-points the deploy txid, reads are case-normalized, and the
// registry survives a reconnect (the property events.json could not give us).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { TursoEventStore } from "./eventstore-turso";

const COVENANT = "cc".repeat(32);
const DEPLOY = "dd".repeat(32);
const ORGANIZER = "kaspatest:qtest";

const cleanup: { store: TursoEventStore; dir: string }[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "kticket-turso-"));
  return join(dir, "registry.db");
}

function openStore(path = tempDbPath()): TursoEventStore {
  const store = new TursoEventStore(createClient({ url: `file:${path}` }));
  cleanup.push({ store, dir: dirname(path) });
  return store;
}

afterEach(async () => {
  while (cleanup.length > 0) {
    const { store, dir } = cleanup.pop()!;
    await store.close();
    // libsql releases the Windows file handle asynchronously after close();
    // retry briefly before giving up (a leaked temp dir is harmless).
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }
});

describe("TursoEventStore", () => {
  it("starts empty after init on a fresh database", async () => {
    const store = openStore();
    await store.init();
    expect(store.list()).toHaveLength(0);
    expect(store.byCovenantId(COVENANT)).toBeUndefined();
  });

  it("registers an event and serves every lookup", async () => {
    const store = openStore();
    await store.init();
    await store.register({
      deployTxId: DEPLOY,
      covenantId: COVENANT,
      organizerAddress: ORGANIZER,
    });

    expect(store.byCovenantId(COVENANT)?.deployTxId).toBe(DEPLOY);
    expect(store.byDeployTxId(DEPLOY)?.covenantId).toBe(COVENANT);
    expect(store.list()).toHaveLength(1);
    expect(store.list(ORGANIZER)).toHaveLength(1);
    expect(store.list("kaspatest:nobody")).toHaveLength(0);
  });

  it("normalizes hex case on write so mixed-case lookups hit", async () => {
    const store = openStore();
    await store.init();
    await store.register({
      deployTxId: DEPLOY.toUpperCase(),
      covenantId: COVENANT.toUpperCase(),
      organizerAddress: ORGANIZER,
    });

    expect(store.byCovenantId(COVENANT.toUpperCase())?.deployTxId).toBe(DEPLOY);
    expect(store.byDeployTxId(DEPLOY.toUpperCase())?.covenantId).toBe(COVENANT);
  });

  it("re-registering a covenant re-points it and drops the old deploy txid", async () => {
    const redeploy = "ee".repeat(32);
    const store = openStore();
    await store.init();
    await store.register({
      deployTxId: DEPLOY,
      covenantId: COVENANT,
      organizerAddress: ORGANIZER,
    });
    await store.register({
      deployTxId: redeploy,
      covenantId: COVENANT,
      organizerAddress: ORGANIZER,
    });

    expect(store.list()).toHaveLength(1);
    expect(store.byCovenantId(COVENANT)?.deployTxId).toBe(redeploy);
    expect(store.byDeployTxId(redeploy)?.covenantId).toBe(COVENANT);
    expect(store.byDeployTxId(DEPLOY)).toBeUndefined();
  });

  it("persists across a reconnect: a fresh store init() sees prior rows", async () => {
    const path = tempDbPath();
    const first = openStore(path);
    await first.init();
    await first.register({
      deployTxId: DEPLOY,
      covenantId: COVENANT,
      organizerAddress: ORGANIZER,
    });

    const second = openStore(path);
    await second.init();
    expect(second.list()).toHaveLength(1);
    expect(second.byCovenantId(COVENANT)?.deployTxId).toBe(DEPLOY);
    expect(second.byDeployTxId(DEPLOY)?.organizerAddress).toBe(ORGANIZER);
  });

  it("preserves registration order in list()", async () => {
    const store = openStore();
    await store.init();
    await store.register({ deployTxId: "aa".repeat(32), covenantId: "11".repeat(32), organizerAddress: ORGANIZER });
    await store.register({ deployTxId: "bb".repeat(32), covenantId: "22".repeat(32), organizerAddress: ORGANIZER });
    await store.register({ deployTxId: "cc".repeat(32), covenantId: "33".repeat(32), organizerAddress: ORGANIZER });

    expect(store.list().map((e) => e.covenantId.slice(0, 2))).toEqual(["11", "22", "33"]);
  });
});
