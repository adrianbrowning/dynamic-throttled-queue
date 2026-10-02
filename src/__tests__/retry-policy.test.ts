import { describe, expect, it } from "vitest";
import type { RateFailureOutcome } from "../dynamic-throttled-queue.ts";
import { createRetryPolicy } from "../retry-policy.ts";
import type { RetryBackoff } from "../retry-policy.ts";

const returnedFalse: RateFailureOutcome = { kind: "returned-false" };

function delays(retryBackoff: RetryBackoff, attempts: Array<number>) {
  const policy = createRetryPolicy({ retry: Math.max(...attempts), retryBackoff });
  return attempts.map(attempt => policy.decide(returnedFalse, attempt)?.delay);
}

describe("createRetryPolicy validation", () => {
  it("accepts zero retries and rejects invalid retry counts", () => {
    expect(() => createRetryPolicy({ retry: 0 })).not.toThrow();

    for (const retry of [ -1, 1.5, Number.NaN, Infinity, -Infinity ]) {
      expect(() => createRetryPolicy({ retry })).toThrow("retry must be a non-negative integer");
    }
  });

  it("accepts fractional retry delays and rejects invalid retry-backoff policies", () => {
    expect(() => createRetryPolicy({ retryBackoff: { strategy: "fixed", baseDelay: 0.5, maxDelay: 0.5 } })).not.toThrow();

    for (const [ retryBackoff, message ] of [
      [{ strategy: "fixed", baseDelay: -1 }, "retryBackoff.baseDelay" ],
      [{ strategy: "fixed", baseDelay: Number.NaN }, "retryBackoff.baseDelay" ],
      [{ strategy: "fixed", baseDelay: Infinity }, "retryBackoff.baseDelay" ],
      [{ strategy: "fixed", baseDelay: 1, maxDelay: -1 }, "retryBackoff.maxDelay" ],
      [{ strategy: "fixed", baseDelay: 1, maxDelay: Number.NaN }, "retryBackoff.maxDelay" ],
      [{ strategy: "fixed", baseDelay: 1, jitter: -0.1 }, "retryBackoff.jitter" ],
      [{ strategy: "fixed", baseDelay: 1, jitter: 1.1 }, "retryBackoff.jitter" ],
      [{ strategy: "fixed", baseDelay: 1, jitter: Infinity }, "retryBackoff.jitter" ],
    ] satisfies Array<[RetryBackoff, string]>) {
      expect(() => createRetryPolicy({ retryBackoff })).toThrow(message);
    }
  });

  it("rejects an unknown backoff strategy instead of falling back to a fixed delay", () => {
    for (const strategy of [ "Exponential", "constant", "" ]) {
      const retryBackoff = { strategy, baseDelay: 100 } as unknown as RetryBackoff;
      expect(() => createRetryPolicy({ retry: 1, retryBackoff }))
        .toThrow("retryBackoff.strategy must be fixed, linear, or exponential");
    }
  });
});

describe("retry budget", () => {
  it("retries each failed attempt until the configured retries are used", () => {
    const policy = createRetryPolicy({ retry: 2 });

    expect(policy.decide(returnedFalse, 1)).toBeDefined();
    expect(policy.decide(returnedFalse, 2)).toBeDefined();
    expect(policy.decide(returnedFalse, 3)).toBeUndefined();
  });

  it("drops every failure when retry is omitted", () => {
    expect(createRetryPolicy({}).decide(returnedFalse, 1)).toBeUndefined();
  });
});

describe("retry classifier", () => {
  it("receives the normalized outcome and one-based attempt number", () => {
    const calls: Array<unknown> = [];
    const rejected: RateFailureOutcome = { kind: "rejected", error: new Error("rejected") };
    const policy = createRetryPolicy({
      retry: 2,
      retryClassifier: (outcome, attempt) => {
        calls.push({ outcome, attempt });
        return true;
      },
    });

    policy.decide(returnedFalse, 1);
    policy.decide(rejected, 2);

    expect(calls).toEqual([
      { outcome: returnedFalse, attempt: 1 },
      { outcome: rejected, attempt: 2 },
    ]);
  });

  it("makes a failure permanent unless the classifier returns literal true", () => {
    for (const result of [ false, 1, "true", undefined ]) {
      const policy = createRetryPolicy({ retry: 1, retryClassifier: () => result as boolean });
      expect(policy.decide(returnedFalse, 1)).toBeUndefined();
    }
  });

  it("retries within the budget when the classifier throws", () => {
    const policy = createRetryPolicy({ retry: 1, retryClassifier: () => { throw new Error("classifier failed"); } });

    expect(policy.decide(returnedFalse, 1)).toBeDefined();
    expect(policy.decide(returnedFalse, 2)).toBeUndefined();
  });

  it("is not consulted once the retry budget is exhausted", () => {
    let calls = 0;
    const policy = createRetryPolicy({ retry: 1, retryClassifier: () => { calls++; return true; } });

    policy.decide(returnedFalse, 2);

    expect(calls).toBe(0);
  });
});

describe("retry timing", () => {
  it("retries immediately without a backoff policy", () => {
    expect(createRetryPolicy({ retry: 1 }).decide(returnedFalse, 1)).toStrictEqual({});
  });

  it("keeps a zero-millisecond backoff distinct from an immediate retry", () => {
    const policy = createRetryPolicy({ retry: 1, retryBackoff: { strategy: "fixed", baseDelay: 0 } });

    expect(policy.decide(returnedFalse, 1)).toStrictEqual({ delay: 0 });
  });

  it("uses the base delay for every fixed retry", () => {
    expect(delays({ strategy: "fixed", baseDelay: 125 }, [ 1, 3 ])).toEqual([ 125, 125 ]);
  });

  it("uses the failed attempt number as the linear and exponential retry index", () => {
    expect(delays({ strategy: "linear", baseDelay: 125 }, [ 1, 3 ])).toEqual([ 125, 375 ]);
    expect(delays({ strategy: "exponential", baseDelay: 125 }, [ 1, 3 ])).toEqual([ 125, 500 ]);
  });

  it("caps the calculated and jittered delay at maxDelay", () => {
    const policy = { strategy: "exponential" as const, baseDelay: 100, maxDelay: 500, jitter: 0.5 };

    expect(delays({ ...policy, random: () => 0 }, [ 4 ])).toEqual([ 250 ]);
    expect(delays({ ...policy, random: () => 1 }, [ 4 ])).toEqual([ 500 ]);
  });

  it("falls back to the capped delay when its random source is invalid", () => {
    const policy = { strategy: "linear" as const, baseDelay: 200, maxDelay: 300, jitter: 0.5 };

    for (const random of [ () => { throw new Error("unavailable"); }, () => Number.NaN, () => -0.1, () => 1.1 ]) {
      expect(delays({ ...policy, random }, [ 2 ])).toEqual([ 300 ]);
    }
  });
});
