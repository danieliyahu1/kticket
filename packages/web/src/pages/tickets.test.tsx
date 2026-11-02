// @vitest-environment jsdom

// The tickets page shows "The server isn't responding." with a Try again
// button when the API read fails. The retry must actually re-read: the page
// keeps a retry token in its effect dependencies for exactly that reason.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerError } from "../api/client";
import TicketsPage from "./tickets";

const { fetchTicketsMock } = vi.hoisted(() => ({ fetchTicketsMock: vi.fn() }));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, fetchMyTickets: fetchTicketsMock };
});

const ADDRESS = "kaspatest:qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszapw00vun";
const PUBLIC_KEY = `02${"11".repeat(32)}`;

vi.mock("../hooks/use-wallet", () => ({
  useWallet: () => ({
    state: { status: "connected", publicKey: PUBLIC_KEY, accounts: [ADDRESS] },
    connect: vi.fn(),
  }),
}));

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ status: "ready" }),
}));

function ticket() {
  return {
    ticket_id: "cd".repeat(32),
    covenant_id: "ef".repeat(32),
    event_name: "Event A",
    event_date: "2026-12-31",
    event_time: "20:00",
  };
}

beforeEach(() => {
  fetchTicketsMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("TicketsPage offline retry", () => {
  it("re-reads the tickets when Try again is pressed", async () => {
    fetchTicketsMock.mockRejectedValueOnce(new ServerError()).mockResolvedValueOnce([ticket()]);

    render(
      <MemoryRouter>
        <TicketsPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Event A")).toBeTruthy();
    expect(fetchTicketsMock).toHaveBeenCalledTimes(2);
  });
});
