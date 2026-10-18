// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeConfigProvider } from "../config/RuntimeConfigProvider";
import { resetRuntimeConfig } from "../config/runtime";
import { useWallet } from "../hooks/use-wallet";
import { WalletProvider } from "./provider";
import type { KaswareProvider } from "./types";

const ADDRESS_TESTNET = "kaspatest:qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszapw00vun";
const ADDRESS_MAINNET = "kaspa:qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszapw00vun";

function fakeWallet(options: {
  address: string;
  network: string;
}): KaswareProvider {
  return {
    requestAccounts: vi.fn().mockResolvedValue([options.address]),
    getAccounts: vi.fn().mockResolvedValue([options.address]),
    getPublicKey: vi.fn().mockResolvedValue(`02${"11".repeat(32)}`),
    getNetwork: vi.fn().mockResolvedValue(options.network),
    switchNetwork: vi.fn().mockResolvedValue(options.network),
    disconnect: vi.fn().mockResolvedValue(undefined),
    signMessage: vi.fn().mockResolvedValue("00"),
    signPskt: vi.fn().mockResolvedValue({}),
    on: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as KaswareProvider;
}

function Probe() {
  const { state } = useWallet();
  const mismatch = state.status === "connected" ? String(state.networkMismatch) : "n/a";
  return (
    <p>
      {state.status}|{mismatch}
    </p>
  );
}

function install(wallet: KaswareProvider): void {
  Object.defineProperty(window, "kasware", { value: wallet, configurable: true, writable: true });
}

afterEach(() => {
  cleanup();
  delete (window as { kasware?: KaswareProvider }).kasware;
  resetRuntimeConfig();
  vi.unstubAllGlobals();
});

describe("WalletProvider uses the runtime network identity (KTK-176)", () => {
  it("judges the wallet network and address prefix from GET /v1/config", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          network: "mainnet",
          network_id: "mainnet",
          wallet_network: "kaspa_mainnet",
          address_prefix: "kaspa:",
        }),
      }),
    );
    install(fakeWallet({ address: ADDRESS_MAINNET, network: "kaspa_mainnet" }));

    render(
      <RuntimeConfigProvider>
        <WalletProvider>
          <Probe />
        </WalletProvider>
      </RuntimeConfigProvider>,
    );

    expect(await screen.findByText("connected|false")).toBeTruthy();
  });

  it("flags a wallet on a different network than the server", async () => {
    // No config fetch needed: the default context is the testnet fallback.
    install(fakeWallet({ address: ADDRESS_MAINNET, network: "kaspa_mainnet" }));

    render(
      <WalletProvider>
        <Probe />
      </WalletProvider>,
    );

    expect(await screen.findByText("wrong-network|n/a")).toBeTruthy();
  });
});
