// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WalletState } from "../wallet/types";
import { KASWARE_INSTALL_URL } from "../wallet/kasware";
import { AuthGate } from "./auth-gate";

const harness = vi.hoisted(() => ({
  state: { status: "not-installed" } as WalletState,
}));

vi.mock("../hooks/use-wallet", () => ({
  useWallet: () => ({ state: harness.state, connect: vi.fn() }),
}));

function renderGate() {
  return render(
    <AuthGate
      connectTitle="Your tickets live here."
      connectSub="Connect your wallet to see what's yours."
    >
      <p>your tickets</p>
    </AuthGate>,
  );
}

afterEach(() => {
  cleanup();
});

describe("the wallet gate explains Kasware (issue #8)", () => {
  it("offers the explained wallet when none is installed", () => {
    harness.state = { status: "not-installed" };
    renderGate();

    expect(screen.getByText("Your tickets live here.")).toBeTruthy();
    expect(screen.getByText(/Kasware is the wallet that signs for you/)).toBeTruthy();

    const install = screen.getByRole("link", { name: "Get Kasware" });
    expect(install.getAttribute("href")).toBe(KASWARE_INSTALL_URL);
    expect(install.getAttribute("target")).toBe("_blank");
    expect(screen.queryByRole("button", { name: "Connect wallet" })).toBeNull();
  });

  it("asks to connect when the wallet is installed", () => {
    harness.state = { status: "disconnected" };
    renderGate();

    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Get Kasware" })).toBeNull();
  });
});
