// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletState } from "../wallet/types";
import { flowLostWallet, usePendingAction } from "./use-pending-action";

const ADDRESS = "kaspatest:qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszapw00vun";
const PUBLIC_KEY = `02${"11".repeat(32)}`;

const harness = vi.hoisted(() => ({
  state: { status: "disconnected" } as WalletState,
  order: [] as string[],
  connect: vi.fn(),
  signInFor: vi.fn(),
  ensure: vi.fn(),
}));

vi.mock("../components/toast-store", () => ({ showToast: vi.fn() }));

vi.mock("../api/client", () => ({
  getAuthToken: () => null,
  getAuthAddress: () => null,
}));

vi.mock("./use-wallet", () => ({
  useWallet: () => ({
    state: harness.state,
    connect: harness.connect,
    disconnect: vi.fn(),
    switchToWalletNetwork: vi.fn(),
  }),
}));

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: "idle",
    error: null,
    address: null,
    tokenPresent: false,
    tokenAddress: null,
    signIn: vi.fn(),
    signInFor: harness.signInFor,
  }),
}));

vi.mock("../wallet/network", () => ({
  ensureWalletNetwork: harness.ensure,
  isSwitchingNetwork: () => false,
}));

function Probe() {
  const pending = usePendingAction();
  return (
    <button
      type="button"
      onClick={() =>
        void pending.start(async (wallet) => {
          harness.order.push(`action:${wallet.address}`);
        })
      }
    >
      Run
    </button>
  );
}

beforeEach(() => {
  harness.state = { status: "disconnected" };
  harness.order = [];
  harness.connect.mockReset();
  harness.signInFor.mockReset();
  harness.ensure.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("flowLostWallet (KTK-173)", () => {
  const identity = ADDRESS;
  const connected = (address: string): WalletState => ({
    status: "connected",
    accounts: [address],
    publicKey: PUBLIC_KEY,
  });

  it("keeps a flow whose connected account still matches", () => {
    expect(flowLostWallet(connected(identity), identity, false, false)).toBe(false);
  });

  it("abandons a flow when the account changes", () => {
    expect(flowLostWallet(connected("kaspatest:other"), identity, false, false)).toBe(true);
  });

  it("abandons a flow when the wallet disconnects", () => {
    expect(flowLostWallet({ status: "disconnected" }, identity, false, false)).toBe(true);
  });

  it("abandons a flow when the network drifts after the guard succeeded", () => {
    const wrong: WalletState = {
      status: "wrong-network",
      accounts: [identity],
      publicKey: PUBLIC_KEY,
    };
    expect(flowLostWallet(wrong, identity, true, false)).toBe(true);
  });

  it("does not treat the action-owned switch as network drift", () => {
    const wrong: WalletState = {
      status: "wrong-network",
      accounts: [identity],
      publicKey: PUBLIC_KEY,
    };
    expect(flowLostWallet(wrong, identity, true, true)).toBe(false);
  });
});

describe("usePendingAction (KTK-177)", () => {
  it("resolves wallet → connect → sign-in → network, then runs the action once", async () => {
    harness.connect.mockImplementation(async () => {
      harness.order.push("connect");
      return { address: ADDRESS, publicKey: PUBLIC_KEY };
    });
    harness.signInFor.mockImplementation(async () => {
      harness.order.push("signIn");
      return true;
    });
    harness.ensure.mockImplementation(async () => {
      harness.order.push("network");
      return true;
    });

    render(<Probe />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(harness.order).toContain(`action:${ADDRESS}`));
    expect(harness.order).toEqual(["connect", "signIn", "network", `action:${ADDRESS}`]);
  });

  it("stops before sign-in when the connect prompt is canceled", async () => {
    harness.connect.mockResolvedValue(null);

    render(<Probe />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(1));
    expect(harness.signInFor).not.toHaveBeenCalled();
    expect(harness.ensure).not.toHaveBeenCalled();
    expect(harness.order).toEqual([]);
  });

  it("stops before the network guard when sign-in is canceled", async () => {
    harness.connect.mockResolvedValue({ address: ADDRESS, publicKey: PUBLIC_KEY });
    harness.signInFor.mockResolvedValue(false);

    render(<Probe />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(harness.signInFor).toHaveBeenCalledTimes(1));
    expect(harness.ensure).not.toHaveBeenCalled();
    expect(harness.order).toEqual([]);
  });

  it("ignores a second click while the chain is in flight", async () => {
    let release: ((identity: { address: string; publicKey: string }) => void) | undefined;
    harness.connect.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    harness.signInFor.mockResolvedValue(true);
    harness.ensure.mockResolvedValue(true);

    render(<Probe />);
    const run = screen.getByRole("button", { name: "Run" });
    fireEvent.click(run);
    fireEvent.click(run);

    await waitFor(() => expect(harness.connect).toHaveBeenCalledTimes(1));
    release?.({ address: ADDRESS, publicKey: PUBLIC_KEY });

    await waitFor(() => expect(harness.order).toEqual([`action:${ADDRESS}`]));
    expect(harness.connect).toHaveBeenCalledTimes(1);
  });
});
