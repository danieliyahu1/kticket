// Whole-issue integration test for KTK-152 (sub-issue KTK-158).
//
// A fresh client is simulated using only the published surface: it fetches
// /llms.txt and the OpenAPI document, resolves the endpoint URLs from the
// contract, authenticates with a wallet signature, lists events, and reaches a
// prepared buy. The chain and broadcast are the in-memory fakes from
// test-chain.ts; only kticket's own code is exercised.

import { describe, expect, it, vi } from "vitest";
import {
  AGENT_GUIDE_PATH,
  API_DOCS_PATH,
  LLMS_TXT_PATH,
  OPENAPI_PATH,
} from "./docs-paths.js";
import type { JsonObject } from "./json.js";
import {
  EVENT_PRICE,
  FakeKaspa,
  NETWORK,
  OWNER_ADDRESS,
  OWNER_PUBKEY_HEX,
  TEST_COVENANT_ID,
  buildAppWith,
  seedBaseChain,
} from "./test-chain.js";
import { operationPath } from "./test-openapi.js";

vi.mock("./wrpc-client.js", () => ({
  submitTransactionOverWrpc: vi.fn(),
}));

vi.mock("./compiler.js", async () => {
  const { createCompilerMock } = await import("./test-artifacts.js");
  return createCompilerMock();
});

interface KaspaWasm {
  PrivateKey: new (key: string) => {
    toAddress: (network: string) => { toString(): string };
  };
  signMessage: (input: { message: string; privateKey: unknown }) => string;
}

const PRIVATE_KEY_HEX = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";

describe("headless client uses the published contract alone (KTK-152 whole-issue)", () => {
  it("docs → session → events → prepared buy", async () => {
    const kaspa = new FakeKaspa();
    seedBaseChain(kaspa);
    const app = await buildAppWith(kaspa);

    try {
      // --- 1. Discover the surface from the served documents ---------------
      const llms = await app.inject({ method: "GET", url: LLMS_TXT_PATH });
      expect(llms.statusCode).toBe(200);
      expect(llms.body).toContain(OPENAPI_PATH);
      expect(llms.body).toContain(AGENT_GUIDE_PATH);
      expect(llms.body).toContain(API_DOCS_PATH);

      const contractResponse = await app.inject({ method: "GET", url: OPENAPI_PATH });
      expect(contractResponse.statusCode).toBe(200);
      const contract = contractResponse.json() as JsonObject;
      expect(contract.openapi).toBe("3.1.0");

      const docsPage = await app.inject({ method: "GET", url: API_DOCS_PATH });
      expect(docsPage.statusCode).toBe(200);
      expect(docsPage.body).toContain("buy/prepare");

      const guide = await app.inject({ method: "GET", url: AGENT_GUIDE_PATH });
      expect(guide.statusCode).toBe(200);
      // The guide explains the exact shape the client is about to use.
      expect(guide.body).toContain("sign_inputs");
      expect(guide.body).toContain("Authorization: Bearer <token>");

      // The network is reported by the server, never guessed.
      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.json()).toEqual({ status: "ok", network: NETWORK });

      // --- 2. Authenticate: challenge → sign → session ---------------------
      const wasm = (await import("../vendor/kaspa-wasm/kaspa.js")) as unknown as KaspaWasm;
      const privateKey = new wasm.PrivateKey(PRIVATE_KEY_HEX);
      const address = privateKey.toAddress("testnet-10").toString();

      const challenge = await app.inject({
        method: "POST",
        url: operationPath(contract, "authChallenge"),
        payload: { address },
      });
      expect(challenge.statusCode).toBe(200);
      const { message } = challenge.json() as { message: string };
      expect(message).toContain("Chain ID: testnet-10");

      const signature = wasm.signMessage({ message, privateKey });
      const session = await app.inject({
        method: "POST",
        url: operationPath(contract, "authSession"),
        payload: { message, signature },
      });
      expect(session.statusCode).toBe(200);
      const { token } = session.json() as { token: string };
      expect(token).toBeTruthy();

      // The token is accepted by the user-specific read.
      const tickets = await app.inject({
        method: "GET",
        url: operationPath(contract, "listMyTickets"),
        headers: { authorization: `Bearer ${token}` },
      });
      expect(tickets.statusCode).toBe(200);
      expect(Array.isArray(tickets.json())).toBe(true);

      // --- 3. List events --------------------------------------------------
      const events = await app.inject({
        method: "GET",
        url: operationPath(contract, "listEvents"),
      });
      expect(events.statusCode).toBe(200);
      const listed = events.json() as { covenant_id: string; price: number }[];
      expect(listed.length).toBeGreaterThan(0);
      const covenantId = listed[0]!.covenant_id;
      expect(covenantId).toBe(TEST_COVENANT_ID);

      // --- 4. Reach a prepared buy -----------------------------------------
      const prepared = await app.inject({
        method: "POST",
        url: operationPath(contract, "prepareBuy").replace("{covenant_id}", covenantId),
        payload: { publicKey: OWNER_PUBKEY_HEX, address: OWNER_ADDRESS },
      });
      expect(prepared.statusCode).toBe(200);

      const buy = prepared.json() as {
        buy_id: string;
        signing_template: string;
        template: { inputs: unknown[]; outputs: unknown[] };
        sign_inputs: { index: number }[];
        price: number;
      };
      expect(buy.buy_id).toBeTruthy();
      expect(typeof buy.signing_template).toBe("string");
      expect(buy.template.inputs.length).toBeGreaterThan(0);
      expect(buy.template.outputs.length).toBeGreaterThan(0);
      expect(buy.sign_inputs.length).toBeGreaterThan(0);
      for (const { index } of buy.sign_inputs) {
        expect(index).toBeGreaterThan(0);
        expect(index).toBeLessThan(buy.template.inputs.length);
      }
      expect(buy.price).toBe(EVENT_PRICE);

      // --- 5. A documented error, in the documented envelope ---------------
      const missing = await app.inject({
        method: "POST",
        url: operationPath(contract, "prepareBuy").replace("{covenant_id}", "cd".repeat(32)),
        payload: { publicKey: OWNER_PUBKEY_HEX, address: OWNER_ADDRESS },
      });
      expect(missing.statusCode).toBe(400);
      const envelope = missing.json() as {
        error: { type: string; message: string; retryable: boolean };
      };
      expect(envelope.error.type).toBe("invalid");
      expect(typeof envelope.error.message).toBe("string");
      expect(envelope.error.retryable).toBe(false);
    } finally {
      await app.close();
    }
  });
});
