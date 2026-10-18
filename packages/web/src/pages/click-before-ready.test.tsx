// @vitest-environment jsdom

// Whole-issue integration test (KTK-174): the browser app as a black box with a
// mocked API and wallet. One click on Buy must survive connect, sign-in, and a
// network switch, then run the original purchase exactly once.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../app";
import { setAuthToken, setReauthHandler } from "../api/client";
import { dismissToast } from "../components/toast-store";
import type { KaswareProvider } from "../wallet/types";

// Observe every just-in-time message while still rendering the real viewport.
const toastMessages = vi.hoisted(() => [] as string[]);
vi.mock("../components/toast-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/toast-store")>();
  return {
    ...actual,
    showToast: (message: string, options?: Parameters<typeof actual.showToast>[1]) => {
      toastMessages.push(message);
      return actual.showToast(message, options);
    },
  };
});

const COVENANT_ID = "ab".repeat(32);
const ADDRESS = "kaspatest:qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszapw00vun";
const OTHER_ADDRESS = "kaspatest:pppszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszapw00vun";
const PUBLIC_KEY = `02${"11".repeat(32)}`;
const SIGNATURE = "ab".repeat(64);

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

const SIGNING_TEMPLATE = JSON.stringify({ version: 0, inputs: [], outputs: [] });

interface ApiCall {
  method: string;
  path: string;
}

interface FakeWallet {
  provider: KaswareProvider;
  signPskt: ReturnType<typeof vi.fn>;
  switchNetwork: ReturnType<typeof vi.fn>;
  emitAccounts: (accounts: string[]) => void;
}

function fakeWallet(options: {
  network?: string;
  rejectSwitch?: boolean;
  onSign?: () => Promise<void> | void;
} = {}): FakeWallet {
  let connected = false;
  let account = ADDRESS;
  let network = options.network ?? "kaspa_mainnet";
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };
  const signPskt = vi.fn(async () => {
    await options.onSign?.();
    return { inputs: [] };
  });
  const switchNetwork = vi.fn(async () => {
    if (options.rejectSwitch) throw { code: 4001, message: "User rejected the request." };
    network = "kaspa_testnet_10";
    emit("networkChanged");
    return network;
  });

  const provider = {
    requestAccounts: vi.fn(async () => {
      connected = true;
      account = ADDRESS;
      return [ADDRESS];
    }),
    getAccounts: vi.fn(async () => (connected ? [account] : [])),
    getPublicKey: vi.fn(async () => PUBLIC_KEY),
    getNetwork: vi.fn(async () => (connected ? network : "")),
    switchNetwork,
    disconnect: vi.fn(async () => {
      connected = false;
    }),
    signMessage: vi.fn(async () => SIGNATURE),
    signPskt,
    on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(callback);
      listeners.set(event, set);
    }),
    removeListener: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(callback);
    }),
  } as unknown as KaswareProvider;

  return {
    provider,
    signPskt,
    switchNetwork,
    emitAccounts: (accounts: string[]) => {
      account = accounts[0] ?? account;
      emit("accountsChanged", accounts);
    },
  };
}

function mockApi(calls: ApiCall[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, path });

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
      return json({ error: { type: "invalid", message: `unexpected ${method} ${path}` } }, 404);
    }),
  );
}

function install(provider: KaswareProvider): void {
  Object.defineProperty(window, "kasware", { value: provider, configurable: true, writable: true });
}

function openEvent(): void {
  window.history.pushState({}, "", `/events/${COVENANT_ID}`);
}

async function clickBuy(): Promise<void> {
  const buy = await screen.findByRole("button", { name: /Buy ticket/ });
  fireEvent.click(buy);
}

function count(calls: ApiCall[], method: string, path: string): number {
  return calls.filter((call) => call.method === method && call.path === path).length;
}

beforeEach(() => {
  openEvent();
  setAuthToken(null);
  dismissToast();
  toastMessages.length = 0;
});

afterEach(() => {
  cleanup();
  delete (window as { kasware?: KaswareProvider }).kasware;
  setAuthToken(null);
  setReauthHandler(null);
  dismissToast();
  vi.unstubAllGlobals();
});

describe("click before the wallet is ready (KTK-174)", () => {
  it("completes a disconnected buy through connect, sign-in, and switch exactly once", async () => {
    const calls: ApiCall[] = [];
    mockApi(calls);
    const wallet = fakeWallet({ network: "kaspa_mainnet" });
    install(wallet.provider);

    render(<App />);
    await clickBuy();

    expect(await screen.findByText("You're in.", {}, { timeout: 4_000 })).toBeTruthy();

    expect(wallet.provider.requestAccounts).toHaveBeenCalledTimes(1);
    expect(wallet.provider.signMessage).toHaveBeenCalledTimes(1);
    expect(wallet.switchNetwork).toHaveBeenCalledTimes(1);
    expect(wallet.switchNetwork).toHaveBeenCalledWith("kaspa_testnet_10");
    expect(wallet.signPskt).toHaveBeenCalledTimes(1);

    expect(count(calls, "POST", "/v1/auth/challenge")).toBe(1);
    expect(count(calls, "POST", "/v1/auth/session")).toBe(1);
    expect(count(calls, "POST", `/v1/events/${COVENANT_ID}/buy/prepare`)).toBe(1);
    expect(count(calls, "POST", `/v1/events/${COVENANT_ID}/buy/finalize`)).toBe(1);

    // One message per setup step, in the user's language (KTK-172).
    expect(toastMessages.filter((message) => /Connecting your wallet/.test(message))).toHaveLength(1);
    expect(toastMessages.filter((message) => /Sign in to continue/.test(message))).toHaveLength(1);
    expect(
      toastMessages.filter((message) => /Switching your wallet to Testnet 10/.test(message)),
    ).toHaveLength(1);
    expect(
      toastMessages.filter((message) => /Your wallet is on Testnet 10/.test(message)),
    ).toHaveLength(1);
  });

  it("cancels quietly when the network switch is rejected", async () => {
    const calls: ApiCall[] = [];
    mockApi(calls);
    const wallet = fakeWallet({ rejectSwitch: true });
    install(wallet.provider);

    render(<App />);
    await clickBuy();

    await waitFor(() => expect(wallet.switchNetwork).toHaveBeenCalledTimes(1));
    expect(count(calls, "POST", `/v1/events/${COVENANT_ID}/buy/prepare`)).toBe(0);
    expect(wallet.signPskt).not.toHaveBeenCalled();
    // The page never reports a failed purchase; it simply returns to idle.
    expect(screen.queryByText("No ticket was issued.")).toBeNull();
    expect(await screen.findByRole("button", { name: /Buy ticket/ })).toBeTruthy();
  });

  it("does not broadcast when the account changes mid-flow", async () => {
    const calls: ApiCall[] = [];
    mockApi(calls);
    const wallet = fakeWallet({
      network: "kaspa_testnet_10",
      onSign: async () => {
        // The user switches accounts inside the wallet while signing.
        wallet.emitAccounts([OTHER_ADDRESS]);
        // Let the provider's asynchronous account refresh land first.
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    });
    install(wallet.provider);

    render(<App />);
    await clickBuy();

    await waitFor(() =>
      expect(count(calls, "POST", `/v1/events/${COVENANT_ID}/buy/prepare`)).toBe(1),
    );
    expect(wallet.signPskt).toHaveBeenCalledTimes(1);

    // Give the provider's async account refresh a turn to land.
    await waitFor(() => expect(count(calls, "POST", `/v1/events/${COVENANT_ID}/buy/finalize`)).toBe(0));
    expect(screen.queryByText("You're in.")).toBeNull();
  });
});
