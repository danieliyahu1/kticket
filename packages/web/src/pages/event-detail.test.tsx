// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EventDetailPage from "./event-detail";

const { fetchEventMock } = vi.hoisted(() => ({ fetchEventMock: vi.fn() }));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    fetchEvent: fetchEventMock,
    fetchEventListings: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("../hooks/use-wallet", () => ({
  useWallet: () => ({ state: { status: "disconnected" }, connect: vi.fn() }),
}));

const COVENANT_ID = "ab".repeat(32);

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
      organizer_address: "kaspatest:org",
      verified: true,
    },
    raw_chain: {
      deploy_txid: "aa".repeat(32),
      authorizing_txid: "bb".repeat(32),
      maker_address: "kaspatest:org",
      decoded_constants: { price: 500_000_000, org_spk: "", burn_template_hash: "" },
      decoded_state: { owner: "", capacity: 2 },
      payload: null,
    },
  };
}

beforeEach(() => {
  document.head.innerHTML = '<meta name="description" content="generic">';
  document.title = "kticket";
  fetchEventMock.mockReset();
  fetchEventMock.mockResolvedValue(eventDetail());
});

afterEach(() => {
  cleanup();
});

describe("EventDetailPage metadata (KTK-162)", () => {
  it("applies the event's metadata on mount, shows Share, and restores on unmount", async () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={[`/events/${COVENANT_ID}`]}>
        <Routes>
          <Route path="/events/:covenantId" element={<EventDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText("Event A");
    await waitFor(() => expect(document.title).toBe("Event A — kticket"));

    expect(document.querySelector('meta[name="description"]')?.getAttribute("content")).toContain(
      "Event A",
    );
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
      `${window.location.origin}/events/${COVENANT_ID}`,
    );
    expect(screen.getByRole("button", { name: "Share event" })).toBeTruthy();
    // The purchase entry point is present for a verified event.
    expect(screen.getByRole("button", { name: /Buy ticket/ })).toBeTruthy();

    unmount();

    await waitFor(() => expect(document.title).toBe("kticket"));
    expect(document.querySelector('meta[name="description"]')?.getAttribute("content")).toBe(
      "generic",
    );
    expect(document.querySelector('link[rel="canonical"]')).toBeNull();
  });
});
