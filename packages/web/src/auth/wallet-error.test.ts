import { describe, expect, it } from "vitest";
import { codeOf, isUserRejected, reasonOf } from "./wallet-error";

describe("isUserRejected", () => {
  it("detects the EIP-1193 cancel code Kasware sends on Reject", () => {
    expect(isUserRejected({ code: 4001, message: "User rejected the request." })).toBe(true);
  });

  it("detects the 'User Cancel' message Kasware sends when the popup closes", () => {
    expect(isUserRejected({ code: undefined, message: "User Cancel" })).toBe(true);
  });

  it("does not treat a missing wallet as a cancel", () => {
    expect(isUserRejected(new Error("Kasware wallet not available"))).toBe(false);
  });

  it("does not treat a plain server error as a cancel", () => {
    expect(isUserRejected(new Error("The signature does not match this wallet"))).toBe(false);
  });

  it("handles non-object throwables", () => {
    expect(isUserRejected(undefined)).toBe(false);
    expect(isUserRejected(null)).toBe(false);
    expect(isUserRejected("User Cancel")).toBe(false);
  });
});

describe("reasonOf", () => {
  it("reads an Error message", () => {
    expect(reasonOf(new Error("boom"))).toBe("boom");
  });

  it("reads a serialized RPC error message from a plain object", () => {
    expect(reasonOf({ code: 4001, message: "User rejected the request." })).toBe(
      "User rejected the request.",
    );
  });

  it("falls back to the type for primitives", () => {
    expect(reasonOf("nope")).toBe("string");
  });
});

describe("codeOf", () => {
  it("reads a numeric RPC code", () => {
    expect(codeOf({ code: 4001 })).toBe(4001);
  });

  it("returns undefined when there is no code", () => {
    expect(codeOf(new Error("boom"))).toBeUndefined();
    expect(codeOf(undefined)).toBeUndefined();
  });
});
