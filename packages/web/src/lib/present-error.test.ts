import { describe, expect, it } from "vitest";
import { ApiError, ServerError } from "../api/client";
import { WalletCanceledError } from "../wallet/cancel";
import {
  GENERIC_ERROR_MESSAGE,
  MISSING_WALLET_MESSAGE,
  SESSION_EXPIRED_MESSAGE,
  WALLET_CANCELED_MESSAGE,
  WALLET_REJECTED_MESSAGE,
  presentError,
} from "./present-error";

describe("presentError (KTK-169)", () => {
  it("relays a safe API policy message", () => {
    const err = new ApiError("sold out — no tickets left", "policy", false);
    expect(presentError(err)).toBe("sold out — no tickets left");
  });

  it("relays a safe API validation message", () => {
    const err = new ApiError("Event does not exist.", "invalid", false);
    expect(presentError(err)).toBe("Event does not exist.");
  });

  it("falls back instead of leaking protocol validation copy", () => {
    const err = new ApiError("request body must be an object", "invalid", false);
    expect(presentError(err, "Couldn't buy the ticket.")).toBe("Couldn't buy the ticket.");
  });

  it("maps every API type with no per-message variation", () => {
    expect(presentError(new ApiError("nope", "unauthorized", false))).toBe(
      SESSION_EXPIRED_MESSAGE,
    );
    expect(presentError(new ApiError("upstream down", "network", false))).toBe(
      "The network is unreachable. Try again in a moment.",
    );
    expect(presentError(new ApiError("rate limited", "upstream", false))).toBe(
      "The network is busy. Try again in a moment.",
    );
    expect(presentError(new ApiError("already spent", "conflict", false))).toBe("already spent");
    expect(presentError(new ApiError("boom", "unknown-internal", true))).toBe(
      GENERIC_ERROR_MESSAGE,
    );
  });

  it("maps a server outage without exposing its message", () => {
    expect(presentError(new ServerError(), "Couldn't load the event.")).toBe(
      "The server isn't responding. Try again in a moment.",
    );
  });

  it("maps a network failure", () => {
    expect(presentError(new TypeError("Failed to fetch"))).toBe(
      "No connection. Check your connection and try again.",
    );
  });

  it("maps wallet failures", () => {
    expect(presentError(new WalletCanceledError())).toBe(WALLET_CANCELED_MESSAGE);
    expect(presentError({ code: 4001, message: "User rejected the request." })).toBe(
      WALLET_REJECTED_MESSAGE,
    );
    expect(presentError(new Error("Kasware wallet not available"))).toBe(
      MISSING_WALLET_MESSAGE,
    );
  });

  it("keeps a user-facing error from our own code", () => {
    expect(presentError(new Error("This ticket is for a different event."))).toBe(
      "This ticket is for a different event.",
    );
  });

  it("falls back for unknown errors and non-Error throws", () => {
    expect(presentError(new Error("boom at handler (src/app.ts:12)"))).toBe(
      GENERIC_ERROR_MESSAGE,
    );
    expect(presentError(new Error("see https://api.example.com/secret"))).toBe(
      GENERIC_ERROR_MESSAGE,
    );
    expect(presentError({ stack: "secret" })).toBe(GENERIC_ERROR_MESSAGE);
    expect(presentError("thrown string")).toBe(GENERIC_ERROR_MESSAGE);
    expect(presentError(null)).toBe(GENERIC_ERROR_MESSAGE);
  });

  it("accepts an envelope shape and rejects a malformed one", () => {
    expect(
      presentError({ error: { type: "policy", message: "You have no ticket for this event." } }),
    ).toBe("You have no ticket for this event.");
    expect(presentError({ error: { type: "invalid", message: "template has no inputs" } })).toBe(
      GENERIC_ERROR_MESSAGE,
    );
    expect(presentError({ error: "nope" })).toBe(GENERIC_ERROR_MESSAGE);
  });

  it("uses the call site's fallback for errors it cannot explain", () => {
    expect(presentError(new Error("ECONNRESET"), { fallback: "Couldn't load tickets." })).toBe(
      "Couldn't load tickets.",
    );
    expect(presentError(undefined, "Couldn't share the link.")).toBe("Couldn't share the link.");
  });
});
