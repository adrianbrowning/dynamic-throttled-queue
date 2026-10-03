import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aimd, createAdaptiveRate } from "../adaptive-rate.ts";
import type { AdaptiveRate, AdaptiveRateOptions, RateFailureOutcome, RateStrategy, SettlementReporter } from "../adaptive-rate.ts";

const returnedFalse: RateFailureOutcome = { kind: "returned-false" };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

type HostOptions = {
  /** Callbacks waiting to start. */
  queued?: number;
  /** Free concurrency slots. The default of none makes every due start find concurrency full. */
  slots?: number;
  /** Runs inside each `startsDue` call, after its starts. */
  during?: (adaptive: AdaptiveRate) => void;
};

/**
 * Starts observing over a 1..5 range (midpoint 3) with a one-failure threshold and a 1000 ms interval.
 * The host records when starts become due (ms since observing began) and with what limit, and starts
 * up to `limit` callbacks as its queue and free slots allow.
 */
function observe(options: Partial<AdaptiveRateOptions> = {}, { queued = Infinity, slots = 0, during }: HostOptions = {}) {
  const work = { queued, slots };
  const due: Array<{ at: number; limit: number; }> = [];
  const reporters: Array<SettlementReporter> = [];
  const failures: Array<unknown> = [];
  const begin = Date.now();
  const adaptive: AdaptiveRate = createAdaptiveRate({
    min_rpi: 1,
    max_rpi: 5,
    interval: 1000,
    evenly_spaced: true,
    errors_per_interval: 1,
    back_off: false,
    adjustmentTiming: "interval",
    rateStrategy: aimd(),
    ...options,
  }, {
    hasPendingWork: () => work.queued > 0,
    startsDue(limit) {
      due.push({ at: Date.now() - begin, limit });
      const count = Math.min(limit, work.queued, work.slots);
      for (let i = 0; i < count; i++) {
        work.queued--;
        work.slots--;
        reporters.push(adaptive.started());
      }
      during?.(adaptive);
      return work.slots > 0;
    },
    failed: error => failures.push(error),
  });
  adaptive.start();
  return { adaptive, work, due, reporters, failures };
}

function settleStarts(adaptive: AdaptiveRate, count: number, outcome?: RateFailureOutcome) {
  for (let i = 0; i < count; i++) adaptive.started()(outcome);
}

const dueTimes = (due: Array<{ at: number; }>) => due.map(({ at }) => at);

