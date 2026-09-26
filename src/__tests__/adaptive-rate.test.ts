import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdaptiveRate } from "../adaptive-rate.ts";
import type { AdaptiveRate, AdaptiveRateOptions } from "../adaptive-rate.ts";
import { aimd } from "../dynamic-throttled-queue.ts";
import type { RateFailureOutcome, RateStrategy } from "../dynamic-throttled-queue.ts";

const returnedFalse: RateFailureOutcome = { kind: "returned-false" };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Starts observing over a 1..5 range (midpoint 3) with a one-failure threshold and a 1000 ms interval. */
function observe(options: Partial<AdaptiveRateOptions> = {}, { pending = true } = {}) {
  const work = { pending };
  const failures: Array<unknown> = [];
  const adaptive = createAdaptiveRate({
    min_rpi: 1,
    max_rpi: 5,
    interval: 1000,
    errors_per_interval: 1,
    back_off: false,
    adjustmentTiming: "interval",
    rateStrategy: aimd(),
    ...options,
  }, {
    hasPendingWork: () => work.pending,
    resumeStarts: () => {},
    holdStarts: () => {},
    idle: () => {},
    failed: error => failures.push(error),
  });
  adaptive.start();
  return { adaptive, work, failures };
}

function settleStarts(adaptive: AdaptiveRate, count: number, outcome?: RateFailureOutcome) {
  for (let i = 0; i < count; i++) adaptive.started()(outcome);
}

