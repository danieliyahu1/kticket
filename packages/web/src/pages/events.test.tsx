// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventListItem } from "../api/client";
import { CreateDialogProvider } from "../components/create-dialog-context";
import EventsPage from "./events";

const harness = vi.hoisted(() => ({
  events: [] as EventListItem[],
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    fetchEventsList: vi.fn(async () => harness.events),
  };
});

function eventListItem(): EventListItem {
  return {
    covenant_id: "ab".repeat(32),
    deploy_txid: "aa".repeat(32),
    organizer_address: "kaspatest:organizer",
    name: "Event A",
    date: "2026-12-31",
    time: "20:00",
    price: 500_000_000,
    capacity: 10,
    verified: true,
  };
}

function renderEvents() {
  return render(
    <CreateDialogProvider>
      <MemoryRouter>
        <EventsPage />
      </MemoryRouter>
    </CreateDialogProvider>,
  );
}

beforeEach(() => {
  harness.events = [];
});

afterEach(() => {
  cleanup();
});

describe("home page statement (issue #8)", () => {
  it("says what kticket is and that looking around needs no wallet", async () => {
    renderEvents();

    expect(screen.getByRole("heading", { level: 1, name: "Tickets on the chain." })).toBeTruthy();
    expect(screen.getByText(/Create an event\. Sell tickets in KAS\./)).toBeTruthy();
    expect(screen.getByText(/the door can't be fooled/)).toBeTruthy();
    expect(screen.getByText("Looking around needs no wallet.")).toBeTruthy();

    await screen.findByText("No events yet.");
  });

  it("keeps the empty state to what is true and what to do", async () => {
    renderEvents();

    expect(await screen.findByText("Events appear here as soon as someone creates one.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create an event" })).toBeTruthy();
  });

  it("keeps the statement when there are events to browse", async () => {
    harness.events = [eventListItem()];
    renderEvents();

    expect(await screen.findByText("Event A")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Tickets on the chain." })).toBeTruthy();
    expect(screen.queryByText("No events yet.")).toBeNull();
  });
});
