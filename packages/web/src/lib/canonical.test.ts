import { describe, expect, it } from "vitest";
import { canonicalEventUrl } from "./canonical";

const ID = "ab".repeat(32);

describe("canonicalEventUrl (KTK-161)", () => {
  it("builds the same path the server canonicalizes", () => {
    expect(canonicalEventUrl("https://kticket.example.com", ID)).toBe(
      `https://kticket.example.com/events/${ID}`,
    );
  });

  it("normalizes a trailing slash on the origin", () => {
    expect(canonicalEventUrl("https://kticket.example.com/", ID)).toBe(
      `https://kticket.example.com/events/${ID}`,
    );
  });

  it("encodes the covenant id", () => {
    expect(canonicalEventUrl("https://kticket.example.com", "a/b c")).toBe(
      "https://kticket.example.com/events/a%2Fb%20c",
    );
  });
});