describe("adaptive rate", () => {
  describe("start clock", () => {
    it("makes no start due until work is pending, then the first one spacing after observing begins", () => {
      const { adaptive, work, due } = observe({ interval: 1200 }, { queued: 0 });

      expect(adaptive.rate).toBe(3);
      vi.advanceTimersByTime(5000);
      expect(due).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);

      work.queued = Infinity;
      adaptive.start();
      vi.advanceTimersByTime(400);
      expect(due).toEqual([{ at: 5400, limit: 1 }]);
    });

    it("makes one start due every spacing while starts happen", () => {
      const { due } = observe({ min_rpi: 4, max_rpi: 4 }, { slots: Infinity });

      vi.advanceTimersByTime(1000);

      expect(due).toEqual([ 250, 500, 750, 1000 ].map(at => ({ at, limit: 1 })));
    });

    it("makes the whole rate due once per interval when not evenly spaced", () => {
      const { due } = observe({ evenly_spaced: false }, { slots: Infinity });

      vi.advanceTimersByTime(2000);

      expect(due).toEqual([{ at: 1000, limit: 3 }, { at: 2000, limit: 4 }]);
    });

    it("waits for the longer spacing when the rate falls before the next start is due", () => {
      const { adaptive, due } = observe({ interval: 1200 }, { slots: Infinity });

      settleStarts(adaptive, 1, returnedFalse);
      vi.advanceTimersByTime(2000);

      expect(adaptive.rate).toBe(1);
      expect(dueTimes(due)).toEqual([ 400, 800, 2000 ]);
    });

    it("makes no further start due once a batch fills concurrency, until start() reports a freed slot", () => {
      const { adaptive, work, due } = observe({ evenly_spaced: false }, { slots: 1 });

      vi.advanceTimersByTime(5000);
      expect(due).toEqual([{ at: 1000, limit: 3 }]);

      work.slots = 1;
      adaptive.start();
      expect(dueTimes(due)).toEqual([ 1000, 5000 ]);
    });

    it("waits out the rest of the spacing when start() reports a freed slot early", () => {
      const { adaptive, work, due } = observe({ evenly_spaced: false }, { slots: 1 });

      vi.advanceTimersByTime(1500);
      work.slots = 1;
      adaptive.start();
      expect(dueTimes(due)).toEqual([ 1000 ]);

      vi.advanceTimersByTime(500);
      expect(dueTimes(due)).toEqual([ 1000, 2000 ]);
    });

    it("leaves a scheduled start in place when start() reports a freed slot", () => {
      const { adaptive, work, due } = observe({ min_rpi: 4, max_rpi: 4 }, { slots: 2 });

      vi.advanceTimersByTime(300);
      work.slots = 2;
      adaptive.start();
      expect(dueTimes(due)).toEqual([ 250 ]);

      vi.advanceTimersByTime(200);
      expect(dueTimes(due)).toEqual([ 250, 500 ]);
    });

    it("goes idle when a batch leaves nothing pending, and observes again on the next start()", () => {
      const { adaptive, work, due } = observe({ min_rpi: 4, max_rpi: 4 }, { queued: 1, slots: Infinity });

      vi.advanceTimersByTime(250);
      expect(vi.getTimerCount()).toBe(0);

      work.queued = 1;
      adaptive.start();
      vi.advanceTimersByTime(250);
      expect(dueTimes(due)).toEqual([ 250, 500 ]);
    });

    it("makes no nested batch when start() is called during startsDue", () => {
      const { due } = observe({ min_rpi: 4, max_rpi: 4 }, { slots: Infinity, during: adaptive => adaptive.start() });

      vi.advanceTimersByTime(500);

      expect(dueTimes(due)).toEqual([ 250, 500 ]);
    });

    it("makes no further start due after a pause during startsDue", () => {
      const { due } = observe({ min_rpi: 4, max_rpi: 4 }, { slots: Infinity, during: adaptive => adaptive.pause() });

      vi.advanceTimersByTime(5000);

      expect(dueTimes(due)).toEqual([ 250 ]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("paces from the resume after a pause and resume during startsDue, with one start due per spacing", () => {
      let resumed = false;
      const { adaptive, due } = observe({ min_rpi: 4, max_rpi: 4 }, {
        slots: Infinity,
        during: observed => {
          if (resumed) return;
          resumed = true;
          observed.pause();
          observed.start();
        },
      });

      vi.advanceTimersByTime(1000);

      expect(dueTimes(due)).toEqual([ 250, 500, 750, 1000 ]);
      expect(adaptive.rate).toBe(4);
    });
  });

  describe("interval timing", () => {
    it.each([
      { name: "lowers the rate when failures reach the threshold", failures: 2, expectedRate: 1 },
      { name: "holds the rate when failures stay below the threshold", failures: 1, expectedRate: 3 },
      { name: "raises the rate after a clean interval with pending work", failures: 0, expectedRate: 4 },
    ])("$name", ({ failures, expectedRate }) => {
      const { adaptive } = observe({ errors_per_interval: 2 });

      settleStarts(adaptive, failures, returnedFalse);
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
      const { adaptive, work, reporters } = observe({}, { queued: 1, slots: 1 });

      vi.advanceTimersByTime(400);
      expect(vi.getTimerCount()).toBe(0);

      reporters[0]?.(returnedFalse);
      vi.advanceTimersByTime(5000);
      expect(adaptive.rate).toBe(3);

      work.queued = Infinity;
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
      expect(vi.getTimerCount()).toBe(0);

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
    it("makes no start due for one interval, even when a slot frees, then makes no increase in the interval that follows", () => {
      const { adaptive, work, due } = observe({ interval: 1200, back_off: true });

      settleStarts(adaptive, 1, returnedFalse);
      vi.advanceTimersByTime(1500);
      expect(adaptive.rate).toBe(1);

      work.slots = Infinity;
      adaptive.start();
      vi.advanceTimersByTime(900);
      expect(adaptive.rate).toBe(1);
      expect(dueTimes(due)).toEqual([ 400 ]);

      vi.advanceTimersByTime(1200);
      expect(dueTimes(due)).toEqual([ 400, 3600 ]);
      expect(adaptive.rate).toBe(2);
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
    it("decides only after every start from the collection interval settles, then opens fresh pacing", () => {
      const { adaptive, due } = observe({ adjustmentTiming: "settled", interval: 1200 });

      const slow = adaptive.started();
      settleStarts(adaptive, 1);
      vi.advanceTimersByTime(6000);
      expect(adaptive.rate).toBe(3);
      expect(dueTimes(due)).toEqual([ 400 ]);

      slow(returnedFalse);
      expect(adaptive.rate).toBe(1);
      vi.advanceTimersByTime(1200);
      expect(dueTimes(due)).toEqual([ 400, 7200 ]);
    });

    it("keeps making starts due every spacing while a window is open with nothing queued", () => {
      const { adaptive, work, due } = observe({ adjustmentTiming: "settled", min_rpi: 4, max_rpi: 4 }, { queued: 1, slots: Infinity });

      vi.advanceTimersByTime(600);
      expect(dueTimes(due)).toEqual([ 250, 500 ]);

      work.queued = 1;
      adaptive.start();
      vi.advanceTimersByTime(150);
      expect(dueTimes(due)).toEqual([ 250, 500, 750 ]);
      expect(work.queued).toBe(0);
    });

    it("holds the rate and goes idle after a decision when no work is pending", () => {
      const { adaptive, work } = observe({ adjustmentTiming: "settled" });

      settleStarts(adaptive, 1);
      work.queued = 0;
      vi.advanceTimersByTime(1000);

      expect(adaptive.rate).toBe(3);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("backs off for one interval, then opens a window with fresh pacing", () => {
      const { adaptive, due } = observe({ adjustmentTiming: "settled", back_off: true, interval: 1200 });

      settleStarts(adaptive, 1, returnedFalse);
      vi.advanceTimersByTime(1200);
      expect(adaptive.rate).toBe(1);

      vi.advanceTimersByTime(2399);
      expect(dueTimes(due)).toEqual([ 400 ]);
      vi.advanceTimersByTime(1);
      expect(dueTimes(due)).toEqual([ 400, 3600 ]);
    });

    it("holds the rate steady in the window collected right after a backoff", () => {
      const { adaptive } = observe({ adjustmentTiming: "settled", back_off: true });

      settleStarts(adaptive, 1, returnedFalse);
      vi.advanceTimersByTime(2000);

      settleStarts(adaptive, 1);
      vi.advanceTimersByTime(1000);
      expect(adaptive.rate).toBe(1);

      settleStarts(adaptive, 1);
      vi.advanceTimersByTime(1000);
      expect(adaptive.rate).toBe(2);
    });

    it("goes idle when a backoff ends with no pending work, and observes again on the next start", () => {
      const { adaptive, work, due } = observe({ adjustmentTiming: "settled", back_off: true });

      settleStarts(adaptive, 1, returnedFalse);
      work.queued = 0;
      vi.advanceTimersByTime(2000);
      expect(vi.getTimerCount()).toBe(0);

      work.queued = Infinity;
      adaptive.start();
      vi.advanceTimersByTime(1000);
      expect(due.at(-1)?.at).toBe(3000);
    });

    it("makes no decision for a collection interval in which nothing started", () => {
      const strategy = vi.fn(aimd());
      const { adaptive } = observe({ adjustmentTiming: "settled", rateStrategy: strategy });

      vi.advanceTimersByTime(1000);
      expect(strategy).not.toHaveBeenCalled();

      settleStarts(adaptive, 1);
      vi.advanceTimersByTime(1000);
      expect(strategy).toHaveBeenCalledOnce();
      expect(adaptive.rate).toBe(4);
    });

    it("goes idle after an empty collection interval when no work is pending", () => {
      const strategy = vi.fn(aimd());
      const { work } = observe({ adjustmentTiming: "settled", rateStrategy: strategy });

      work.queued = 0;
      vi.advanceTimersByTime(1000);

      expect(strategy).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([ "pause", "stop" ] as const)("discards the in-progress window on %s", method => {
      const { adaptive } = observe({ adjustmentTiming: "settled" });

      const report = adaptive.started();
      adaptive[method]();
      expect(vi.getTimerCount()).toBe(0);

      report(returnedFalse);
      adaptive.start();
      settleStarts(adaptive, 1);
      vi.advanceTimersByTime(1000);

      expect(adaptive.rate).toBe(4);
    });
  });
});
