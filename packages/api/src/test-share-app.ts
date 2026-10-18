// Shared harness for the shareable-page tests (KTK-159/163/164).
//
// External boundaries stay mocked: the chain is a seeded FakeKaspa, the compiler
// returns committed artifacts, and the SPA shell is a fixture. The app, its
// routes, and the verification policy are the real code under test.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { p2pkAddress } from "@kticket/kit";
import { hexToBytes } from "@noble/hashes/utils.js";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { EventStore } from "./eventstore.js";
import { ListingStoreFile } from "./listings.js";
import {
  FakeKaspa,
  G_ID,
  NETWORK,
  ORG_PKH_HEX,
  TEST_COVENANT_ID,
  seedBaseChain,
} from "./test-chain.js";
import { PREVIEW_ORIGIN, SPA_SHELL_HTML } from "./test-share-fixtures.js";
import { VerifiedEventCache } from "./verified-cache.js";

export interface ShareAppOptions {
  origin?: string;
  /** `null` builds an API-only app; a string replaces the default shell. */
  spaShell?: string | null;
  verified?: VerifiedEventCache;
  /** Add registry rows after the base verified event is registered. */
  seedRegistry?: (events: EventStore) => Promise<void> | void;
}

export interface ShareApp {
  app: FastifyInstance;
  kaspa: FakeKaspa;
  events: EventStore;
  origin: string;
  close: () => Promise<void>;
}

export async function buildShareApp(options: ShareAppOptions = {}): Promise<ShareApp> {
  const origin = options.origin ?? PREVIEW_ORIGIN;
  const kaspa = new FakeKaspa();
  seedBaseChain(kaspa);

  const events = new EventStore();
  await events.register({
    covenantId: TEST_COVENANT_ID,
    deployTxId: G_ID,
    organizerAddress: p2pkAddress(hexToBytes(ORG_PKH_HEX), NETWORK),
  });
  await options.seedRegistry?.(events);

  const spaRoot =
    options.spaShell === null
      ? undefined
      : spaDirectory(options.spaShell ?? SPA_SHELL_HTML);

  const app = await buildApp(
    loadConfig({
      KASPANET: NETWORK,
      AUTH_SECRET: "test-secret-for-kticket-api",
      PUBLIC_ORIGIN: origin,
    }),
    {
      kaspa,
      events,
      listings: new ListingStoreFile(),
      network: NETWORK,
      networkId: "testnet-10",
      verified: options.verified ?? new VerifiedEventCache(),
    },
    spaRoot === undefined ? {} : { serveStatic: spaRoot },
  );

  return {
    app,
    kaspa,
    events,
    origin,
    close: async () => {
      await app.close();
      if (spaRoot !== undefined) rmSync(spaRoot, { recursive: true, force: true });
    },
  };
}

/** Build an app, run the test, and always close it and clean up the fixture. */
export async function withShareApp(
  run: (harness: ShareApp) => Promise<void>,
  options: ShareAppOptions = {},
): Promise<void> {
  const harness = await buildShareApp(options);
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

function spaDirectory(shellHtml: string): string {
  const directory = mkdtempSync(join(tmpdir(), "kticket-share-"));
  writeFileSync(join(directory, "index.html"), shellHtml);
  return directory;
}
