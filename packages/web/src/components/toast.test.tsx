// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastViewport } from "./toast";
import { TOAST_DWELL_MS, dismissToast, getToast, showToast } from "./toast-store";

beforeEach(() => {
  vi.useFakeTimers();
  dismissToast();
});

afterEach(() => {
  cleanup();
  dismissToast();
  vi.useRealTimers();
});

describe("toast store", () => {
  it("keeps only the last message when two are published rapidly", () => {
    render(<ToastViewport />);

    act(() => {
      showToast("First", { tone: "info" });
      showToast("Second", { tone: "success" });
    });

    expect(screen.queryByText("First")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Second");
  });

  it("dismisses by id without clearing a newer message", () => {
    render(<ToastViewport />);

    let firstId = 0;
    act(() => {
      firstId = showToast("First", { tone: "success" }).id;
    });
    act(() => {
      showToast("Second", { tone: "success" });
    });
    act(() => dismissToast(firstId));

    expect(getToast()?.message).toBe("Second");
  });
});

describe("ToastViewport (KTK-161 accessibility)", () => {
  it("uses the right live-region role for each tone", () => {
    render(<ToastViewport />);

    act(() => showToast("Saved", { tone: "success" }));
    expect(screen.getByRole("status").getAttribute("aria-atomic")).toBe("true");

    act(() => showToast("Failed", { tone: "error" }));
    expect(screen.getByRole("alert").textContent).toContain("Failed");
  });

  it("auto-dismisses confirmations after their dwell", () => {
    render(<ToastViewport />);

    act(() => showToast("Copied", { tone: "success" }));
    act(() => vi.advanceTimersByTime(TOAST_DWELL_MS.success - 1));
    expect(screen.queryByRole("status")).not.toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps explanations on screen longer", () => {
    render(<ToastViewport />);

    act(() => showToast("The chain is slow", { tone: "info" }));
    act(() => vi.advanceTimersByTime(TOAST_DWELL_MS.success));
    expect(screen.queryByRole("status")).not.toBeNull();

    act(() => vi.advanceTimersByTime(TOAST_DWELL_MS.info - TOAST_DWELL_MS.success));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("holds while hovered, then resumes the dwell", () => {
    render(<ToastViewport />);

    act(() => showToast("Hover me", { tone: "success" }));
    const toast = screen.getByRole("status");

    fireEvent.mouseEnter(toast);
    act(() => vi.advanceTimersByTime(TOAST_DWELL_MS.success * 3));
    expect(screen.queryByRole("status")).not.toBeNull();

    fireEvent.mouseLeave(toast);
    act(() => vi.advanceTimersByTime(TOAST_DWELL_MS.success));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("holds while focused", () => {
    render(<ToastViewport />);

    act(() =>
      showToast("Focus me", {
        tone: "success",
        action: { label: "Open", href: "https://example.com" },
      }),
    );
    const link = screen.getByRole("link", { name: "Open" });

    fireEvent.focus(link);
    act(() => vi.advanceTimersByTime(TOAST_DWELL_MS.success * 3));
    expect(screen.queryByRole("status")).not.toBeNull();

    fireEvent.blur(link);
    act(() => vi.advanceTimersByTime(TOAST_DWELL_MS.success));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("dismisses with Escape and the close button", () => {
    render(<ToastViewport />);

    act(() => showToast("Dismiss me", { tone: "notice" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();

    act(() => showToast("Dismiss me too", { tone: "notice" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders an optional action link in a new tab", () => {
    render(<ToastViewport />);

    act(() =>
      showToast("Your ticket is ready", {
        tone: "success",
        action: { label: "View ticket", href: "https://kticket.example.com/tickets" },
      }),
    );

    const link = screen.getByRole("link", { name: "View ticket" });
    expect(link.getAttribute("href")).toBe("https://kticket.example.com/tickets");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
  });
});
