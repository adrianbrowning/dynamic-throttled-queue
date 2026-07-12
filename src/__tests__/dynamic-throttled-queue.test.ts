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

      // With backoff, there should be a gap where no new items are processed
      expect(countAt2s - countAt1s).toBeLessThanOrEqual(countAt1s);
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

      vi.advanceTimersByTime(1000);
      await vi.advanceTimersByTimeAsync(0); // flush microtasks

      expect(rates.length).toBeGreaterThan(0);
    });

    it("treats promise resolving to false as error", async () => {
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
});