describe("adaptive rate", () => {
  describe("interval timing", () => {
    it("starts at the midpoint of its range and stays idle until work is pending", () => {
      const { adaptive, work } = observe({}, { pending: false });

      expect(adaptive.rate).toBe(3);
      expect(adaptive.pacing).toBe("idle");

      work.pending = true;
      adaptive.start();
      expect(adaptive.pacing).toBe("open");
    });

    it.each([
      { name: "lowers the rate when failures reach the threshold", failures: 2, pending: true, expectedRate: 1 },
      { name: "holds the rate when failures stay below the threshold", failures: 1, pending: true, expectedRate: 3 },
      { name: "raises the rate after a clean interval with pending work", failures: 0, pending: true, expectedRate: 4 },
      { name: "holds the rate after a clean interval without pending work", failures: 0, pending: false, expectedRate: 3 },
    ])("$name", ({ failures, pending, expectedRate }) => {
      const { adaptive, work } = observe({ errors_per_interval: 2 });

      settleStarts(adaptive, failures, returnedFalse);
      work.pending = pending;
      vi.advanceTimersByTime(1000);

      expect(adaptive.rate).toBe(expectedRate);
    });

    it("counts an outcome in the interval where it settles rather than where it started", () => {
      const { adaptive } = observe();

      const report = adaptive.started();
      vi.advanceTimersByTime(1000);
      expect(adaptive.rate).toBe(4);

      report(returnedFalse);
      vi.advanceTimersByTime(1000);
      expect(adaptive.rate).toBe(2);
    });

    it("keeps failures that settle while idle for the first decision after a restart", () => {
      const { adaptive } = observe();

      const report = adaptive.started();
      adaptive.drained();
      expect(adaptive.pacing).toBe("idle");

      report(returnedFalse);
      vi.advanceTimersByTime(5000);
      expect(adaptive.rate).toBe(3);

      adaptive.start();
      vi.advanceTimersByTime(1000);
      expect(adaptive.rate).toBe(1);
    });

    it("makes one decision per interval when started again while observing", () => {
      const { adaptive } = observe();

      adaptive.start();
      vi.advanceTimersByTime(1000);

      expect(adaptive.rate).toBe(4);
      expect(adaptive.rateIncreases).toBe(1);
    });

    it("discards the observation on pause and ignores settlements until restarted", () => {
      const { adaptive } = observe();

      settleStarts(adaptive, 1, returnedFalse);
      const report = adaptive.started();
      adaptive.pause();
      expect(adaptive.pacing).toBe("idle");

      report(returnedFalse);
      adaptive.start();
      vi.advanceTimersByTime(1000);

      expect(adaptive.rate).toBe(4);
    });
  });

  describe("failure classification", () => {
    it("never counts a success", () => {
      const { adaptive } = observe();

      settleStarts(adaptive, 5);
      vi.advanceTimersByTime(1000);

      expect(adaptive.rate).toBe(4);
    });

    it.each([
      { outcome: returnedFalse, expectedRate: 4 },
      { outcome: { kind: "thrown", error: new Error("thrown") } as const, expectedRate: 1 },
      { outcome: { kind: "rejected", error: new Error("rejected") } as const, expectedRate: 1 },
    ])("counts a $outcome.kind failure only when the classifier marks it rate-reducing", ({ outcome, expectedRate }) => {
      const { adaptive } = observe({ rateOutcomeClassifier: ({ kind }) => kind !== "returned-false" });

      settleStarts(adaptive, 1, outcome);
      vi.advanceTimersByTime(1000);

      expect(adaptive.rate).toBe(expectedRate);
    });

    it("counts a failure as rate-reducing when the classifier throws", () => {
      const { adaptive } = observe({ rateOutcomeClassifier: () => { throw new Error("classifier failed"); } });

      settleStarts(adaptive, 1, returnedFalse);
      vi.advanceTimersByTime(1000);

      expect(adaptive.rate).toBe(1);
    });
  });

  describe("rate application", () => {
    it("clamps decisions to the configured range and counts only actual changes", () => {
      const rates: Array<number> = [];
      const { adaptive } = observe({ rateStrategy: aimd({ increaseBy: 4 }), onRateChange: rate => rates.push(rate) });

      vi.advanceTimersByTime(2000);
      expect(adaptive.rate).toBe(5);

      settleStarts(adaptive, 1, returnedFalse);
      vi.advanceTimersByTime(1000);
      settleStarts(adaptive, 1, returnedFalse);
      vi.advanceTimersByTime(1000);
      settleStarts(adaptive, 1, returnedFalse);
      vi.advanceTimersByTime(1000);

      expect(adaptive.rate).toBe(1);
      expect(rates).toEqual([ 5, 2, 1 ]);
      expect(adaptive.rateIncreases).toBe(1);
      expect(adaptive.rateDecreases).toBe(2);
    });

    it("gives the strategy a frozen observation", () => {
      const { adaptive } = observe({
        rateStrategy: observation => ({
          nextRate: Object.isFrozen(observation) ? observation.maxRate : observation.minRate,
          shouldBackOff: false,
        }),
      });

      vi.advanceTimersByTime(1000);

      expect(adaptive.rate).toBe(5);
    });
  });

  describe("backoff", () => {
    it("holds starts for one interval and makes no increase in the interval that follows", () => {
      const { adaptive } = observe({ back_off: true });

      settleStarts(adaptive, 1, returnedFalse);
      vi.advanceTimersByTime(1000);
      expect(adaptive.rate).toBe(1);
      expect(adaptive.pacing).toBe("held");

      vi.advanceTimersByTime(1000);
      expect(adaptive.rate).toBe(1);
      expect(adaptive.pacing).toBe("open");

      vi.advanceTimersByTime(1000);
      expect(adaptive.rate).toBe(2);
    });

    it("keeps starts open when back_off is disabled", () => {
      const { adaptive } = observe({ back_off: false });

      settleStarts(adaptive, 1, returnedFalse);
      vi.advanceTimersByTime(1000);

      expect(adaptive.rate).toBe(1);
      expect(adaptive.pacing).toBe("open");
    });
  });

  describe("strategy failure", () => {
    const failure = new Error("strategy failed");

    it.each([
      { name: "a thrown error", strategy: () => { throw failure; }, error: failure },
      { name: "a missing decision", strategy: (() => undefined) as unknown as RateStrategy, error: TypeError },
      { name: "a fractional rate", strategy: () => ({ nextRate: 1.5, shouldBackOff: false }), error: TypeError },
      { name: "a non-finite rate", strategy: () => ({ nextRate: Infinity, shouldBackOff: false }), error: TypeError },
      {
        name: "a non-boolean backoff recommendation",
        strategy: (() => ({ nextRate: 1, shouldBackOff: 1 })) as unknown as RateStrategy,
        error: TypeError,
      },
    ])("reports the failure on $name without applying a decision or scheduling another", ({ strategy, error }) => {
      const { adaptive, failures } = observe({ rateStrategy: strategy });

      expect(() => vi.advanceTimersByTime(1000)).toThrow(error);
      expect(vi.getTimerCount()).toBe(0);
      expect(failures).toHaveLength(1);
      expect(() => { throw failures[0]; }).toThrow(error);
      expect(adaptive.rate).toBe(3);
    });
  });

  describe("settled timing", () => {
    it("decides only after every start from the collection interval settles", () => {
      const { adaptive } = observe({ adjustmentTiming: "settled" });

      const slow = adaptive.started();
      settleStarts(adaptive, 1);
      vi.advanceTimersByTime(1000);
      expect(adaptive.pacing).toBe("held");

      vi.advanceTimersByTime(5000);
      expect(adaptive.rate).toBe(3);

      slow(returnedFalse);
      expect(adaptive.rate).toBe(1);
      expect(adaptive.pacing).toBe("open");
    });

    it("goes idle after a decision when no work is pending", () => {
      const { adaptive, work } = observe({ adjustmentTiming: "settled" });

      settleStarts(adaptive, 1);
      work.pending = false;
      vi.advanceTimersByTime(1000);

      expect(adaptive.pacing).toBe("idle");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("backs off for one interval before collecting the next window", () => {
      const { adaptive } = observe({ adjustmentTiming: "settled", back_off: true });

      settleStarts(adaptive, 1, returnedFalse);
      vi.advanceTimersByTime(1000);
      expect(adaptive.rate).toBe(1);
      expect(adaptive.pacing).toBe("held");

      vi.advanceTimersByTime(999);
      expect(adaptive.pacing).toBe("held");
      vi.advanceTimersByTime(1);
      expect(adaptive.pacing).toBe("open");
    });

    it.each([ "pause", "stop" ] as const)("discards the in-progress window on %s", method => {
      const { adaptive } = observe({ adjustmentTiming: "settled" });

      const report = adaptive.started();
      adaptive[method]();
      expect(adaptive.pacing).toBe("idle");

      report(returnedFalse);
      adaptive.start();
      settleStarts(adaptive, 1);
      vi.advanceTimersByTime(1000);

      expect(adaptive.rate).toBe(4);
    });
  });
});
