import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { EventStore, REGISTRY_VERSION } from "./eventstore";

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixturePath(name: string): string {
  return resolve(fixturesDir, name);
}

function tempIdsPath(): string {
  return join(mkdtempSync(join(tmpdir(), "kticket-eventstore-")), "events.json");
}

function cleanupTemp(idsPath: string): void {
  rmSync(dirname(idsPath), { recursive: true, force: true });
}

describe("EventStore", () => {
  it("loads the fixture registry from disk", () => {
    const store = new EventStore(fixturePath("example-events.json"));

    const events = store.list();
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      deployTxId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      covenantId: "234f446748ff76774c8ca9c99531a34111066f902daa95663a399f4a2893a3ba",
      organizerAddress: "kaspatest:qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszapw00vun",
    });
  });

  it("indexes by covenant id and deploy tx id, normalizing hex case", () => {
    const store = new EventStore(fixturePath("example-events.json"));

    const byCovenant = store.byCovenantId(
      "234f446748FF76774C8CA9C99531A34111066F902DAA95663A399F4A2893A3BA",
    );
    expect(byCovenant?.deployTxId).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );

    const byDeploy = store.byDeployTxId(
      "1111111111111111111111111111111111111111111111111111111111111111",
    );
    expect(byDeploy?.organizerAddress).toContain("kaspatest:");
  });

  it("filters the registry by organizer address", () => {
    const store = new EventStore(fixturePath("example-events.json"));
    const organizer = "kaspatest:qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszapw00vun";
    const byOrganizer = store.list(organizer);
    expect(byOrganizer).toHaveLength(1);
    expect(byOrganizer[0]?.covenantId).toBe(
      "234f446748ff76774c8ca9c99531a34111066f902daa95663a399f4a2893a3ba",
    );
    expect(store.list("kaspatest:nobody")).toHaveLength(0);
  });

  it("ignores a missing registry file and starts empty", () => {
    const store = new EventStore(fixturePath("does-not-exist.json"));
    expect(store.list()).toHaveLength(0);
  });

  it("in-memory stores never touch the filesystem", async () => {
    const store = new EventStore();
    await store.register({
      deployTxId: "bb".repeat(32),
      covenantId: "cc".repeat(32),
      organizerAddress: "kaspatest:qtest",
    });
    expect(store.list()).toHaveLength(1);
  });

  it("register() persists a new event to disk in the registry format", async () => {
    const idsPath = tempIdsPath();
    try {
      const store = new EventStore(idsPath);
      await store.register({
        deployTxId: "dd".repeat(32),
        covenantId: "ee".repeat(32),
        organizerAddress: "kaspatest:qpersist",
      });

      const reloaded = new EventStore(idsPath);
      expect(reloaded.byCovenantId("ee".repeat(32))?.deployTxId).toBe("dd".repeat(32));

      const raw = JSON.parse(readFileSync(idsPath, "utf-8")) as {
        version: number;
        events: Record<string, string>[];
      };
      expect(raw.version).toBe(REGISTRY_VERSION);
      expect(raw.events).toEqual([
        {
          deploy_txid: "dd".repeat(32),
          covenant_id: "ee".repeat(32),
          organizer_address: "kaspatest:qpersist",
        },
      ]);
    } finally {
      cleanupTemp(idsPath);
    }
  });

  it("tolerates a corrupt registry file and starts empty", () => {
    const idsPath = tempIdsPath();
    try {
      writeFileSync(idsPath, "{ not json", "utf-8");
      const store = new EventStore(idsPath);
      expect(store.list()).toHaveLength(0);
    } finally {
      cleanupTemp(idsPath);
    }
  });

  it("wipes a legacy (v1 bare-array) registry — the contract changed under it (KTK-151)", async () => {
    const idsPath = tempIdsPath();
    try {
      writeFileSync(
        idsPath,
        JSON.stringify([
          {
            deploy_txid: "aa".repeat(32),
            covenant_id: "bb".repeat(32),
            organizer_address: "kaspatest:qlegacy",
          },
        ]),
        "utf-8",
      );
      const store = new EventStore(idsPath);
      expect(store.list()).toHaveLength(0);

      // The wipe is persisted on the next save so the stale rows never return.
      await store.register({
        deployTxId: "cc".repeat(32),
        covenantId: "dd".repeat(32),
        organizerAddress: "kaspatest:qnew",
      });
      const reloaded = new EventStore(idsPath);
      expect(reloaded.list()).toHaveLength(1);
    } finally {
      cleanupTemp(idsPath);
    }
  });
});
