import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createThrottledQueue } from "../dynamic-throttled-queue.ts";

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
    it("decreases to the minimum rate and stays there after consecutive failing windows", () => {
      const rates: Array<number> = [];
      const throttle = createThrottledQueue({
        min_rpi: 1,
        max_rpi: 5,
        interval: 1000,
        errors_per_interval: 2,
        onRateChange: r => rates.push(r),
      });

      // Starts at 3. Each error-filled observation window lowers the rate by one.
      for (let i = 0; i < 40; i++) {
        throttle(() => false);
      }

      vi.advanceTimersByTime(4000);

      // The final two windows exercise the lower clamp: no rate-change event is
      // emitted once the rate is already at min_rpi.
      expect(rates).toEqual([ 2, 1 ]);
    });

    it("increases to the maximum rate and stays there after consecutive successful windows", () => {
      const rates: Array<number> = [];
      const throttle = createThrottledQueue({
        min_rpi: 1,
        max_rpi: 5,
        interval: 1000,
        onRateChange: r => rates.push(r),
      });

      // Starts at 3. Each error-free observation window raises the rate by one.
      for (let i = 0; i < 40; i++) {
        throttle(() => {});
      }

      vi.advanceTimersByTime(4000);

      // The final two windows exercise the upper clamp: no rate-change event is
      // emitted once the rate is already at max_rpi.
      expect(rates).toEqual([ 4, 5 ]);
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

  describe("async feedback timing across adjustment windows", () => {
    function delayedResult(delay: number, result: boolean | void) {
      return async () => new Promise<boolean | void>(resolve => {
        setTimeout(() => resolve(result), delay);
      });
    }

    function enqueueKeepAlive(throttle: ReturnType<typeof createThrottledQueue>) {
      // Keep adjustment timers alive through the second 1000 ms window.
      for (let i = 0; i < 40; i++) throttle(() => {});
    }

    it.each([
      { result: undefined, expectedRate: 11, outcome: "success" },
      { result: false, expectedRate: 9, outcome: "failure" },
    ])("attributes a $outcome settling before the interval to the first window", async ({ result, expectedRate }) => {
      const rates: Array<number> = [];
      const throttle = createThrottledQueue({
        min_rpi: 9,
        max_rpi: 11,
        interval: 1000,
        errors_per_interval: 1,
        onRateChange: rate => rates.push(rate),
      });

      // The callback starts at 100 ms and settles at 200 ms, well before adjustment.
      throttle(delayedResult(100, result));
      enqueueKeepAlive(throttle);

      await vi.advanceTimersByTimeAsync(1000);
      expect(rates).toEqual([ expectedRate ]);
    });

    it("attributes a failure settling at the adjustment boundary to the later window", async () => {
      const rates: Array<number> = [];
      const throttle = createThrottledQueue({
        min_rpi: 9,
        max_rpi: 11,
        interval: 1000,
        errors_per_interval: 1,
        onRateChange: rate => rates.push(rate),
      });

      // This starts at 100 ms. The 900 ms delay reaches 1000 ms, but the adjustment
      // timer was registered first, so the first window increases before the failure.
      throttle(delayedResult(900, false));
      enqueueKeepAlive(throttle);

      await vi.advanceTimersByTimeAsync(1000);
      expect(rates).toEqual([ 11 ]);

      await vi.advanceTimersByTimeAsync(1000);
      expect(rates).toEqual([ 11, 10 ]);
    });

    it("increases at 1000 ms before attributing a 1500 ms task failure to the later window", async () => {
      const rates: Array<number> = [];
      const throttle = createThrottledQueue({
        min_rpi: 9,
        max_rpi: 11,
        interval: 1000,
        errors_per_interval: 1,
        onRateChange: rate => rates.push(rate),
      });

      // At rate 10 this starts at 100 ms and settles at 1600 ms. Its failure is
      // invisible at 1000 ms, then consumed by the adjustment at 2000 ms.
      throttle(delayedResult(1500, false));
      enqueueKeepAlive(throttle);

      await vi.advanceTimersByTimeAsync(1000);
      expect(rates).toEqual([ 11 ]);

      await vi.advanceTimersByTimeAsync(1000);
      expect(rates).toEqual([ 11, 10 ]);
    });

    it("groups variable async results by settlement window rather than invocation window", async () => {
      const rates: Array<number> = [];
      const throttle = createThrottledQueue({
        min_rpi: 8,
        max_rpi: 12,
        interval: 1000,
        errors_per_interval: 1,
        onRateChange: rate => rates.push(rate),
      });

      // These start at 100, 200, 300, and 400 ms. The early failure lands in the
      // first window; the boundary success and later failure do not affect it.
      throttle(delayedResult(100, undefined));
      throttle(delayedResult(100, false));
      throttle(delayedResult(700, undefined));
      throttle(delayedResult(1400, false));
      enqueueKeepAlive(throttle);

      await vi.advanceTimersByTimeAsync(1000);
      expect(rates).toEqual([ 9 ]);

      await vi.advanceTimersByTimeAsync(1000);
      expect(rates).toEqual([ 9, 8 ]);
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

  describe("regression: double adjustRate", () => {
    it("async retry restart produces one rate change per subsequent adjustment window", async () => {
      const rates: Array<number> = [];
      let resolveFirst!: (value: boolean) => void;
      const firstResult = new Promise<boolean>(resolve => { resolveFirst = resolve; });
      const throttle = createThrottledQueue({
        min_rpi: 1,
        max_rpi: 5,
        interval: 1000,
        errors_per_interval: 1,
        retry: 1,
        onRateChange: r => rates.push(r),
      });

      // Let the initial async callback drain the queue, then fail it. Its retry
      // restarts the scheduler and opens a fresh adjustment window.
      throttle(async () => firstResult);
      await vi.advanceTimersByTimeAsync(500);
      resolveFirst(false);
      await vi.advanceTimersByTimeAsync(0);

      // The retry fails in the restarted window; the remaining callbacks keep
      // it alive for the following successful window.
      for (let i = 0; i < 40; i++) throttle(() => {});
      await vi.advanceTimersByTimeAsync(2000);

      expect(rates).toEqual([ 2, 3 ]);
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

  describe("skippedLast blocks rate increase", () => {
    it("skips the backoff adjustment window before increasing in the next eligible window", () => {
      const rates: Array<number> = [];
      const throttle = createThrottledQueue({
        min_rpi: 1,
        max_rpi: 10,
        interval: 1000,
        errors_per_interval: 1,
        back_off: true,
        evenly_spaced: false,
        onRateChange: r => rates.push(r),
      });

      // First item fails → triggers backoff
      throttle(() => false);
      // Rest succeed
      for (let i = 0; i < 20; i++) {
        throttle(() => {});
      }

      // At 1000ms, the first failure reduces 6 → 5 and starts backoff. The
      // 2000ms window is skipped; the next error-free window raises 5 → 6.
      vi.advanceTimersByTime(3000);
      expect(rates).toEqual([ 5, 6 ]);
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
      expect(throttle.pending).toBe(outcome === "success" ? 1 : 2);
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

      expect(throttle.pending).toBe(0);

      for (let i = 0; i < 5; i++) {
        throttle(() => {});
      }

      expect(throttle.pending).toBe(5);
    });

    it("pending reflects count after partial processing", () => {
      const throttle = createThrottledQueue({ min_rpi: 2, interval: 1000, evenly_spaced: false });
      for (let i = 0; i < 5; i++) throttle(() => {});
      vi.advanceTimersByTime(1000);
      expect(throttle.pending).toBe(3);
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

      expect(throttle.pending).toBe(10);

      vi.advanceTimersByTime(1000);
      expect(throttle.pending).toBe(7);

      vi.advanceTimersByTime(1000);
      expect(throttle.pending).toBe(4);

      vi.advanceTimersByTime(1000);
      expect(throttle.pending).toBe(1);

      vi.advanceTimersByTime(1000);
      expect(throttle.pending).toBe(0);
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
});
