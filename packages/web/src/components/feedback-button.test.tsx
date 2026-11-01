// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { submitFeedback } from "../api/client";
import {
  FEEDBACK_BUTTON_LABEL,
  FEEDBACK_DELIVERED_MESSAGE,
  FEEDBACK_QUEUED_MESSAGE,
  FEEDBACK_REQUIRED_MESSAGE,
  FeedbackButton,
} from "./feedback-button";
import { ToastViewport } from "./toast";
import { dismissToast, getToast } from "./toast-store";

vi.mock("../api/client", () => ({ submitFeedback: vi.fn() }));

function renderFeedback() {
  return render(
    <>
      <FeedbackButton />
      <ToastViewport />
    </>,
  );
}

function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: FEEDBACK_BUTTON_LABEL }));
  return screen.getByRole("dialog");
}

function write(message: string) {
  fireEvent.change(screen.getByLabelText("Your message"), { target: { value: message } });
}

beforeEach(() => {
  dismissToast();
  vi.mocked(submitFeedback).mockReset();
});

afterEach(() => {
  cleanup();
  dismissToast();
});

describe("FeedbackButton", () => {
  it("opens an anonymous dialog and asks for a message before sending", () => {
    renderFeedback();
    const dialog = openDialog();

    expect(dialog.getAttribute("aria-modal")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.getByRole("alert").textContent).toBe(FEEDBACK_REQUIRED_MESSAGE);
    expect(submitFeedback).not.toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    renderFeedback();
    openDialog();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("confirms a delivered note", async () => {
    vi.mocked(submitFeedback).mockResolvedValue({ accepted: true, delivered: true });
    renderFeedback();
    openDialog();
    write("  Nice app  ");

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(getToast()?.message).toBe(FEEDBACK_DELIVERED_MESSAGE));
    expect(submitFeedback).toHaveBeenCalledWith("Nice app");
    expect(getToast()?.tone).toBe("success");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not claim a queued note was sent", async () => {
    vi.mocked(submitFeedback).mockResolvedValue({ accepted: true, delivered: false });
    renderFeedback();
    openDialog();
    write("Saved for later");

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(getToast()?.message).toBe(FEEDBACK_QUEUED_MESSAGE));
    expect(getToast()?.message.toLowerCase()).not.toContain("sent");
    expect(getToast()?.tone).toBe("notice");
  });

  it("shows the server's message and lets the visitor retry", async () => {
    vi.mocked(submitFeedback).mockRejectedValue(new Error("Too many submissions; try again later"));
    renderFeedback();
    openDialog();
    write("One more");

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Too many submissions");
    expect(screen.queryByRole("dialog")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(2));
  });
});
