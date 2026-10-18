// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dismissToast, getToast } from "../components/toast-store";
import type { WalletState } from "../wallet/types";
import { useWalletNotices } from "./use-wallet-notices";

const harness = vi.hoisted(() => ({
  state: { status: "connected", accounts: ["kaspatest:one"], publicKey: "02aa" } as WalletState,
  switching: false,
}));

vi.mock("./use-wallet", () => ({
  useWallet: () => ({ state: harness.state }),
}));

vi.mock("./use-network-switching", () => ({
  useNetworkSwitching: () => harness.switching,
}));

vi.mock("../config/RuntimeConfigProvider", () => ({
  useRuntimeConfig: () => ({
    network: "testnet10",
    networkId: "testnet-10",
    walletNetwork: "kaspa_testnet_10",
    addressPrefix: "kaspatest:",
  }),
}));

function Probe() {
  useWalletNotices();
  return null;
}

beforeEach(() => {
  harness.state = { status: "connected", accounts: ["kaspatest:one"], publicKey: "02aa" };
  harness.switching = false;
  dismissToast();
});

afterEach(() => {
  cleanup();
  dismissToast();
});

describe("app-level wallet notices (KTK-168)", () => {
  it("announces a wallet that drifts onto the wrong network", () => {
    const { rerender } = render(<Probe />);

    harness.state = { status: "wrong-network", accounts: ["kaspatest:one"], publicKey: "02aa" };
    act(() => rerender(<Probe />));

    expect(getToast()?.tone).toBe("notice");
    expect(getToast()?.message).toContain("different network");
    expect(getToast()?.message).toContain("Testnet 10");
  });

  it("stays silent while an action owns the switch", () => {
    harness.switching = true;
    const { rerender } = render(<Probe />);

    harness.state = { status: "wrong-network", accounts: ["kaspatest:one"], publicKey: "02aa" };
    act(() => rerender(<Probe />));

    expect(getToast()).toBeNull();
  });

  it("does not repeat the steady state", () => {
    harness.state = { status: "wrong-network", accounts: ["kaspatest:one"], publicKey: "02aa" };
    const { rerender } = render(<Probe />);

    act(() => rerender(<Probe />));
    expect(getToast()).toBeNull();
  });
});
