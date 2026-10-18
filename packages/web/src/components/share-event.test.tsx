// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalEventUrl } from "../lib/canonical";
import { ShareEventButton } from "./share-event";
import { dismissToast, getToast } from "./toast-store";

const COVENANT_ID = "ab".repeat(32);

function installClipboard(writeText: () => Promise<void>): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

beforeEach(() => {
  dismissToast();
});

afterEach(() => {
  cleanup();
  dismissToast();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("ShareEventButton (KTK-161)", () => {
  it("copies the canonical event URL and confirms through the toast channel", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);
    render(<ShareEventButton covenantId={COVENANT_ID} />);

    fireEvent.click(screen.getByRole("button", { name: "Share event" }));

    await waitFor(() => expect(getToast()?.tone).toBe("success"));
    expect(writeText).toHaveBeenCalledWith(
      canonicalEventUrl(window.location.origin, COVENANT_ID),
    );
    expect(screen.queryByLabelText("Event link")).toBeNull();
  });

  it("shows a selectable link when the clipboard is denied", async () => {
    installClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    render(<ShareEventButton covenantId={COVENANT_ID} />);

    fireEvent.click(screen.getByRole("button", { name: "Share event" }));

    const input = await screen.findByLabelText("Event link");
    expect((input as HTMLInputElement).value).toBe(
      canonicalEventUrl(window.location.origin, COVENANT_ID),
    );
    expect(getToast()?.tone).toBe("error");
    expect(getToast()?.message).toContain("Select it");
  });

  it("falls back to the selectable link when the Clipboard API is absent", async () => {
    render(<ShareEventButton covenantId={COVENANT_ID} />);

    fireEvent.click(screen.getByRole("button", { name: "Share event" }));

    const input = await screen.findByLabelText("Event link");
    expect((input as HTMLInputElement).value).toBe(
      canonicalEventUrl(window.location.origin, COVENANT_ID),
    );
    expect(getToast()?.tone).toBe("error");
  });
});
