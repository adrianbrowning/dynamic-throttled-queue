import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThrottledQueue } from "../dynamic-throttled-queue.ts";
import type { ThrottleOptions } from "../dynamic-throttled-queue.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Rate 10 per 1000 ms interval: evenly spaced starts are due every 100 ms. */
function queue(options: Partial<ThrottleOptions> = {}) {
  const throttle = createThrottledQueue({ min_rpi: 10, interval: 1000, ...options });
  const begin = Date.now();
  const starts: Array<number> = [];
  const add = (count: number) => {
    for (let i = 0; i < count; i++) throttle(() => { starts.push(Date.now() - begin); });
  };
  return { throttle, starts, add };
}

function deferred<T = void>() {
  return Promise.withResolvers<T>();
}

describe("cooldownFor", () => {
  describe("scheduling", () => {
    it("holds new starts until the deadline, keeps pending and active work, then resumes without a new enqueue", async () => {
      const { throttle, starts, add } = queue();
      const slow = deferred();
      throttle(async () => slow.promise);
      add(2);

      vi.advanceTimersByTime(100);
      throttle.cooldownFor(500);
      await vi.advanceTimersByTimeAsync(499);
      expect(starts).toEqual([]);
      expect(throttle.getState()).toMatchObject({ pending: 2, active: 1, cooldownRemaining: 1 });

      slow.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(throttle.getState()).toMatchObject({ succeeded: 1, active: 0 });
      expect(starts).toEqual([]);

      // Expires at 600; the first start is due one spacing later, as after any fresh start.
      await vi.advanceTimersByTimeAsync(1);
      expect(throttle.getState().cooldownRemaining).toBe(0);
      await vi.advanceTimersByTimeAsync(200);
      expect(starts).toEqual([ 700, 800 ]);
    });

    it("extends to the latest deadline, never shortens it, and counts only actual extensions", () => {
      const { throttle, starts, add } = queue();
      add(1);

      throttle.cooldownFor(500);
      throttle.cooldownFor(500);
      expect(throttle.getState()).toMatchObject({ cooldownRemaining: 500, cooldowns: 1, cooldownTotal: 500 });

      vi.advanceTimersByTime(100);
      throttle.cooldownFor(200);
      expect(throttle.getState()).toMatchObject({ cooldownRemaining: 400, cooldowns: 1, cooldownTotal: 500 });

      throttle.cooldownFor(600);
      expect(throttle.getState()).toMatchObject({ cooldownRemaining: 600, cooldowns: 2, cooldownTotal: 700 });

      vi.advanceTimersByTime(699);
      expect(starts).toEqual([]);
      vi.advanceTimersByTime(101);
      expect(starts).toEqual([ 800 ]);
    });

    it("treats a zero delay as no cooldown and leaves a start that is already due", () => {
      const { throttle, starts, add } = queue();
      add(1);

      throttle.cooldownFor(0);
      vi.advanceTimersByTime(100);

      expect(starts).toEqual([ 100 ]);
      expect(throttle.getState()).toMatchObject({ cooldownRemaining: 0, cooldowns: 0, cooldownTotal: 0 });
    });

    it("stops the rest of a batch when a callback requests a cooldown", () => {
      const throttle = createThrottledQueue({ min_rpi: 3, interval: 1000, evenly_spaced: false });
      let ran = 0;
      throttle(() => { ran++; throttle.cooldownFor(5000); });
      throttle(() => { ran++; });
      throttle(() => { ran++; });

      vi.advanceTimersByTime(1000);

      expect(ran).toBe(1);
      expect(throttle.getState()).toMatchObject({ pending: 2, cooldownRemaining: 5000 });
    });
  });

  describe("validation and bounds", () => {
    it.each([ NaN, -1, Infinity, -Infinity ])("throws a RangeError for %s without changing state", delay => {
      const { throttle } = queue();

      expect(() => throttle.cooldownFor(delay)).toThrow(RangeError);
      expect(throttle.getState()).toMatchObject({ cooldownRemaining: 0, cooldowns: 0 });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects an invalid maxCooldown at queue creation", () => {
      expect(() => createThrottledQueue({ min_rpi: 1, interval: 1000, maxCooldown: 2_147_483_647 })).not.toThrow();
      expect(() => createThrottledQueue({ min_rpi: 1, interval: 1000, maxCooldown: 0.5 })).not.toThrow();

      for (const maxCooldown of [ 0, -1, NaN, Infinity, 2_147_483_648 ]) {
        expect(() => createThrottledQueue({ min_rpi: 1, interval: 1000, maxCooldown })).toThrow("maxCooldown");
      }
    });

    it("clamps a longer request to maxCooldown and still holds starts until then", () => {
      const { throttle, starts, add } = queue({ maxCooldown: 1000 });
      add(1);

      throttle.cooldownFor(1e12);
      expect(throttle.getState()).toMatchObject({ cooldownRemaining: 1000, cooldownTotal: 1000 });

      vi.advanceTimersByTime(1099);
      expect(starts).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(starts).toEqual([ 1100 ]);
    });

    it("clamps to the timer limit by default instead of letting an oversized timer fire early", () => {
      const { throttle, starts, add } = queue();
      add(1);

      throttle.cooldownFor(Number.MAX_SAFE_INTEGER);
      vi.advanceTimersByTime(60_000);

      expect(starts).toEqual([]);
      expect(throttle.getState().cooldownRemaining).toBe(2_147_483_647 - 60_000);
    });
  });

  describe("lifecycle composition", () => {
    it("keeps elapsing while paused, and expiry does not resume a paused queue", () => {
      const { throttle, starts, add } = queue();
      add(1);

      throttle.cooldownFor(500);
      vi.advanceTimersByTime(100);
      throttle.pause();
      vi.advanceTimersByTime(1000);

      expect(starts).toEqual([]);
      expect(throttle.getState()).toMatchObject({ state: "paused", cooldownRemaining: 0 });

      throttle.resume();
      vi.advanceTimersByTime(100);
      expect(starts).toEqual([ 1200 ]);
    });

    it("is not bypassed by resume() when requested while paused", () => {
      const { throttle, starts, add } = queue();
      add(1);

      throttle.pause();
      throttle.cooldownFor(500);
      vi.advanceTimersByTime(100);
      throttle.resume();

      vi.advanceTimersByTime(499);
      expect(starts).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(starts).toEqual([ 600 ]);
    });

    it("survives stop() and a restarting enqueue, holding starts until the original deadline", () => {
      const { throttle, starts, add } = queue();
      add(1);

      throttle.cooldownFor(500);
      throttle.stop();
      expect(vi.getTimerCount()).toBe(0);
      expect(throttle.getState().cooldownRemaining).toBe(500);

      vi.advanceTimersByTime(100);
      add(1);
      vi.advanceTimersByTime(499);
      expect(starts).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(starts).toEqual([ 600 ]);
    });

    it("lets a stopped cooldown expire unseen, so a later restart starts normally", () => {
      const { throttle, starts, add } = queue();
      add(1);

      throttle.cooldownFor(500);
      throttle.stop();
      vi.advanceTimersByTime(1000);
      add(1);
      vi.advanceTimersByTime(100);

      expect(starts).toEqual([ 1100 ]);
      expect(throttle.getState().cooldownRemaining).toBe(0);
    });

    it("is cleared by abort(), and later requests do nothing", () => {
      const { throttle, add } = queue();
      add(1);

      throttle.cooldownFor(500);
      throttle.abort();
      expect(vi.getTimerCount()).toBe(0);
      expect(throttle.getState().cooldownRemaining).toBe(0);

      throttle.cooldownFor(500);
      expect(vi.getTimerCount()).toBe(0);
      expect(throttle.getState()).toMatchObject({ cooldownRemaining: 0, cooldowns: 1 });
    });

    it("does nothing after terminal failure and leaves no timer", () => {
      const failure = new Error("strategy failed");
      const { throttle, add } = queue({ rateStrategy: () => { throw failure; } });
      add(20);

      expect(() => vi.advanceTimersByTime(1000)).toThrow(failure);
      throttle.cooldownFor(500);

      expect(throttle.getState()).toMatchObject({ state: "failed", cooldownRemaining: 0, cooldowns: 0 });
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("adaptive rate", () => {
    it("makes no rate decision while cooling down, so quiet intervals do not raise the rate", () => {
      const { throttle, add } = queue({ min_rpi: 1, max_rpi: 10 });
      add(50);

      throttle.cooldownFor(5000);
      vi.advanceTimersByTime(5000);

      expect(throttle.getState()).toMatchObject({ rate: 6, rateIncreases: 0, started: 0 });
    });

    it.each([
      { adjustmentTiming: "interval" as const, decidesAt: 1000 },
      { adjustmentTiming: "settled" as const, decidesAt: 0 },
    ])("counts failures that settle during a cooldown toward the first $adjustmentTiming decision after it", async ({ adjustmentTiming, decidesAt }) => {
      const { throttle, add } = queue({ min_rpi: 1, max_rpi: 10, errors_per_interval: 1, adjustmentTiming });
      const slow = deferred<boolean>();
      throttle(async () => slow.promise);
      add(20);

      await vi.advanceTimersByTimeAsync(200);
      throttle.cooldownFor(3000);
      slow.resolve(false);
      await vi.advanceTimersByTimeAsync(2999);
      expect(throttle.getState()).toMatchObject({ rate: 6, rateDecreases: 0 });

      // Interval timing starts a fresh interval at expiry; settled timing decides the suspended window then.
      await vi.advanceTimersByTimeAsync(1 + decidesAt);
      expect(throttle.getState()).toMatchObject({ rate: 5, rateDecreases: 1, rateIncreases: 0 });
    });

    it.each([ "interval", "settled" ] as const)("replaces a pending %s backoff: starts resume one spacing after the cooldown ends", adjustmentTiming => {
      const throttle = createThrottledQueue({ min_rpi: 1, max_rpi: 10, interval: 1000, errors_per_interval: 1, back_off: true, adjustmentTiming });
      const begin = Date.now();
      const starts: Array<number> = [];
      throttle(() => { starts.push(Date.now() - begin); return false; });
      for (let i = 0; i < 20; i++) throttle(() => { starts.push(Date.now() - begin); });

      // The failure at ~167 ms backs off at 1000 ms: without a cooldown the next start is due at 2200 ms.
      vi.advanceTimersByTime(1000);
      expect(throttle.getState().rate).toBe(5);
      throttle.cooldownFor(100);
      vi.advanceTimersByTime(300);

      expect(starts.filter(at => at > 1000)).toEqual([ 1300 ]);
    });

    it.each([ "interval", "settled" ] as const)("ignores outcomes that settle while paused, as without a cooldown (%s timing)", async adjustmentTiming => {
      const { throttle, add } = queue({ min_rpi: 1, max_rpi: 10, errors_per_interval: 1, adjustmentTiming });
      const slow = Promise.withResolvers<boolean>();
      throttle(async () => slow.promise);
      add(20);

      await vi.advanceTimersByTimeAsync(200);
      throttle.pause();
      throttle.cooldownFor(500);
      slow.resolve(false);
      await vi.advanceTimersByTimeAsync(100);
      throttle.resume();
      await vi.advanceTimersByTimeAsync(3000);

      // The cooldown ends at 700 ms; the decisions at 1700 and 2700 ms see no counted failure.
      expect(throttle.getState()).toMatchObject({ failed: 1, rate: 8, rateIncreases: 2, rateDecreases: 0 });
    });
  });
});
