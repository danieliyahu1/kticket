// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FALLBACK_RUNTIME_CONFIG, resetRuntimeConfig } from "../config/runtime";
import { addressMatchesNetwork } from "./network-match";
import { isSwitchingNetwork } from "./network-status";
import { ensureWalletNetwork } from "./network";
import type { KaswareProvider } from "./types";

const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));
vi.mock("../components/toast-store", () => ({ showToast: showToastMock }));

interface FakeWalletOptions {
  network?: string;
  /** Called by switchNetwork; throw to simulate a dismissal. */
  onSwitch?: (wallet: { settle: () => void }) => Promise<void> | void;
}

function fakeWallet(options: FakeWalletOptions = {}) {
  let network = options.network ?? "kaspa_mainnet";
  const listeners = new Set<() => void>();
  const settle = () => {
    network = "kaspa_testnet_10";
    for (const listener of listeners) listener();
  };

  const provider = {
    getNetwork: vi.fn(async () => network),
    switchNetwork: vi.fn(async () => {
      await options.onSwitch?.({ settle });
      return network;
    }),
    on: vi.fn((event: string, callback: () => void) => {
      if (event === "networkChanged") listeners.add(callback);
    }),
    removeListener: vi.fn((event: string, callback: () => void) => {
      if (event === "networkChanged") listeners.delete(callback);
    }),
  } as unknown as KaswareProvider;

  return { provider, settle, setNetwork: (next: string) => (network = next) };
}

function install(wallet: KaswareProvider): void {
  Object.defineProperty(window, "kasware", { value: wallet, configurable: true, writable: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  showToastMock.mockReset();
  resetRuntimeConfig();
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as { kasware?: KaswareProvider }).kasware;
  resetRuntimeConfig();
});

describe("ensureWalletNetwork (KTK-175)", () => {
  it("returns immediately when the wallet is already on the server's network", async () => {
    const { provider } = fakeWallet({ network: "kaspa_testnet_10" });
    install(provider);

    await expect(ensureWalletNetwork()).resolves.toBe(true);
    expect(provider.switchNetwork).not.toHaveBeenCalled();
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it("continues after an approved switch signalled by networkChanged", async () => {
    const { provider, settle } = fakeWallet({
      onSwitch: () => {
        setTimeout(settle, 50);
      },
    });
    install(provider);

    const result = ensureWalletNetwork();
    await vi.advanceTimersByTimeAsync(50);
    await expect(result).resolves.toBe(true);
    expect(provider.switchNetwork).toHaveBeenCalledWith("kaspa_testnet_10");
    expect(showToastMock).toHaveBeenCalledTimes(2);
    expect(showToastMock.mock.calls[0]?.[0]).toMatch(/Switching/);
    expect(showToastMock.mock.calls[1]?.[0]).toMatch(/Your wallet is on/);
    expect(isSwitchingNetwork()).toBe(false);
  });

  it("continues when the event never arrives but the poll sees the switch", async () => {
    const { provider, setNetwork } = fakeWallet({
      onSwitch: () => {
        // A silent switch: the reported network changes, no event fires.
        setTimeout(() => setNetwork("kaspa_testnet_10"), 1_000);
      },
    });
    install(provider);

    const result = ensureWalletNetwork();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBe(true);
    expect(isSwitchingNetwork()).toBe(false);
  });

  it("ends quietly as a cancel on timeout", async () => {
    const { provider } = fakeWallet();
    install(provider);

    const result = ensureWalletNetwork();
    await vi.advanceTimersByTimeAsync(11_000);
    await expect(result).resolves.toBe(false);
    // One "switching" notice, never an error or a success.
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(showToastMock.mock.calls[0]?.[0]).toMatch(/Switching/);
    expect(isSwitchingNetwork()).toBe(false);
  });

  it("ends quietly as a cancel when the user rejects the switch", async () => {
    const { provider } = fakeWallet({
      onSwitch: () => {
        throw { code: 4001, message: "User rejected the request." };
      },
    });
    install(provider);

    await expect(ensureWalletNetwork()).resolves.toBe(false);
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(isSwitchingNetwork()).toBe(false);
  });

  it("stays silent when the caller owns the message", async () => {
    const { provider, settle } = fakeWallet({
      onSwitch: () => {
        setTimeout(settle, 50);
      },
    });
    install(provider);

    const result = ensureWalletNetwork({ announce: false });
    await vi.advanceTimersByTimeAsync(50);
    await expect(result).resolves.toBe(true);
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it("uses the server-reported address prefix", () => {
    const config = { ...FALLBACK_RUNTIME_CONFIG, addressPrefix: "kaspa:" };
    expect(addressMatchesNetwork("kaspa:abc", config)).toBe(true);
    expect(addressMatchesNetwork("kaspatest:abc", config)).toBe(false);
  });
});
