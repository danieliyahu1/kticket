// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchEvent,
  setAuthToken,
  setReauthHandler,
  setSessionExpiredHandler,
} from "./client";

const ADDRESS = "kaspatest:qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszapw00vun";

function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: { type: "unauthorized", message: "You need to sign in.", retryable: false } }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}

const expired = vi.fn();

beforeEach(() => {
  expired.mockReset();
  setAuthToken(null);
  setReauthHandler(null);
  setSessionExpiredHandler(expired);
});

afterEach(() => {
  setAuthToken(null);
  setReauthHandler(null);
  setSessionExpiredHandler(null);
  vi.unstubAllGlobals();
});

describe("session expiry (KTK-168)", () => {
  it("announces a failed re-auth once per token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => unauthorized()));
    setAuthToken("expired-token", ADDRESS);
    setReauthHandler(async () => {
      // Re-auth ended without a new token.
    });

    await expect(fetchEvent("ab".repeat(32))).rejects.toThrow();
    expect(expired).toHaveBeenCalledTimes(1);

    // A second 401 in the same expired session does not queue another message.
    await expect(fetchEvent("ab".repeat(32))).rejects.toThrow();
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("stays silent for a request that never had a session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => unauthorized()));

    await expect(fetchEvent("ab".repeat(32))).rejects.toThrow();
    expect(expired).not.toHaveBeenCalled();
  });
});
