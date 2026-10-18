// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateDialogProvider } from "./create-dialog-context";
import { Layout } from "./layout";

const harness = vi.hoisted(() => ({
  mismatch: false,
  switching: false,
  quiet: false,
}));

vi.mock("../hooks/use-wallet", () => ({
  useWallet: () => ({
    state: {
      status: "connected",
      accounts: ["kaspatest:qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszapw00vun"],
      publicKey: `02${"11".repeat(32)}`,
      networkMismatch: harness.mismatch,
    },
    connect: vi.fn(),
    disconnect: vi.fn(),
    switchToWalletNetwork: vi.fn(),
  }),
}));

vi.mock("../hooks/use-network-switching", () => ({
  useNetworkSwitching: () => harness.switching,
  useNetworkQuiet: () => harness.quiet,
}));

function renderLayout() {
  return render(
    <CreateDialogProvider>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<p>content</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </CreateDialogProvider>,
  );
}

beforeEach(() => {
  harness.mismatch = false;
  harness.switching = false;
  harness.quiet = false;
});

afterEach(() => {
  cleanup();
});

describe("network banner ownership (KTK-172)", () => {
  it("shows the steady-state banner when no action owns the switch", () => {
    harness.mismatch = true;
    renderLayout();

    expect(screen.getByText(/Your wallet's address is for a different network/)).toBeTruthy();
  });

  it("suppresses the banner while an action is switching the wallet", () => {
    harness.mismatch = true;
    harness.switching = true;
    renderLayout();

    expect(screen.queryByText(/Your wallet's address is for a different network/)).toBeNull();
  });
});
