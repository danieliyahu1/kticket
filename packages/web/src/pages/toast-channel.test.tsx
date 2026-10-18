// @vitest-environment jsdom

// Whole-issue integration test: the browser app as a black box with a mocked
// API and wallet. A failed buy produces exactly one accessible message, never a
// toast plus an inline copy; a wallet cancel says so once; the message
// auto-dismisses and Escape clears it.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../app";
import { setAuthToken, setReauthHandler } from "../api/client";
import { dismissToast, getToast } from "../components/toast-store";
import type { KaswareProvider } from "../wallet/types";

const COVENANT_ID = "ab".repeat(32);
const ADDRESS = "kaspatest:qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszapw00vun";
const PUBLIC_KEY = `02${"11".repeat(32)}`;
const SIGNATURE = "ab".repeat(64);
const SIGNING_TEMPLATE = JSON.stringify({ version: 0, inputs: [], outputs: [] });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function eventDetail() {
  return {
    event: {
      covenant_id: COVENANT_ID,
      deploy_txid: "aa".repeat(32),
      name: "Event A",
      date: "2026-12-31",
      time: "20:00",
      image: "",
      price: 500_000_000,
      capacity: 2,
      organizer_address: ADDRESS,
      verified: true,
    },
    raw_chain: {
      deploy_txid: "aa".repeat(32),
      authorizing_txid: "bb".repeat(32),
      maker_address: ADDRESS,
      decoded_constants: { price: 500_000_000, org_spk: "", burn_template_hash: "" },
      decoded_state: { owner: "", capacity: 2 },
      payload: null,
    },
  };
}

function fakeWallet(options: { rejectSignature?: boolean } = {}): KaswareProvider {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    requestAccounts: vi.fn(async () => [ADDRESS]),
    getAccounts: vi.fn(async () => [ADDRESS]),
    getPublicKey: vi.fn(async () => PUBLIC_KEY),
    getNetwork: vi.fn(async () => "kaspa_testnet_10"),
    switchNetwork: vi.fn(async () => "kaspa_testnet_10"),
    disconnect: vi.fn(async () => undefined),
    signMessage: vi.fn(async () => SIGNATURE),
    signPskt: vi.fn(async () => {
      if (options.rejectSignature) {
        throw { code: 4001, message: "User rejected the request." };
      }
      return { inputs: [] };
    }),
    on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(callback);
      listeners.set(event, set);
    }),
    removeListener: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(callback);
    }),
  } as unknown as KaswareProvider;
}

function mockApi(options: { failPrepare?: boolean } = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/v1/config") {
        return json({
          network: "testnet10",
          network_id: "testnet-10",
          wallet_network: "kaspa_testnet_10",
          address_prefix: "kaspatest:",
        });
      }
      if (path === `/v1/events/${COVENANT_ID}`) return json(eventDetail());
      if (path === `/v1/events/${COVENANT_ID}/listings`) return json([]);
      if (path === "/v1/auth/challenge") {
        return json({ nonce: "b7c9e1f4a2d84c6e9f0a1b2c3d4e5f60", message: "kticket challenge" });
      }
      if (path === "/v1/auth/session") return json({ token: "session-token", expires_in_seconds: 900 });
      if (path === `/v1/events/${COVENANT_ID}/buy/prepare`) {
        if (options.failPrepare) {
          return json(
            { error: { type: "policy", message: "sold out — no tickets left", retryable: false } },
            422,
          );
        }
        return json({
          buy_id: "buy-1",
          signing_template: SIGNING_TEMPLATE,
          template: { version: 0, inputs: [], outputs: [], lock_time: 0 },
          sign_inputs: [{ index: 1 }],
          price: 500_000_000,
          ticket_deposit: 50_000_000,
        });
      }
      if (path === `/v1/events/${COVENANT_ID}/buy/finalize`) {
        return json({ txid: "cd".repeat(32) });
      }
      return json({ error: { type: "invalid", message: `unexpected ${path}` } }, 404);
    }),
  );
}

function install(provider: KaswareProvider): void {
  Object.defineProperty(window, "kasware", { value: provider, configurable: true, writable: true });
}

async function openEventAndBuy(): Promise<void> {
  window.history.pushState({}, "", `/events/${COVENANT_ID}`);
  render(<App />);
  const buy = await screen.findByRole("button", { name: /Buy ticket/ });
  fireEvent.click(buy);
}

beforeEach(() => {
  setAuthToken(null);
  dismissToast();
});

afterEach(() => {
  cleanup();
  delete (window as { kasware?: KaswareProvider }).kasware;
  setAuthToken(null);
  setReauthHandler(null);
  dismissToast();
  vi.unstubAllGlobals();
});

describe("one accessible message per outcome", () => {
  it("shows one error toast for a failed buy, with no duplicate inline copy", async () => {
    mockApi({ failPrepare: true });
    install(fakeWallet());

    await openEventAndBuy();

    const alerts = await screen.findAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain("sold out — no tickets left");
    expect(screen.queryByText("No ticket was issued.")).toBeNull();
    expect(getToast()?.tone).toBe("error");
    expect(getToast()?.message).toBe("sold out — no tickets left");

    // The recoverable affordance is back: the same button, no second click.
    expect(await screen.findByRole("button", { name: /Buy ticket/ })).toBeTruthy();
  }, 15_000);

  it("auto-dismisses and can be cleared with Escape", async () => {
    mockApi({ failPrepare: true });
    install(fakeWallet());

    await openEventAndBuy();
    expect(await screen.findByRole("alert")).toBeTruthy();

    // An explanation dwells long enough to read, then leaves on its own.
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull(), {
      timeout: 10_000,
      interval: 100,
    });

    fireEvent.click(screen.getByRole("button", { name: /Buy ticket/ }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("alert")).toBeNull();
  }, 20_000);

  it("maps a wallet rejection to one readable notice", async () => {
    mockApi();
    install(fakeWallet({ rejectSignature: true }));

    await openEventAndBuy();

    const notice = await screen.findByRole("status");
    expect(notice.textContent).toContain("Canceled in your wallet.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("No ticket was issued.")).toBeNull();
  });
});
