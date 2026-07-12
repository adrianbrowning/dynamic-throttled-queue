import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createThrottledQueue } from "../dynamic-throttled-queue.ts";

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

    it("does not start timers until first enqueue", () => {
      const spy = vi.spyOn(globalThis, "setTimeout");
      const callsBefore = spy.mock.calls.length;
      createThrottledQueue({ min_rpi: 1, interval: 1000 });
      expect(spy.mock.calls).toHaveLength(callsBefore);
      spy.mockRestore();
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

  describe("dynamic rate adjustment", () => {
    it("decreases rate on errors", () => {
      const rates: Array<number> = [];
      const throttle = createThrottledQueue({
        min_rpi: 1,
        max_rpi: 5,
        interval: 1000,
        errors_per_interval: 2,
        onRateChange: r => rates.push(r),
      });

      // Starting rpi = ceil(5 - (5-1)/2) = 3, evenly_spaced so interval = 1000/3 ≈ 333ms
      // Queue enough failing callbacks
      for (let i = 0; i < 20; i++) {
        throttle(() => false);
      }

      // After 1 interval (1000ms), adjustRate fires and sees errors >= 2
      vi.advanceTimersByTime(1000);
      expect(rates).toContain(2); // decreased from 3
    });

    it("increases rate when no errors", () => {
      const rates: Array<number> = [];
      const throttle = createThrottledQueue({
        min_rpi: 1,
        max_rpi: 5,
        interval: 1000,
        onRateChange: r => rates.push(r),
      });

      // Queue succeeding callbacks
      for (let i = 0; i < 20; i++) {
        throttle(() => {});
      }

      // After interval, adjustRate sees 0 errors + queue not empty → increase
      vi.advanceTimersByTime(1000);
      expect(rates).toContain(4); // increased from 3
    });
  });

  describe("backoff", () => {
    it("backs off for one full interval on errors when back_off is true", () => {
      const throttle = createThrottledQueue({
        min_rpi: 1,
        max_rpi: 5,
        interval: 1000,
        errors_per_interval: 1,
        back_off: true,
        evenly_spaced: false,
      });

      let count = 0;
      for (let i = 0; i < 20; i++) {
        throttle(() => { count++; return false; });
      }

      const countAt1s = (() => { vi.advanceTimersByTime(1000); return count; })();
      const countAt2s = (() => { vi.advanceTimersByTime(1000); return count; })();

      // With backoff, no items should process during the pause interval
      expect(countAt2s).toBe(countAt1s);
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

    it("treats promise resolving to false as error", async () => {
      expect.assertions(1);
      const throttle = createThrottledQueue({
        min_rpi: 5,
        interval: 1000,
        evenly_spaced: false,
        retry: 1,
      });

      let callCount = 0;
      throttle(async () => { callCount++; return false; });

      // First execution
      await vi.advanceTimersByTimeAsync(1000);
      // Retry gets queued asynchronously, needs another interval to fire
      await vi.advanceTimersByTimeAsync(1000);

      expect(callCount).toBe(2); // original + 1 retry
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

  describe("regression: skippedLast race", () => {
    it("back_off pauses processing for a full extra interval", () => {
      const throttle = createThrottledQueue({
        min_rpi: 1,
        max_rpi: 3,
        interval: 1000,
        errors_per_interval: 1,
        back_off: true,
      });

      let count = 0;
      for (let i = 0; i < 10; i++) {
        throttle(() => { count++; return false; });
      }

      // Starting rpi=2, dyn_interval=500ms. First dequeue at 500ms.
      vi.advanceTimersByTime(500);
      expect(count).toBeGreaterThan(0);

      // adjustRate fires at 1000ms, sees errors >= 1, triggers back_off
      vi.advanceTimersByTime(500);
      const countAtAdjust = count;

      // back_off schedules dequeue at dyn_interval + interval from now
      // During that pause, no new items should process
      vi.advanceTimersByTime(500);
      const countDuringPause = count;

      expect(countDuringPause).toBe(countAtAdjust);
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
    it("async retry restart does not create duplicate rate adjustments", async () => {
      expect.assertions(1);
      const rates: Array<number> = [];
      const throttle = createThrottledQueue({
        min_rpi: 1,
        max_rpi: 5,
        interval: 1000,
        errors_per_interval: 2,
        retry: 1,
        onRateChange: r => rates.push(r),
      });

      // Single async failing callback — will trigger retry after resolution
      throttle(async () => false);

      // Advance to fire dequeue + let promise resolve
      await vi.advanceTimersByTimeAsync(500);

      // adjustRate fires at 1000ms
      await vi.advanceTimersByTimeAsync(500);

      // Retry enqueued + restart happens here. Second adjustRate window.
      await vi.advanceTimersByTimeAsync(1000);

      // If double adjustRate existed, we'd see more rate changes than expected.
      // With rpi starting at 3, errors_per_interval=2: at most 1 decrease per interval
      const decreases = rates.filter((r, i) => i > 0 && r < rates[i - 1]!);
      expect(decreases.length).toBeLessThanOrEqual(1);
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

  describe("compact_threshold", () => {
    it("compacts queue when head exceeds threshold and half length", () => {
      const throttle = createThrottledQueue({
        min_rpi: 10,
        interval: 1000,
        evenly_spaced: false,
        compact_threshold: 5,
      });

      let count = 0;
      for (let i = 0; i < 20; i++) {
        throttle(() => { count++; });
      }

      vi.advanceTimersByTime(5000);
      expect(count).toBe(20);
    });

    it("does not compact when head is below threshold", () => {
      const throttle = createThrottledQueue({
        min_rpi: 2,
        interval: 1000,
        evenly_spaced: false,
        compact_threshold: 100,
      });

      let count = 0;
      for (let i = 0; i < 4; i++) {
        throttle(() => { count++; });
      }

      vi.advanceTimersByTime(3000);
      expect(count).toBe(4);
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

  describe("rate clamping", () => {
    it("rate never drops below min_rpi", () => {
      const rates: Array<number> = [];
      const throttle = createThrottledQueue({
        min_rpi: 2,
        max_rpi: 5,
        interval: 1000,
        errors_per_interval: 1,
        evenly_spaced: false,
        onRateChange: r => rates.push(r),
      });

      for (let i = 0; i < 50; i++) {
        throttle(() => false);
      }

      vi.advanceTimersByTime(20_000);
      expect(rates.every(r => r >= 2)).toBe(true);
    });

    it("rate never exceeds max_rpi", () => {
      const rates: Array<number> = [];
      const throttle = createThrottledQueue({
        min_rpi: 1,
        max_rpi: 4,
        interval: 1000,
        evenly_spaced: false,
        onRateChange: r => rates.push(r),
      });

      for (let i = 0; i < 100; i++) {
        throttle(() => {});
      }

      vi.advanceTimersByTime(30_000);
      expect(rates.every(r => r <= 4)).toBe(true);
    });
  });

  describe("async retry restarts idle queue", () => {
    it("resumes processing when async failure enqueues retry after queue drained", async () => {
      expect.assertions(1);
      const throttle = createThrottledQueue({
        min_rpi: 5,
        interval: 1000,
        evenly_spaced: false,
        retry: 1,
      });

      let callCount = 0;
      throttle(async () => { callCount++; return false; });

      // First execution drains queue, then promise resolves → retry enqueued → start()
      await vi.advanceTimersByTimeAsync(1000);
      // Retry should now be queued and processing restarted
      await vi.advanceTimersByTimeAsync(1000);

      expect(callCount).toBe(2);
    });
  });

  describe("skippedLast blocks rate increase", () => {
    it("does not increase rate on the interval immediately after backoff", () => {
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

      // First interval: error triggers decrease + backoff (skippedLast = true)
      vi.advanceTimersByTime(1000);
      const ratesAfterDecrease = rates.length;

      // Next adjustRate fires 1000ms later with wasSkipped=true — should NOT increase
      vi.advanceTimersByTime(1000);
      expect(rates).toHaveLength(ratesAfterDecrease);
    });
  });

  describe("handle API", () => {
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
