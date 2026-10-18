// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./share";

function installClipboard(value: unknown): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value,
  });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("copyText (KTK-161)", () => {
  it("writes through the Clipboard API", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard({ writeText });

    await copyText("https://kticket.example.com/events/abc");

    expect(writeText).toHaveBeenCalledWith("https://kticket.example.com/events/abc");
  });

  it("rejects when the browser denies clipboard access", async () => {
    installClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });

    await expect(copyText("https://kticket.example.com/events/abc")).rejects.toThrow("denied");
  });

  it("rejects when the Clipboard API is absent", async () => {
    await expect(copyText("https://kticket.example.com/events/abc")).rejects.toThrow(
      "Clipboard access is unavailable.",
    );
  });
});
