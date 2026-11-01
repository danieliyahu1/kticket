// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WalletState } from "../wallet/types";
import { CreateDialogProvider } from "./create-dialog-context";
import { HeaderActions } from "./header-actions";

const harness = vi.hoisted(() => ({
  state: { status: "not-installed" } as WalletState,
}));

vi.mock("../hooks/use-wallet", () => ({
  useWallet: () => ({
    state: harness.state,
    connect: vi.fn(),
    disconnect: vi.fn(),
    switchToWalletNetwork: vi.fn(),
  }),
}));

vi.mock("../hooks/use-network-switching", () => ({
  useNetworkSwitching: () => false,
}));

vi.mock("../config/RuntimeConfigProvider", () => ({
  useRuntimeConfig: () => ({
    network: "testnet10",
    networkId: "testnet-10",
    walletNetwork: "kaspa_testnet_10",
    addressPrefix: "kaspatest:",
  }),
}));

const ADDRESS = "kaspatest:qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszapw00vun";

function renderHeader() {
  return render(
    <CreateDialogProvider>
      <HeaderActions />
    </CreateDialogProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("the header never sells the wallet (issue #8)", () => {
  it("renders nothing when no wallet is installed", () => {
    harness.state = { status: "not-installed" };
    const { container } = renderHeader();

    expect(container.textContent).toBe("");
  });

  it("stays quiet until detection answers", () => {
    harness.state = { status: "idle" };
    const { container } = renderHeader();

    expect(container.textContent).toBe("");
  });

  it("offers connect once the wallet is installed", () => {
    harness.state = { status: "disconnected" };
    renderHeader();

    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("offers create and the account once connected", () => {
    harness.state = { status: "connected", accounts: [ADDRESS], publicKey: "02".padEnd(66, "1") };
    renderHeader();

    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
    expect(screen.getByTitle(ADDRESS)).toBeTruthy();
  });
});
