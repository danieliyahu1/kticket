import { describe, expect, it } from "vitest";
import { pollUntil } from "./poll-until";

const FAST_POLL: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number } = {
  maxAttempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 2,
};

describe("pollUntil", () => {
  it("returns the predicate's value as soon as it is produced", async () => {
    let calls = 0;
    const result = await pollUntil(async () => {
      calls += 1;
      return calls >= 2 ? "found" : undefined;
    }, FAST_POLL);
    expect(result).toBe("found");
    expect(calls).toBe(2);
  });

  it("returns undefined when the attempt budget is spent", async () => {
    let calls = 0;
    const result = await pollUntil(async () => {
      calls += 1;
      return undefined;
    }, FAST_POLL);
    expect(result).toBeUndefined();
    expect(calls).toBe(FAST_POLL.maxAttempts + 1);
  });

  it("treats null as 'not yet' and keeps polling until a value appears", async () => {
    let calls = 0;
    const result = await pollUntil(async () => {
      calls += 1;
      return calls >= 3 ? "found" : null;
    }, FAST_POLL);
    expect(result).toBe("found");
    expect(calls).toBe(3);
  });

  it("returns undefined when every attempt yields null", async () => {
    let calls = 0;
    const result = await pollUntil(async () => {
      calls += 1;
      return null;
    }, FAST_POLL);
    expect(result).toBeUndefined();
    expect(calls).toBe(FAST_POLL.maxAttempts + 1);
  });

  it("propagates predicate errors", async () => {
    await expect(
      pollUntil(async () => {
        throw new Error("boom");
      }, FAST_POLL),
    ).rejects.toThrow("boom");
  });
});
