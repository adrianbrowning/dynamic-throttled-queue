import { describe, expect, it } from "vitest";
import { calculateRetryDelay } from "../retry-backoff.ts";

describe("calculateRetryDelay", () => {
  it("uses the base delay for every fixed retry", () => {
    const policy = { strategy: "fixed" as const, baseDelay: 125 };

    expect(calculateRetryDelay(policy, 1)).toBe(125);
    expect(calculateRetryDelay(policy, 3)).toBe(125);
  });

  it("uses one-based retry indices for linear and exponential delays", () => {
    expect(calculateRetryDelay({ strategy: "linear", baseDelay: 125 }, 1)).toBe(125);
    expect(calculateRetryDelay({ strategy: "linear", baseDelay: 125 }, 3)).toBe(375);
    expect(calculateRetryDelay({ strategy: "exponential", baseDelay: 125 }, 1)).toBe(125);
    expect(calculateRetryDelay({ strategy: "exponential", baseDelay: 125 }, 3)).toBe(500);
  });

  it("caps the calculated and jittered delay at maxDelay", () => {
    const policy = {
      strategy: "exponential" as const,
      baseDelay: 100,
      maxDelay: 500,
      jitter: 0.5,
    };

    expect(calculateRetryDelay({ ...policy, random: () => 0 }, 4)).toBe(250);
    expect(calculateRetryDelay({ ...policy, random: () => 1 }, 4)).toBe(500);
  });

  it("falls back to the capped delay when its random source is invalid", () => {
    const policy = { strategy: "linear" as const, baseDelay: 200, maxDelay: 300, jitter: 0.5 };

    expect(calculateRetryDelay({ ...policy, random: () => { throw new Error("unavailable"); } }, 2)).toBe(300);
    expect(calculateRetryDelay({ ...policy, random: () => Number.NaN }, 2)).toBe(300);
    expect(calculateRetryDelay({ ...policy, random: () => -0.1 }, 2)).toBe(300);
    expect(calculateRetryDelay({ ...policy, random: () => 1.1 }, 2)).toBe(300);
  });
});
