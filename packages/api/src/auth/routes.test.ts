import { describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { B0_ID, buildAppWith, buyTx, FakeKaspa, NETWORK, ORG_PKH_HEX, OWNER_ADDRESS, seedBaseChain, TEST_COVENANT_ID } from "../test-chain.js";
import { addressFromScriptHash, p2pkAddress } from "@kticket/kit";
import { hexToBytes } from "@noble/hashes/utils.js";
import { HTTP_OK, HTTP_UNAUTHORIZED } from "../http-status.js";

vi.mock("../wrpc-client.js", () => ({
  submitTransactionOverWrpc: vi.fn(),
}));

vi.mock("../compiler.js", async () => {
  const { createCompilerMock } = await import("../test-artifacts.js");
  return createCompilerMock();
});

const SECRET = new TextEncoder().encode("test-secret-for-kticket-api");

async function bearerFor(address: string): Promise<string> {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(address)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(SECRET);
  return `Bearer ${token}`;
}

const ORG_ADDRESS = p2pkAddress(hexToBytes(ORG_PKH_HEX), NETWORK);

describe("auth: user-specific reads (fail-closed)", () => {
  it("GET /v1/tickets without a token -> 401", async () => {
    const kaspa = new FakeKaspa();
    seedBaseChain(kaspa);
    const app = await buildAppWith(kaspa);
    const res = await app.inject({ method: "GET", url: "/v1/tickets" });
    expect(res.statusCode).toBe(HTTP_UNAUTHORIZED);
    expect(res.json().error.type).toBe("unauthorized");
    await app.close();
  });

  it("GET /v1/tickets with a valid owner token -> that owner's tickets", async () => {
    const kaspa = new FakeKaspa();
    seedBaseChain(kaspa);
    // Mint the owner's ticket: the covenant output's address (not the owner's
    // P2PK funding address) is where the ticket UTXO lives.
    const buy = buyTx();
    const ticketAddress = addressFromScriptHash(buy.outputs?.[0]?.script_public_key as string, NETWORK);
    kaspa.utxoMap.set(ticketAddress, [
      {
        address: ticketAddress,
        outpoint: { transactionId: B0_ID, index: 0 },
        utxoEntry: {
          amount: "0",
          scriptPublicKey: { scriptPublicKey: "" },
          blockDaaScore: "0",
          isCoinbase: false,
        },
      },
    ]);
    const app = await buildAppWith(kaspa);
    const res = await app.inject({
      method: "GET",
      url: "/v1/tickets",
      headers: { authorization: await bearerFor(OWNER_ADDRESS) },
    });
    expect(res.statusCode).toBe(HTTP_OK);
    const tickets = res.json() as { ticket_id: string }[];
    expect(tickets.length).toBeGreaterThan(0);
    expect(tickets[0]?.ticket_id).toMatch(/^\w+:\d+$/);
    await app.close();
  });

  it("GET /v1/tickets for an unrelated address -> empty (scoped to the caller)", async () => {
    const kaspa = new FakeKaspa();
    seedBaseChain(kaspa);
    const app = await buildAppWith(kaspa);
    // A token for a wallet that holds no tickets (the owner address is the only
    // one with a minted ticket here); an unrelated P2PK address returns none.
    const stranger = p2pkAddress(hexToBytes("ab".repeat(32)), NETWORK);
    const res = await app.inject({
      method: "GET",
      url: "/v1/tickets",
      headers: { authorization: await bearerFor(stranger) },
    });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it("GET /v1/events (unfiltered) stays public", async () => {
    const kaspa = new FakeKaspa();
    seedBaseChain(kaspa);
    const app = await buildAppWith(kaspa);
    const res = await app.inject({ method: "GET", url: "/v1/events" });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json()).toHaveLength(1);
    await app.close();
  });

  it("GET /v1/events?organizer_address= needs a token -> 401 without one", async () => {
    const kaspa = new FakeKaspa();
    seedBaseChain(kaspa);
    const app = await buildAppWith(kaspa);
    const res = await app.inject({
      method: "GET",
      url: `/v1/events?organizer_address=${ORG_ADDRESS}`,
    });
    expect(res.statusCode).toBe(HTTP_UNAUTHORIZED);
    await app.close();
  });

  it("GET /v1/events?organizer_address= must match the signed-in wallet", async () => {
    const kaspa = new FakeKaspa();
    seedBaseChain(kaspa);
    const app = await buildAppWith(kaspa);
    // Signed in as the owner, asking for the organizer's events -> 401.
    const res = await app.inject({
      method: "GET",
      url: `/v1/events?organizer_address=${ORG_ADDRESS}`,
      headers: { authorization: await bearerFor(OWNER_ADDRESS) },
    });
    expect(res.statusCode).toBe(HTTP_UNAUTHORIZED);
    await app.close();
  });

  it("GET /v1/events?organizer_address= returns the caller's own events", async () => {
    const kaspa = new FakeKaspa();
    seedBaseChain(kaspa);
    const app = await buildAppWith(kaspa);
    const res = await app.inject({
      method: "GET",
      url: `/v1/events?organizer_address=${ORG_ADDRESS}`,
      headers: { authorization: await bearerFor(ORG_ADDRESS) },
    });
    expect(res.statusCode).toBe(HTTP_OK);
    expect(res.json()[0]?.covenant_id).toBe(TEST_COVENANT_ID);
    await app.close();
  });
});

describe("auth: challenge/session endpoints", () => {
  it("challenge issues a nonce + message; session accepts a genuine signature", async () => {
    const kaspa = new FakeKaspa();
    const app = await buildAppWith(kaspa);
    const mod = (await import("../../vendor/kaspa-wasm/kaspa.js")) as {
      PrivateKey: new (k: string) => { toAddress: (n: string) => { toString(): string } };
      signMessage: (i: { message: string; privateKey: unknown }) => string;
    };
    const priv = new mod.PrivateKey("3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29");
    const address = priv.toAddress("testnet-10").toString();

    const challenge = await app.inject({ method: "POST", url: "/v1/auth/challenge", payload: { address } });
    expect(challenge.statusCode).toBe(HTTP_OK);
    const { message } = challenge.json() as { message: string };

    const signature = mod.signMessage({ message, privateKey: priv });
    const session = await app.inject({ method: "POST", url: "/v1/auth/session", payload: { message, signature } });
    expect(session.statusCode).toBe(HTTP_OK);
    const { token } = session.json() as { token: string };
    expect(token).toBeTruthy();
    await app.close();
  });
});
