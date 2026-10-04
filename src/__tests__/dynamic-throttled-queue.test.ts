import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createThrottledQueue } from "../dynamic-throttled-queue.ts";
import type { RateStrategy } from "../dynamic-throttled-queue.ts";

function deferred() {
  let settle!: () => void;
  const promise = new Promise<void>(resolve => { settle = resolve; });
  return { promise, resolve: settle };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createThrottledQueue", () => {
  describe("input validation", () => {
    it("throws if min_rpi is not a positive integer", () => {
      expect(() => createThrottledQueue({ min_rpi: 0, interval: 1000 })).toThrow("min_rpi");
      expect(() => createThrottledQueue({ min_rpi: 1.5, interval: 1000 })).toThrow("min_rpi");
      expect(() => createThrottledQueue({ min_rpi: -1, interval: 1000 })).toThrow("min_rpi");
    });

    it("throws if max_rpi < min_rpi", () => {
      expect(() => createThrottledQueue({ min_rpi: 5, max_rpi: 2, interval: 1000 })).toThrow("max_rpi");
    });

    it("throws if interval is not positive", () => {
      expect(() => createThrottledQueue({ min_rpi: 1, interval: 0 })).toThrow("interval");
      expect(() => createThrottledQueue({ min_rpi: 1, interval: -100 })).toThrow("interval");
    });

    it("throws if concurrency is not a positive integer", () => {
      expect(() => createThrottledQueue({ min_rpi: 1, interval: 1000, concurrency: 0 })).toThrow("concurrency");
      expect(() => createThrottledQueue({ min_rpi: 1, interval: 1000, concurrency: 1.5 })).toThrow("concurrency");
      expect(() => createThrottledQueue({ min_rpi: 1, interval: 1000, concurrency: -1 })).toThrow("concurrency");
    });

    it("rejects invalid retry counts at queue creation", () => {
      expect(() => createThrottledQueue({ min_rpi: 1, interval: 1000, retry: -1 })).toThrow("retry");
    });

    it("uses the default error threshold and rejects invalid thresholds", () => {
      expect(() => createThrottledQueue({ min_rpi: 1, interval: 1000 })).not.toThrow();

      for (const errors_per_interval of [ 0, -1, 1.5, NaN, Infinity, -Infinity ]) {
        expect(() => createThrottledQueue({ min_rpi: 1, interval: 1000, errors_per_interval })).toThrow("errors_per_interval");
      }
    });

    it("accepts zero compaction threshold and rejects invalid thresholds", () => {
      expect(() => createThrottledQueue({ min_rpi: 1, interval: 1000, compact_threshold: 0 })).not.toThrow();

      for (const compact_threshold of [ -1, 1.5, NaN, Infinity, -Infinity ]) {
        expect(() => createThrottledQueue({ min_rpi: 1, interval: 1000, compact_threshold })).toThrow("compact_threshold");
      }
    });

    it("rejects invalid retry-backoff policies at queue creation", () => {
      const retryBackoff = { strategy: "fixed" as const, baseDelay: -1 };
      expect(() => createThrottledQueue({ min_rpi: 1, interval: 1000, retryBackoff })).toThrow("retryBackoff");
    });

    it("accepts zero capacity and rejects invalid capacity limits", () => {
      expect(() => createThrottledQueue({ min_rpi: 1, interval: 1000, maxQueueSize: 0 })).not.toThrow();

      for (const maxQueueSize of [ -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1 ]) {
        expect(() => createThrottledQueue({ min_rpi: 1, interval: 1000, maxQueueSize })).toThrow("maxQueueSize");
      }
    });

  });
  describe("basic throttling", () => {
    it("executes all queued callbacks", () => {
      const throttle = createThrottledQueue({ min_rpi: 1, interval: 1000 });
      let count = 0;
      for (let i = 0; i < 10; i++) {
        throttle(() => { count++; });
      }

      vi.advanceTimersByTime(10_000);
      expect(count).toBe(10);
    });

    it("respects rate limit with evenly_spaced (default)", () => {
      const throttle = createThrottledQueue({ min_rpi: 2, interval: 1000 });
      let count = 0;
      for (let i = 0; i < 10; i++) {
        throttle(() => { count++; });
      }

      // evenly_spaced: interval/rpi = 500ms per request
      vi.advanceTimersByTime(500);
      expect(count).toBe(1);
      vi.advanceTimersByTime(500);
      expect(count).toBe(2);
      vi.advanceTimersByTime(4000);
      expect(count).toBe(10);
    });

    it("respects rate limit with evenly_spaced: false (batch mode)", () => {
      const throttle = createThrottledQueue({ min_rpi: 3, interval: 1000, evenly_spaced: false });
      let count = 0;
      for (let i = 0; i < 9; i++) {
        throttle(() => { count++; });
      }

      vi.advanceTimersByTime(1000);
      expect(count).toBe(3);
      vi.advanceTimersByTime(1000);
      expect(count).toBe(6);
      vi.advanceTimersByTime(1000);
      expect(count).toBe(9);
    });
  });

  describe("queue capacity", () => {
    it("rejects enqueue synchronously when all capacity reservations are occupied", () => {
      const throttle = createThrottledQueue({ min_rpi: 1, interval: 1000, maxQueueSize: 1 });

      throttle(() => {});

      expect(() => throttle(() => {})).toThrow("maxQueueSize");
    });

    it("rejects every enqueue when capacity is zero", () => {
      const throttle = createThrottledQueue({ min_rpi: 1, interval: 1000, maxQueueSize: 0 });

      expect(() => throttle(() => {})).toThrow("maxQueueSize");
    });

    it("releases capacity after an active callback settles", async () => {
      const throttle = createThrottledQueue({
        min_rpi: 1,
        interval: 1000,
        maxQueueSize: 1,
      });
      const first = deferred();

      throttle(async () => first.promise);
      await vi.advanceTimersByTimeAsync(1000);
      expect(() => throttle(() => {})).toThrow("maxQueueSize");

      first.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(() => throttle(() => {})).not.toThrow();
    });

    it("releases capacity after a final failed callback", () => {
      const throttle = createThrottledQueue({ min_rpi: 1, interval: 1000, maxQueueSize: 1 });

      throttle(() => false);
      vi.advanceTimersByTime(1000);

      expect(() => throttle(() => {})).not.toThrow();
    });

    it("retains the original reservation until a retried callback succeeds", () => {
      const throttle = createThrottledQueue({
        min_rpi: 1,
        interval: 1000,
        maxQueueSize: 1,
        retry: 1,
      });
      let attempts = 0;

      throttle(() => {
        attempts++;
        return attempts === 1 ? false : undefined;
      });
      vi.advanceTimersByTime(1000);
      expect(() => throttle(() => {})).toThrow("maxQueueSize");

      vi.advanceTimersByTime(1000);

      expect(() => throttle(() => {})).not.toThrow();
    });

    it("no longer counts a settling callback as active, but holds its reservation, while its retry is decided", () => {
      const seen: Array<{ active: number; admitted: boolean; }> = [];
      const throttle = createThrottledQueue({
        min_rpi: 1,
        interval: 1000,
        maxQueueSize: 1,
        retry: 1,
        retryClassifier: () => {
          let admitted = true;
          try {
            throttle(() => {});
          }
          catch {
            admitted = false;
          }
          seen.push({ active: throttle.getState().active, admitted });
          return true;
        },
      });

      throttle(() => false);
      vi.advanceTimersByTime(1000);

      expect(seen).toEqual([{ active: 0, admitted: false }]);
      expect(throttle.getState().pending).toBe(1);
    });

    it.each([ "pause", "stop" ] as const)("retains reservations while the queue is $state", state => {
      const throttle = createThrottledQueue({ min_rpi: 1, interval: 1000, maxQueueSize: 1 });

      throttle(() => {});
      throttle[state]();

      expect(() => throttle(() => {})).toThrow("maxQueueSize");
    });

    it("keeps the unlimited admission behavior when capacity is omitted", () => {
      const throttle = createThrottledQueue({ min_rpi: 1, interval: 1000 });

      for (let i = 0; i < 100; i++) throttle(() => {});

      expect(throttle.getState().pending).toBe(100);
    });
  });

  describe("FIFO and exactly-once delivery", () => {
    it("drains callbacks in enqueue order exactly once", () => {
      const throttle = createThrottledQueue({ min_rpi: 1, interval: 1000 });
      const expectedIds = [ "first", "second", "third", "fourth" ];
      const executedIds: Array<string> = [];

      for (const id of expectedIds) {
        throttle(() => { executedIds.push(id); });
      }

      vi.advanceTimersByTime(4000);

      expect(executedIds).toEqual(expectedIds);
      expect(executedIds).toHaveLength(expectedIds.length);
      expect(new Set(executedIds)).toHaveLength(expectedIds.length);
    });
  });

  it("preserves callback order across evenly spaced starts", () => {
    const throttle = createThrottledQueue({ min_rpi: 2, interval: 1000 });
    const expectedIds = [ "first", "second", "third", "fourth", "fifth" ];
    const executedIds: Array<string> = [];

    for (const id of expectedIds) {
      throttle(() => { executedIds.push(id); });
    }

    vi.advanceTimersByTime(500);
    expect(executedIds).toEqual([ "first" ]);
    vi.advanceTimersByTime(2000);

    expect(executedIds).toEqual(expectedIds);
    expect(executedIds).toHaveLength(expectedIds.length);
    expect(new Set(executedIds)).toHaveLength(expectedIds.length);
  });

  describe("concurrency", () => {
    it("preserves callback order across batch starts", () => {
      const throttle = createThrottledQueue({ min_rpi: 3, interval: 1000, evenly_spaced: false });
      const expectedIds = [ "first", "second", "third", "fourth", "fifth" ];
      const executedIds: Array<string> = [];

      for (const id of expectedIds) {
        throttle(() => { executedIds.push(id); });
      }

      vi.advanceTimersByTime(1000);
      expect(executedIds).toEqual([ "first", "second", "third" ]);
      vi.advanceTimersByTime(1000);

      expect(executedIds).toEqual(expectedIds);
      expect(executedIds).toHaveLength(expectedIds.length);
      expect(new Set(executedIds)).toHaveLength(expectedIds.length);
    });

    it("delivers retained callbacks before newly enqueued work after stop", () => {
      const throttle = createThrottledQueue({ min_rpi: 5, interval: 1000, evenly_spaced: false });
      const expectedIds = [ "first", "second", "third", "fourth" ];
      const executedIds: Array<string> = [];

      for (const id of expectedIds.slice(0, 3)) {
        throttle(() => { executedIds.push(id); });
      }

      vi.advanceTimersByTime(500);
      throttle.stop();
      throttle(() => { executedIds.push(expectedIds[3]!); });
      vi.advanceTimersByTime(1000);

      expect(executedIds).toEqual(expectedIds);
      expect(executedIds).toHaveLength(expectedIds.length);
      expect(new Set(executedIds)).toHaveLength(expectedIds.length);
    });

    it("limits slow asynchronous callbacks to the configured number of slots", async () => {
      const throttle = createThrottledQueue({
        min_rpi: 5,
        interval: 1000,
        evenly_spaced: false,
        concurrency: 2,
      });
      const work = Array.from({ length: 4 }, deferred);
      let started = 0;
      let active = 0;

      for (const item of work) {
        throttle(async () => {
          started++;
          active++;
          return item.promise.then(() => { active--; return undefined; });
        });
      }

      await vi.advanceTimersByTimeAsync(1000);

      expect(started).toBe(2);
      expect(active).toBe(2);
    });
  });

  describe("concurrency scheduling", () => {
    it("does not consume a paced start while its only slot is full", async () => {
      const throttle = createThrottledQueue({ min_rpi: 2, interval: 1000, concurrency: 1 });
      const first = deferred();
      let started = 0;

      throttle(async () => { started++; return first.promise; });
      throttle(() => { started++; });

      await vi.advanceTimersByTimeAsync(1000);
      expect(started).toBe(1);

      first.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(started).toBe(2);
    });

    it("releases a slot after a rejected callback", async () => {
      const throttle = createThrottledQueue({ min_rpi: 2, interval: 1000, concurrency: 1 });
      let rejectCallback!: (reason?: unknown) => void;
      const first = new Promise<void>((_resolve, reject) => { rejectCallback = reject; });
      let started = 0;

      throttle(async () => { started++; return first; });
      throttle(() => { started++; });

      await vi.advanceTimersByTimeAsync(1000);
      expect(started).toBe(1);

      rejectCallback(new Error("failed"));
      await vi.advanceTimersByTimeAsync(0);
      expect(started).toBe(2);
    });
  });

  describe("concurrency compatibility", () => {
    it("keeps the existing unlimited in-flight behavior when concurrency is omitted", async () => {
      const throttle = createThrottledQueue({ min_rpi: 5, interval: 1000, evenly_spaced: false });
      const work = Array.from({ length: 4 }, deferred);
      let started = 0;

      for (const item of work) {
        throttle(async () => { started++; return item.promise; });
      }

      await vi.advanceTimersByTimeAsync(1000);
      expect(started).toBe(4);
    });

    it("makes a retry wait for a new paced start and a free slot", async () => {
      const throttle = createThrottledQueue({
        min_rpi: 5,
        interval: 1000,
        evenly_spaced: false,
        concurrency: 1,
        retry: 1,
      });
      let resolveFirst!: (value: boolean) => void;
      const first = new Promise<boolean>(resolve => { resolveFirst = resolve; });
      let attempts = 0;
      let active = 0;
      let maxActive = 0;

      throttle(async () => {
        attempts++;
        active++;
        maxActive = Math.max(maxActive, active);
        if (attempts === 1) {
          return first.then(value => { active--; return value; });
        }
        active--;
        return undefined;
      });

      await vi.advanceTimersByTimeAsync(1000);
      resolveFirst(false);
      await first;
      await Promise.resolve();
      expect(attempts).toBe(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(attempts).toBe(2);
      expect(maxActive).toBe(1);
    });
  });

  describe("concurrency and backoff", () => {
    it("does not let slot release bypass an active backoff pause", async () => {
      const throttle = createThrottledQueue({
        min_rpi: 1,
        max_rpi: 2,
        interval: 1000,
        evenly_spaced: false,
        errors_per_interval: 1,
        back_off: true,
        concurrency: 1,
      });
      const second = deferred();
      let started = 0;

      throttle(() => { started++; return false; });
      throttle(async () => { started++; return second.promise; });
      throttle(() => { started++; });

      await vi.advanceTimersByTimeAsync(1000);
      expect(started).toBe(2);

      second.resolve();
      await vi.advanceTimersByTimeAsync(1000);
      expect(started).toBe(2);
    });
  });

  describe("dynamic rate adjustment", () => {
    describe("adjustment timing", () => {
      it("waits for a settled window's slow failure before adjusting the rate", async () => {
        const rates: Array<number> = [];
        const started: Array<string> = [];
        const throttle = createThrottledQueue({
          min_rpi: 1,
          max_rpi: 3,
          interval: 1000,
          evenly_spaced: false,
          errors_per_interval: 1,
          adjustmentTiming: "settled",
          rateStrategy: observation => ({
            nextRate: observation.errorCount > 0 ? observation.currentRate - 1 : observation.currentRate,
            shouldBackOff: false,
          }),
          onRateChange: rate => rates.push(rate),
        });

        throttle(async () => new Promise<boolean>(resolve => {
          started.push("slow");
          setTimeout(() => resolve(false), 500);
        }));
        throttle(() => { started.push("fast"); });
        throttle(() => { started.push("next-window"); });

        await vi.advanceTimersByTimeAsync(1000);
        expect(rates).toEqual([]);
        expect(started).toEqual([ "slow", "fast" ]);

        await vi.advanceTimersByTimeAsync(500);
        expect(rates).toEqual([ 1 ]);
        expect(started).toEqual([ "slow", "fast" ]);
      });

      it("makes no settled decision while a discarded window's callback holds the only slot, then starts and decides queued work", async () => {
        const strategy = vi.fn<RateStrategy>(({ currentRate }) => ({ nextRate: currentRate, shouldBackOff: false }));
        const throttle = createThrottledQueue({
          min_rpi: 1,
          max_rpi: 5,
          interval: 1000,
          concurrency: 1,
          adjustmentTiming: "settled",
          rateStrategy: strategy,
        });
        const held = deferred();
        const started: Array<number> = [];

        throttle(async () => held.promise);
        for (let i = 0; i < 3; i++) throttle(() => { started.push(i); });
        await vi.advanceTimersByTimeAsync(500);
        throttle.pause();
        throttle.resume();

        await vi.advanceTimersByTimeAsync(3000);
        expect(strategy).not.toHaveBeenCalled();
        expect(started).toEqual([]);

        held.resolve();
        await vi.advanceTimersByTimeAsync(2000);
        expect(started).toEqual([ 0, 1, 2 ]);
        expect(strategy).toHaveBeenCalled();
        expect(strategy.mock.calls.every(([ observation ]) => observation.errorCount === 0)).toBe(true);
        expect(throttle.getState()).toMatchObject({ state: "running", pending: 0, active: 0 });
      });
    });

    it("lets a classifier exclude every normalized failure kind", async () => {
      const thrown = new Error("thrown failure");
      const rejected = new Error("rejected failure");
      const outcomes: Array<unknown> = [];
      const rates: Array<number> = [];
      const throttle = createThrottledQueue({
        min_rpi: 1,
        max_rpi: 5,
        interval: 1000,
        evenly_spaced: false,
        errors_per_interval: 1,
        rateOutcomeClassifier: outcome => {
          outcomes.push(outcome);
          return false;
        },
        onRateChange: rate => rates.push(rate),
      });

      throttle(() => false);
      throttle(() => { throw thrown; });
      throttle(async () => { throw rejected; });
      throttle(() => {});
      throttle(() => {});
      await vi.advanceTimersByTimeAsync(1000);

      expect(outcomes).toEqual([
        { kind: "returned-false" },
        { kind: "thrown", error: thrown },
        { kind: "rejected", error: rejected },
      ]);
      expect(rates).toEqual([ 4 ]);
    });

    it("fails the queue when a custom strategy throws: rethrows once, discards pending work, rejects idle waiters", async () => {
      const failure = new Error("strategy failed");
      const throttle = createThrottledQueue({
        min_rpi: 1,
        max_rpi: 2,
        interval: 1000,
        evenly_spaced: false,
        retry: 1,
        retryBackoff: { strategy: "fixed", baseDelay: 5000 },
        rateStrategy: () => { throw failure; },
      });
      let started = 0;

      throttle(() => { started++; return false; });
      for (let i = 0; i < 2; i++) throttle(() => { started++; });
      const idle = throttle.waitForIdle();

      expect(() => vi.advanceTimersByTime(1000)).toThrow(failure);
      await expect(idle).rejects.toBe(failure);
      await expect(throttle.waitForIdle()).rejects.toBe(failure);
      expect(throttle.getState()).toMatchObject({ state: "failed", pending: 0, active: 0 });
      expect(vi.getTimerCount()).toBe(0);
      expect(() => throttle(() => { started++; })).toThrow(failure);

      throttle.resume();
      throttle.stop();
      throttle.abort();
      expect(throttle.getState().state).toBe("failed");
      vi.advanceTimersByTime(10_000);
      expect(started).toBe(2);
    });

    it("rejects idle waiters on strategy failure without waiting for active callbacks, then ignores their settlement", async () => {
      const failure = new Error("strategy failed");
      const throttle = createThrottledQueue({
        min_rpi: 1,
        max_rpi: 2,
        interval: 1000,
        evenly_spaced: false,
        concurrency: 1,
        retry: 1,
        rateStrategy: () => { throw failure; },
      });
      const active = deferred();
      let started = 0;

      throttle(async () => { started++; await active.promise; return false; });
      throttle(() => { started++; });
      const idle = throttle.waitForIdle();

      expect(() => vi.advanceTimersByTime(1000)).toThrow(failure);
      expect(throttle.getState()).toMatchObject({ state: "failed", active: 1 });
      await expect(idle).rejects.toBe(failure);

      active.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(throttle.getState()).toMatchObject({ state: "failed", active: 0, pending: 0, failed: 0, retried: 0 });
      expect(started).toBe(1);
    });

    it("resolves idle waiters when the queue drains before a settled window's strategy fails", async () => {
      const failure = new Error("strategy failed");
      const throttle = createThrottledQueue({
        min_rpi: 1,
        interval: 1000,
        adjustmentTiming: "settled",
        rateStrategy: () => { throw failure; },
      });

      throttle(() => {});
      const idle = throttle.waitForIdle();

      expect(() => vi.advanceTimersByTime(1000)).toThrow(failure);
      await expect(idle).resolves.toBeUndefined();
      expect(throttle.getState()).toMatchObject({ state: "failed", active: 0, pending: 0 });
    });
  });

  describe("backoff", () => {
    it("runs work before a full pause, then resumes after it", () => {
      const throttle = createThrottledQueue({
        min_rpi: 1,
        max_rpi: 5,
        interval: 1000,
        errors_per_interval: 1,
        back_off: true,
        evenly_spaced: false,
      });

      const startedAt = Date.now();
      const starts: Array<number> = [];
      for (let i = 0; i < 5; i++) {
        throttle(() => {
          starts.push(Date.now() - startedAt);
          return i === 0 ? false : undefined;
        });
      }

      vi.advanceTimersByTime(1000);
      expect(starts).toEqual([ 1000, 1000, 1000 ]);

      vi.advanceTimersByTime(1999);
      expect(starts).toEqual([ 1000, 1000, 1000 ]);

      vi.advanceTimersByTime(1);
      expect(starts).toEqual([ 1000, 1000, 1000, 3000, 3000 ]);
    });
  });

  describe("retry", () => {
    it("uses retryClassifier to retry returned false with a one-based attempt number", () => {
      const classifications: Array<unknown> = [];
      const throttle = createThrottledQueue({
        min_rpi: 5,
        interval: 1000,
        evenly_spaced: false,
        retry: 1,
        retryClassifier: (outcome, attempt) => {
          classifications.push({ outcome, attempt });
          return true;
        },
      });
      let callCount = 0;

      throttle(() => { callCount++; return false; });
      vi.advanceTimersByTime(3000);

      expect(classifications).toEqual([
        { outcome: { kind: "returned-false" }, attempt: 1 },
      ]);
      expect(callCount).toBe(2);
    });

    it.each([
      {
        name: "returned false",
        callback: (onStart: () => void) => () => { onStart(); return false; },
        outcome: { kind: "returned-false" },
      },
      {
        name: "a thrown error",
        callback: (onStart: () => void) => () => {
          onStart();
          throw new Error("thrown failure");
        },
        outcome: { kind: "thrown", error: expect.any(Error) },
      },
      {
        name: "a rejected promise",
        callback: (onStart: () => void) => async () => {
          onStart();
          throw new Error("rejected failure");
        },
        outcome: { kind: "rejected", error: expect.any(Error) },
      },
    ])("does not retry $name when retryClassifier returns a non-true value", async ({ callback, outcome }) => {
      const classifications: Array<unknown> = [];
      const throttle = createThrottledQueue({
        min_rpi: 5,
        interval: 1000,
        evenly_spaced: false,
        retry: 1,
        retryClassifier: classified => {
          classifications.push(classified);
          return 1 as unknown as boolean;
        },
      });
      let callCount = 0;

      throttle(callback(() => { callCount++; }));
      await vi.advanceTimersByTimeAsync(3000);

      expect(callCount).toBe(1);
      expect(classifications).toEqual([ outcome ]);
    });

    it.each([
      { retryable: false, rateReducing: false, expectedAttempts: 1, expectedErrors: 0 },
      { retryable: false, rateReducing: true, expectedAttempts: 1, expectedErrors: 1 },
      { retryable: true, rateReducing: false, expectedAttempts: 2, expectedErrors: 0 },
      { retryable: true, rateReducing: true, expectedAttempts: 2, expectedErrors: 1 },
    ])("keeps retry eligibility $retryable and rate reduction $rateReducing independent", ({
      retryable,
      rateReducing,
      expectedAttempts,
      expectedErrors,
    }) => {
      const errorCounts: Array<number> = [];
      const throttle = createThrottledQueue({
        min_rpi: 1,
        max_rpi: 3,
        interval: 1000,
        evenly_spaced: false,
        retry: 1,
        retryClassifier: () => retryable,
        rateOutcomeClassifier: () => rateReducing,
        rateStrategy: observation => {
          errorCounts.push(observation.errorCount);
          return { nextRate: observation.currentRate, shouldBackOff: false };
        },
      });
      let attempts = 0;

      throttle(() => { attempts++; return false; });
      throttle(() => {});
      throttle(() => {});
      vi.advanceTimersByTime(2000);

      expect(attempts).toBe(expectedAttempts);
      expect(errorCounts).toEqual([ expectedErrors ]);
    });

    it("falls back to retrying when retryClassifier throws", () => {
      const throttle = createThrottledQueue({
        min_rpi: 5,
        interval: 1000,
        evenly_spaced: false,
        retry: 1,
        retryClassifier: () => { throw new Error("classifier failed"); },
      });
      let attempts = 0;

      throttle(() => { attempts++; return false; });

      expect(() => vi.advanceTimersByTime(3000)).not.toThrow();
      expect(attempts).toBe(2);
    });

    it("waits for retry backoff before re-entering normal scheduler pacing", () => {
      const throttle = createThrottledQueue({
        min_rpi: 5,
        interval: 1000,
        evenly_spaced: false,
        retry: 1,
        retryBackoff: { strategy: "fixed", baseDelay: 500 },
      });
      const starts: Array<number> = [];
      const startedAt = Date.now();

      throttle(() => {
        starts.push(Date.now() - startedAt);
        return starts.length === 1 ? false : undefined;
      });

      vi.advanceTimersByTime(2499);
      expect(starts).toEqual([ 1000 ]);

      vi.advanceTimersByTime(1);
      expect(starts).toEqual([ 1000, 2500 ]);
    });

    it("counts a delayed retry as pending work", () => {
      const throttle = createThrottledQueue({
        min_rpi: 1,
        interval: 1000,
        evenly_spaced: false,
        retry: 1,
        retryBackoff: { strategy: "fixed", baseDelay: 500 },
      });

      throttle(() => false);
      vi.advanceTimersByTime(1000);

      expect(throttle.getState().pending).toBe(1);
    });

    it("freezes a delayed retry's remaining delay while paused", () => {
      const throttle = createThrottledQueue({
        min_rpi: 1,
        interval: 1000,
        evenly_spaced: false,
        retry: 1,
        retryBackoff: { strategy: "fixed", baseDelay: 1000 },
      });
      let attempts = 0;

      throttle(() => { attempts++; return attempts === 1 ? false : undefined; });
      vi.advanceTimersByTime(1400);
      throttle.pause();
      vi.advanceTimersByTime(1000);
      throttle.resume();

      vi.advanceTimersByTime(1599);
      expect(attempts).toBe(1);

      vi.advanceTimersByTime(1);
      expect(attempts).toBe(2);
    });

    it("appends equal-due retries after already pending work in scheduling order", () => {
      const throttle = createThrottledQueue({
        min_rpi: 3,
        interval: 1000,
        evenly_spaced: false,
        retry: 1,
        retryBackoff: { strategy: "fixed", baseDelay: 500 },
      });
      const started: Array<string> = [];

      throttle(() => { started.push("first"); return false; });
      throttle(() => { started.push("second"); return false; });
      vi.advanceTimersByTime(1000);
      throttle(() => { started.push("new"); });
      vi.advanceTimersByTime(1000);

      expect(started).toEqual([ "first", "second", "new", "first", "second" ]);
    });

    it("discards delayed retries when aborted", () => {
      const throttle = createThrottledQueue({
        min_rpi: 1,
        interval: 1000,
        evenly_spaced: false,
        retry: 1,
        retryBackoff: { strategy: "fixed", baseDelay: 500 },
      });
      let attempts = 0;

      throttle(() => { attempts++; return false; });
      vi.advanceTimersByTime(1000);
      throttle.abort();
      vi.advanceTimersByTime(10_000);

      expect(throttle.getState().pending).toBe(0);
      expect(attempts).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("retries failed callbacks up to retry count", () => {
      const throttle = createThrottledQueue({
        min_rpi: 5,
        interval: 1000,
        evenly_spaced: false,
        retry: 2,
      });

      let callCount = 0;
      throttle(() => { callCount++; return false; });

      // Initial call + 2 retries = 3 total
      vi.advanceTimersByTime(5000);
      expect(callCount).toBe(3);
    });

    it("does not retry successful callbacks", () => {
      const throttle = createThrottledQueue({
        min_rpi: 5,
        interval: 1000,
        evenly_spaced: false,
        retry: 2,
      });

      let callCount = 0;
      throttle(() => { callCount++; });

      vi.advanceTimersByTime(5000);
      expect(callCount).toBe(1);
    });
  });

  describe("async/promise support", () => {
    it("treats rejected promises as errors", async () => {
      expect.assertions(2);
      const rates: Array<number> = [];
      const throttle = createThrottledQueue({
        min_rpi: 1,
        max_rpi: 5,
        interval: 1000,
        errors_per_interval: 1,
        onRateChange: r => rates.push(r),
      });

      for (let i = 0; i < 5; i++) {
        throttle(async () => { throw new Error("fail"); });
      }

      await vi.advanceTimersByTimeAsync(1000);

      expect(rates.length).toBeGreaterThan(0);
      expect(rates[0]).toBeLessThan(3);
    });

  });

  describe("idle behavior", () => {
    it("stops timers when queue drains and restarts on new enqueue", () => {
      const throttle = createThrottledQueue({ min_rpi: 1, interval: 1000 });
      let count = 0;
      throttle(() => { count++; });

      vi.advanceTimersByTime(1000);
      expect(count).toBe(1);

      // Queue is empty, timers should be stopped
      // Enqueue again after a pause
      vi.advanceTimersByTime(5000);
      throttle(() => { count++; });
      vi.advanceTimersByTime(1000);
      expect(count).toBe(2);
    });
  });

  describe("regression: ghost dequeue after stop", () => {
    it("stop() prevents back_off from scheduling further work", () => {
      const throttle = createThrottledQueue({
        min_rpi: 1,
        max_rpi: 3,
        interval: 1000,
        errors_per_interval: 1,
        back_off: true,
        evenly_spaced: false,
      });

      let count = 0;
      // Exactly 2 items: first batch drains → stop()
      throttle(() => { count++; return false; });
      throttle(() => { count++; return false; });

      // Process all items, queue drains, stop() called
      vi.advanceTimersByTime(2000);
      const countAfterDrain = count;

      // Even after many intervals, no ghost dequeue should fire
      vi.advanceTimersByTime(10000);
      expect(count).toBe(countAfterDrain);
    });
  });

  describe("regression: head-pointer dequeue", () => {
    it("processes every item exactly once with large batch", () => {
      const throttle = createThrottledQueue({
        min_rpi: 10,
        interval: 1000,
        evenly_spaced: false,
      });

      const called = new Set<number>();
      for (let i = 0; i < 200; i++) {
        const id = i;
        throttle(() => { called.add(id); });
      }

      vi.advanceTimersByTime(30_000);
      expect(called.size).toBe(200);
    });

    it("reclaims queue memory after drain", () => {
      const throttle = createThrottledQueue({
        min_rpi: 5,
        interval: 1000,
        evenly_spaced: false,
      });

      for (let i = 0; i < 50; i++) {
        throttle(() => {});
      }

      vi.advanceTimersByTime(20_000);

      // After drain, enqueue one more — should work fine (queue reset)
      let ran = false;
      throttle(() => { ran = true; });
      vi.advanceTimersByTime(1000);
      expect(ran).toBe(true);
    });
  });

  describe("sync throw in callback", () => {
    it("treats thrown exception as error and retries", () => {
      const throttle = createThrottledQueue({
        min_rpi: 5,
        interval: 1000,
        evenly_spaced: false,
        retry: 2,
      });

      let callCount = 0;
      throttle(() => { callCount++; throw new Error("boom"); });

      vi.advanceTimersByTime(5000);
      expect(callCount).toBe(3); // initial + 2 retries
    });

    it("thrown exception increments error_count and triggers rate decrease", () => {
      const rates: Array<number> = [];
      const throttle = createThrottledQueue({
        min_rpi: 1,
        max_rpi: 5,
        interval: 1000,
        errors_per_interval: 2,
        evenly_spaced: false,
        onRateChange: r => rates.push(r),
      });

      for (let i = 0; i < 10; i++) {
        throttle(() => { throw new Error("boom"); });
      }

      vi.advanceTimersByTime(1000);
      expect(rates.some(r => r < 3)).toBe(true);
    });
  });

  describe("async retry after idle drain", () => {
    it("retries a false async result at the next paced start", async () => {
      const throttle = createThrottledQueue({
        min_rpi: 5,
        interval: 1000,
        evenly_spaced: false,
        retry: 1,
      });

      const firstResult = deferred();
      const startedAt = Date.now();
      const starts: Array<number> = [];
      let attempts = 0;
      throttle(async () => {
        starts.push(Date.now() - startedAt);
        attempts++;
        return attempts === 1 ? firstResult.promise.then(() => false) : undefined;
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(starts).toEqual([ 1000 ]);

      firstResult.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(999);
      expect(starts).toEqual([ 1000 ]);

      await vi.advanceTimersByTimeAsync(1);
      expect(starts).toEqual([ 1000, 2000 ]);
    });
  });

  describe("handle API", () => {
    it.each([ "success", "false", "rejection" ] as const)("does not resume scheduling when an active callback settles as $outcome after stop", async outcome => {
      let settle!: (value: boolean | void) => void;
      let fail!: (reason?: unknown) => void;
      const inFlight = new Promise<boolean | void>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
      const throttle = createThrottledQueue({
        min_rpi: 1,
        interval: 1000,
        evenly_spaced: false,
        retry: 1,
      });
      let started = 0;

      throttle(async () => { started++; return inFlight; });
      throttle(() => { started++; });

      await vi.advanceTimersByTimeAsync(1000);
      expect(started).toBe(1);

      throttle.stop();
      if (outcome === "success") settle();
      else if (outcome === "false") settle(false);
      else fail(new Error("failed"));
      await vi.advanceTimersByTimeAsync(0);

      expect(started).toBe(1);
      expect(throttle.getState().pending).toBe(outcome === "success" ? 1 : 2);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("stop() halts processing mid-queue", () => {
      const throttle = createThrottledQueue({
        min_rpi: 2,
        interval: 1000,
        evenly_spaced: false,
      });

      let count = 0;
      for (let i = 0; i < 10; i++) {
        throttle(() => { count++; });
      }

      // Let some items process
      vi.advanceTimersByTime(1000);
      throttle.stop();
      const countAtStop = count;
      expect(countAtStop).toBe(2);

      // No more processing after stop
      vi.advanceTimersByTime(5000);
      expect(count).toBe(countAtStop);
    });

    it("pending returns number of unprocessed items", () => {
      const throttle = createThrottledQueue({
        min_rpi: 2,
        interval: 1000,
        evenly_spaced: false,
      });

      expect(throttle.getState().pending).toBe(0);

      for (let i = 0; i < 5; i++) {
        throttle(() => {});
      }

      expect(throttle.getState().pending).toBe(5);
    });

    it("pending reflects count after partial processing", () => {
      const throttle = createThrottledQueue({ min_rpi: 2, interval: 1000, evenly_spaced: false });
      for (let i = 0; i < 5; i++) throttle(() => {});
      vi.advanceTimersByTime(1000);
      expect(throttle.getState().pending).toBe(3);
    });

    it("pending decreases as items are processed", () => {
      const throttle = createThrottledQueue({
        min_rpi: 3,
        interval: 1000,
        evenly_spaced: false,
      });

      for (let i = 0; i < 10; i++) {
        throttle(() => {});
      }

      expect(throttle.getState().pending).toBe(10);

      vi.advanceTimersByTime(1000);
      expect(throttle.getState().pending).toBe(7);

      vi.advanceTimersByTime(1000);
      expect(throttle.getState().pending).toBe(4);

      vi.advanceTimersByTime(1000);
      expect(throttle.getState().pending).toBe(1);

      vi.advanceTimersByTime(1000);
      expect(throttle.getState().pending).toBe(0);
    });

    it("enqueue after stop() resumes processing with old + new items", () => {
      const throttle = createThrottledQueue({
        min_rpi: 5,
        interval: 1000,
        evenly_spaced: false,
      });

      let count = 0;
      for (let i = 0; i < 3; i++) {
        throttle(() => { count++; });
      }

      vi.advanceTimersByTime(500);
      expect(count).toBe(0); // batch mode: first dequeue at 1000ms, nothing fired yet
      throttle.stop();

      // Enqueue more — should resume
      throttle(() => { count++; });
      vi.advanceTimersByTime(5000);

      // All 4 items should have processed (3 original + 1 new, minus any already done)
      expect(count).toBe(4);
    });
  });

  describe("evenly_spaced rate dynamics", () => {
    it("adjusts request spacing when rate changes", () => {
      const rates: Array<number> = [];
      const throttle = createThrottledQueue({
        min_rpi: 1,
        max_rpi: 4,
        interval: 1000,
        onRateChange: r => rates.push(r),
      });

      let count = 0;
      for (let i = 0; i < 20; i++) {
        throttle(() => { count++; });
      }

      // Starting rpi=ceil((4+1)/2)=3, dyn_interval=333ms.
      // Items fire at ~333, ~666, ~999ms
      vi.advanceTimersByTime(999);

      // adjustRate fires at 1000ms, sees 0 errors + items in queue → increases to rpi=4
      vi.advanceTimersByTime(1);
      expect(rates[0]).toBe(4);

      // After rate change: dyn_interval = 1000/4 = 250ms
      // Next 4 items should fire in 1000ms (at 250ms spacing)
      const countAfterAdjust = count;
      vi.advanceTimersByTime(1000);
      expect(count - countAfterAdjust).toBe(4);
    });
  });

  describe("retry: 0", () => {
    it("does not retry failed callbacks when retry is 0", () => {
      const throttle = createThrottledQueue({
        min_rpi: 5,
        interval: 1000,
        evenly_spaced: false,
        retry: 0,
      });

      let callCount = 0;
      throttle(() => { callCount++; return false; });

      vi.advanceTimersByTime(5000);
      expect(callCount).toBe(1);
    });
  });

  describe("regression: async retry preserves error_count", () => {
    it("error_count accumulates from retried failures and triggers rate decrease", () => {
      const rates: Array<number> = [];
      const throttle = createThrottledQueue({
        min_rpi: 1,
        max_rpi: 5,
        interval: 1000,
        errors_per_interval: 2,
        retry: 2,
        evenly_spaced: false,
        onRateChange: r => rates.push(r),
      });

      // Sync failing callbacks — retries push back into queue as errors
      throttle(() => false);
      throttle(() => false);

      // Process through several intervals to allow retries to accumulate
      vi.advanceTimersByTime(5000);

      // Starting rpi=3, first decrease goes to 2
      expect(rates[0]).toBe(2);
    });
  });

  describe("abort", () => {
    it("signals every active callback with the queue-owned signal", async () => {
      const throttle = createThrottledQueue({
        min_rpi: 2,
        interval: 1000,
        evenly_spaced: false,
      });
      const active = [ deferred(), deferred() ];
      const signals: Array<AbortSignal> = [];

      for (const item of active) {
        throttle(async ({ signal }) => {
          signals.push(signal);
          return item.promise;
        });
      }

      await vi.advanceTimersByTimeAsync(1000);
      throttle.abort();

      expect(signals).toHaveLength(2);
      expect(signals[0]).toBe(signals[1]);
      expect(signals[0]?.aborted).toBe(true);
    });

    it("stops starting the rest of a batch when a callback aborts the queue", () => {
      const throttle = createThrottledQueue({ min_rpi: 3, interval: 1000, evenly_spaced: false });
      const started: Array<string> = [];

      throttle(() => { started.push("first"); throttle.abort(); });
      throttle(() => { started.push("second"); });
      throttle(() => { started.push("third"); });
      vi.advanceTimersByTime(1000);

      expect(started).toEqual([ "first" ]);
      expect(throttle.getState()).toMatchObject({ state: "aborted", started: 1, active: 0, pending: 0 });
    });

    it("is terminal, discards pending work, and prevents later starts", async () => {
      const throttle = createThrottledQueue({
        min_rpi: 1,
        interval: 1000,
        evenly_spaced: false,
      });
      const active = deferred();
      let started = 0;

      throttle(async () => { started++; return active.promise; });
      throttle(() => { started++; });
      await vi.advanceTimersByTimeAsync(1000);
      expect(started).toBe(1);

      throttle.abort();
      throttle.abort();

      expect(throttle.getState().pending).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(() => throttle(() => { started++; })).toThrow("aborted");

      active.resolve();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(started).toBe(1);
    });

    it("ignores failed active work that settles after abortion", async () => {
      const rates: Array<number> = [];
      const throttle = createThrottledQueue({
        min_rpi: 1,
        max_rpi: 3,
        interval: 1000,
        evenly_spaced: false,
        errors_per_interval: 1,
        retry: 1,
        onRateChange: rate => rates.push(rate),
      });
      let settle!: (value: boolean) => void;
      const active = new Promise<boolean>(resolve => { settle = resolve; });

      throttle(async () => active);
      await vi.advanceTimersByTimeAsync(1000);
      throttle.abort();
      settle(false);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(throttle.getState().pending).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(rates).toEqual([]);
    });

    it("leaves active callbacks unsignalled when stopped", async () => {
      const throttle = createThrottledQueue({
        min_rpi: 1,
        interval: 1000,
        evenly_spaced: false,
      });
      const active = deferred();
      let signal!: AbortSignal;

      throttle(async context => {
        signal = context.signal;
        return active.promise;
      });
      await vi.advanceTimersByTimeAsync(1000);
      throttle.stop();

      expect(signal.aborted).toBe(false);
    });
  });

  describe("pause and resume", () => {
    it("retains pending and newly accepted callbacks without starting them until resumed", () => {
      const throttle = createThrottledQueue({ min_rpi: 1, interval: 1000, evenly_spaced: false });
      const started: Array<string> = [];

      throttle(() => { started.push("first"); });
      throttle(() => { started.push("second"); });
      throttle.pause();
      throttle(() => { started.push("third"); });

      vi.advanceTimersByTime(10_000);

      expect(started).toEqual([]);
      expect(throttle.getState().pending).toBe(3);

      throttle.resume();
      vi.advanceTimersByTime(1000);

      expect(started).toEqual([ "first" ]);
      expect(throttle.getState().pending).toBe(2);
    });

    it("is idempotent when pause and resume are repeated", () => {
      const throttle = createThrottledQueue({ min_rpi: 1, interval: 1000, evenly_spaced: false });
      let started = 0;

      throttle(() => { started++; });
      throttle.pause();
      throttle.pause();
      throttle.resume();
      throttle.resume();
      vi.advanceTimersByTime(1000);

      expect(started).toBe(1);
    });

    it("retains a retry from active work while paused until resumed", async () => {
      const throttle = createThrottledQueue({
        min_rpi: 1,
        interval: 1000,
        evenly_spaced: false,
        retry: 1,
      });
      let settle!: (value: boolean) => void;
      const active = new Promise<boolean>(resolve => { settle = resolve; });
      let attempts = 0;

      throttle(async () => { attempts++; return active; });
      await vi.advanceTimersByTimeAsync(1000);
      expect(attempts).toBe(1);

      throttle.pause();
      settle(false);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(attempts).toBe(1);
      expect(throttle.getState().pending).toBe(1);

      throttle.resume();
      await vi.advanceTimersByTimeAsync(1000);

      expect(attempts).toBe(2);
    });

    it("makes stop take precedence over pause and leaves pause and resume inert after stop or abort", () => {
      const throttle = createThrottledQueue({ min_rpi: 1, interval: 1000, evenly_spaced: false });
      const started: Array<string> = [];

      throttle(() => { started.push("retained"); });
      throttle.pause();
      throttle.stop();
      throttle.resume();
      throttle.pause();
      vi.advanceTimersByTime(10_000);

      expect(started).toEqual([]);
      expect(throttle.getState().pending).toBe(1);

      throttle(() => { started.push("new"); });
      vi.advanceTimersByTime(2000);
      expect(started).toEqual([ "retained", "new" ]);

      throttle.abort();
      throttle.pause();
      throttle.resume();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("getState()", () => {
    it("returns a frozen snapshot", () => {
      const q = createThrottledQueue({ min_rpi: 1, interval: 1000 });
      const s = q.getState();
      expect(Object.isFrozen(s)).toBe(true);
    });

    it("initial snapshot has rate, pending:0, active:0, state:running", () => {
      const q = createThrottledQueue({ min_rpi: 2, max_rpi: 4, interval: 1000 });
      const s = q.getState();
      expect(s.pending).toBe(0);
      expect(s.active).toBe(0);
      expect(s.state).toBe("running");
      expect(typeof s.rate).toBe("number");
    });

    it("each call returns a fresh snapshot", () => {
      const q = createThrottledQueue({ min_rpi: 1, interval: 1000 });
      const s1 = q.getState();
      const s2 = q.getState();
      expect(s1).not.toBe(s2);
    });

    it("reflects pending count after enqueue", () => {
      const q = createThrottledQueue({ min_rpi: 1, interval: 1000 });
      q(() => {});
      q(() => {});
      expect(q.getState().pending).toBe(2);
    });

    it("reflects active count during async execution", async () => {
      const q = createThrottledQueue({ min_rpi: 2, interval: 1000, evenly_spaced: false });
      const d1 = deferred();
      const d2 = deferred();
      q(async () => d1.promise);
      q(async () => d2.promise);
      await vi.advanceTimersByTimeAsync(1000);
      expect(q.getState().active).toBe(2);
      d1.resolve();
      d2.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });

    it("state is paused while paused", () => {
      const q = createThrottledQueue({ min_rpi: 1, interval: 1000 });
      q.pause();
      expect(q.getState().state).toBe("paused");
    });

    it("state is stopped while stopped", () => {
      const q = createThrottledQueue({ min_rpi: 1, interval: 1000 });
      q.stop();
      expect(q.getState().state).toBe("stopped");
    });

    it("state is aborted after abort", () => {
      const q = createThrottledQueue({ min_rpi: 1, interval: 1000 });
      q.abort();
      expect(q.getState().state).toBe("aborted");
    });

    it("state is running after stop then enqueue restarts", () => {
      const q = createThrottledQueue({ min_rpi: 1, interval: 1000 });
      q.stop();
      q(() => {});
      expect(q.getState().state).toBe("running");
    });

    it("state is running after resume", () => {
      const q = createThrottledQueue({ min_rpi: 1, interval: 1000 });
      q(() => {});
      q.pause();
      q.resume();
      expect(q.getState().state).toBe("running");
    });

    it("started increments for each callback attempt including retries", () => {
      const q = createThrottledQueue({ min_rpi: 5, interval: 1000, evenly_spaced: false, retry: 1 });
      q(() => false);
      vi.advanceTimersByTime(3000);
      expect(q.getState().started).toBe(2);
    });

    it("succeeded increments for successful callbacks", () => {
      const q = createThrottledQueue({ min_rpi: 2, interval: 1000, evenly_spaced: false });
      q(() => {});
      q(() => {});
      vi.advanceTimersByTime(1000);
      expect(q.getState().succeeded).toBe(2);
    });

    it("failed increments for returned-false, thrown, and rejected", async () => {
      const q = createThrottledQueue({ min_rpi: 3, interval: 1000, evenly_spaced: false });
      q(() => false);
      q(() => { throw new Error("boom"); });
      q(async () => { throw new Error("async"); });
      await vi.advanceTimersByTimeAsync(1000);
      expect(q.getState().failed).toBe(3);
    });

    it("failed increments per attempt even when retry later succeeds", () => {
      let attempt = 0;
      const q = createThrottledQueue({ min_rpi: 5, interval: 1000, evenly_spaced: false, retry: 1 });
      q(() => { attempt++; return attempt === 1 ? false : undefined; });
      vi.advanceTimersByTime(3000);
      expect(q.getState().failed).toBe(1);
      expect(q.getState().succeeded).toBe(1);
    });

    it("retried increments only when another attempt is actually scheduled", () => {
      const q = createThrottledQueue({ min_rpi: 5, interval: 1000, evenly_spaced: false, retry: 2 });
      let attempt = 0;
      q(() => { attempt++; return attempt <= 2 ? false : undefined; });
      vi.advanceTimersByTime(5000);
      expect(q.getState().retried).toBe(2);
    });

    it("retried does not increment when retry is exhausted", () => {
      const q = createThrottledQueue({ min_rpi: 5, interval: 1000, evenly_spaced: false, retry: 1 });
      q(() => false); // fails both attempts, no more retries scheduled
      vi.advanceTimersByTime(3000);
      expect(q.getState().retried).toBe(1); // only 1 retry was scheduled
    });

    it("counters do not change for settlements after abort", async () => {
      const q = createThrottledQueue({ min_rpi: 1, interval: 1000 });
      const d = deferred();
      q(async () => d.promise);
      await vi.advanceTimersByTimeAsync(1000);
      const before = q.getState();
      q.abort();
      d.resolve();
      await vi.advanceTimersByTimeAsync(0);
      const after = q.getState();
      expect(after.started).toBe(before.started);
      expect(after.succeeded).toBe(before.succeeded);
      expect(after.failed).toBe(before.failed);
    });

    it("pending includes delayed retries", () => {
      const q = createThrottledQueue({
        min_rpi: 1,
        interval: 1000,
        evenly_spaced: false,
        retry: 1,
        retryBackoff: { strategy: "fixed", baseDelay: 500 },
      });
      q(() => false);
      vi.advanceTimersByTime(1000);
      expect(q.getState().pending).toBe(1);
    });
  });

  describe("waitForIdle()", () => {
    it("resolves immediately when already idle", async () => {
      const q = createThrottledQueue({ min_rpi: 1, interval: 1000 });
      await expect(q.waitForIdle()).resolves.toBeUndefined();
    });

    it("resolves after synchronous work completes", async () => {
      const q = createThrottledQueue({ min_rpi: 1, interval: 1000 });
      let done = false;
      q(() => {});
      const idle = q.waitForIdle().then(() => (done = true));
      expect(done).toBe(false);
      await vi.runAllTimersAsync();
      await idle;
      expect(done).toBe(true);
    });

    it("resolves after async work settles", async () => {
      const q = createThrottledQueue({ min_rpi: 1, interval: 1000 });
      const d = deferred();
      let done = false;
      q(async () => d.promise);
      const idle = q.waitForIdle().then(() => (done = true));
      await vi.runAllTimersAsync();
      expect(done).toBe(false);
      d.resolve();
      await vi.runAllTimersAsync();
      await idle;
      expect(done).toBe(true);
    });

    it("does not expose transient idle between failure and retry", async () => {
      const q = createThrottledQueue({ min_rpi: 1, interval: 1000, retry: 1 });
      let idleCount = 0;
      let attempt = 0;
      q(() => {
        attempt++;
        return attempt === 1 ? false : undefined; // first fails, retry succeeds
      });
      const idle = q.waitForIdle().then(() => idleCount++);
      await vi.runAllTimersAsync();
      await idle;
      expect(idleCount).toBe(1);
      expect(attempt).toBe(2);
    });

    it("does not expose transient idle between async failure and delayed retry", async () => {
      const q = createThrottledQueue({
        min_rpi: 1,
        interval: 1000,
        retry: 1,
        retryBackoff: { strategy: "fixed", baseDelay: 500 },
      });
      let idleCount = 0;
      let attempt = 0;
      q(async () => {
        attempt++;
        return attempt === 1 ? false : undefined;
      });
      const idle = q.waitForIdle().then(() => idleCount++);
      await vi.runAllTimersAsync();
      await idle;
      expect(idleCount).toBe(1);
      expect(attempt).toBe(2);
    });

    it("concurrent callers all resolve at the same idle transition without leaking", async () => {
      const q = createThrottledQueue({ min_rpi: 1, interval: 1000 });
      q(() => {});
      const results: Array<number> = [];
      const p1 = q.waitForIdle().then(() => results.push(1));
      const p2 = q.waitForIdle().then(() => results.push(2));
      const p3 = q.waitForIdle().then(() => results.push(3));
      await vi.runAllTimersAsync();
      await Promise.all([ p1, p2, p3 ]);
      expect(results).toHaveLength(3);
      // Second wave: no leftover waiters from first idle
      q(() => {});
      const p4 = q.waitForIdle();
      await vi.runAllTimersAsync();
      await p4;
    });

    it("leaves waiters pending when stop() retains pending work", async () => {
      const q = createThrottledQueue({ min_rpi: 1, interval: 1000 });
      q(() => {});
      q(() => {});
      let done = false;
      const idle = q.waitForIdle().then(() => (done = true));
      // stop before any work runs — timers not advanced
      q.stop();
      await vi.runAllTimersAsync();
      expect(done).toBe(false);
      idle.catch(() => {}); // suppress unhandled
    });

    it("waiters remain pending during abort until active async callbacks settle", async () => {
      const q = createThrottledQueue({ min_rpi: 1, interval: 1000 });
      const d = deferred();
      let done = false;
      q(async () => d.promise);
      const idle = q.waitForIdle().then(() => (done = true));
      await vi.runAllTimersAsync(); // callback starts
      q.abort();
      await vi.runAllTimersAsync();
      expect(done).toBe(false); // active callback not settled
      d.resolve();
      await vi.runAllTimersAsync();
      await idle;
      expect(done).toBe(true);
    });

    it("resolves when abort() discards queued work and no callback is active", async () => {
      const q = createThrottledQueue({ min_rpi: 1, interval: 60_000 });
      for (let i = 0; i < 3; i++) q(() => {});
      const idle = q.waitForIdle();

      q.abort();

      await expect(idle).resolves.toBeUndefined();
      expect(q.getState()).toMatchObject({ state: "aborted", pending: 0 });
    });

    it("resolves when paused queue drains after resume", async () => {
      const q = createThrottledQueue({ min_rpi: 1, interval: 1000 });
      let done = false;
      q(() => {});
      const idle = q.waitForIdle().then(() => (done = true));
      q.pause();
      await vi.runAllTimersAsync();
      expect(done).toBe(false); // paused with pending work
      q.resume();
      await vi.runAllTimersAsync();
      await idle;
      expect(done).toBe(true);
    });

    it("already-resolved waiter is unaffected by later enqueues", async () => {
      const q = createThrottledQueue({ min_rpi: 1, interval: 1000 });
      q(() => {});
      const first = q.waitForIdle();
      await vi.runAllTimersAsync();
      await first; // first waiter resolved
      let secondCount = 0;
      const second = q.waitForIdle().then(() => secondCount++);
      q(() => {}); // new work
      await vi.runAllTimersAsync();
      await second;
      expect(secondCount).toBe(1); // second waiter resolved exactly once for the new work
    });
  });
});
