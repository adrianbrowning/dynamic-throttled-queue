import type {
  AdjustmentTiming,
  RateFailureOutcome,
  RateOutcomeClassifier,
  RateStrategy,
  RateStrategyDecision
} from "./dynamic-throttled-queue.ts";

/**
 * Whether callbacks may start. `open` allows paced starts, `held` blocks starts until the module
 * reopens them, and `idle` means the module is not observing and waits for `start()`.
 */
export type Pacing = "idle" | "open" | "held";

/** Reports how one started callback settled: `undefined` for success, otherwise the failure. */
export type SettlementReporter = (outcome: RateFailureOutcome | undefined) => void;

export type AdaptiveRateOptions = {
  min_rpi: number;
  max_rpi: number;
  interval: number;
  errors_per_interval: number;
  back_off: boolean;
  adjustmentTiming: AdjustmentTiming;
  rateStrategy: RateStrategy;
  rateOutcomeClassifier?: RateOutcomeClassifier;
  onRateChange?: (rate: number) => void;
};

export type AdaptiveRateHost = {
  /** Whether accepted work is waiting to start. */
  hasPendingWork: () => boolean;
  /** Begins fresh pacing: the next paced start is one spacing from now. */
  resumeStarts: () => void;
  /** Cancels the next paced start, or reschedules it `deferBy` ms beyond one spacing from now. */
  holdStarts: (deferBy?: number) => void;
  /** Observation ended: cancel the next paced start. */
  idle: () => void;
  /** The rate strategy failed. Adaptive rate has already stopped; the error is rethrown after this returns. */
  failed: (error: unknown) => void;
};

export type AdaptiveRate = {
  readonly rate: number;
  readonly rateIncreases: number;
  readonly rateDecreases: number;
  readonly pacing: Pacing;
  /** Ends a pause, then begins observing if idle and work is pending. */
  start: () => void;
  /** Reports that every queued callback has started. */
  drained: () => void;
  /** Ends observation. Settled timing discards its in-progress window. */
  stop: () => void;
  /** Stops and discards the observation. Settlements are ignored until `start()` or `stop()`. */
  pause: () => void;
  /** Reports a callback start. Call the returned reporter once when that callback settles. */
  started: () => SettlementReporter;
};

type Timing = {
  start: () => void;
  started: () => SettlementReporter;
  drained: () => void;
  stop: () => void;
};

type TimingContext = {
  readonly interval: number;
  readonly pacing: Pacing;
  hasPendingWork: () => boolean;
  record: SettlementReporter;
  /** Makes one rate decision and returns whether starts must be held for a backoff. */
  decide: () => boolean;
  /** Opens starts with fresh pacing. */
  resume: () => void;
  /** Holds starts; `deferBy` keeps a deferred next start armed for when the hold ends. */
  hold: (deferBy?: number) => void;
  /** Opens starts without touching the deferred next start. */
  reopen: () => void;
  endBackoff: () => void;
  idle: () => void;
};

const ignoreSettlement: SettlementReporter = () => {};

function validateDecision(decision: unknown): RateStrategyDecision {
  if (typeof decision !== "object" || decision === null) {
    throw new TypeError("rate strategy must return a decision object");
  }
  const candidate = decision as RateStrategyDecision;
  if (!Number.isFinite(candidate.nextRate) || !Number.isInteger(candidate.nextRate)) {
    throw new TypeError("rate strategy must return a finite integer nextRate");
  }
  if (typeof candidate.shouldBackOff !== "boolean") {
    throw new TypeError("rate strategy must return a boolean shouldBackOff");
  }
  return candidate;
}

/** Decides every interval from the outcomes that settled during it, whenever those callbacks started. */
function intervalTiming(context: TimingContext): Timing {
  let tick: ReturnType<typeof setTimeout> | undefined;
  let run = 0;

  function adjust() {
    tick = undefined;
    const current = run;
    const hold = context.decide();
    if (current !== run) return;
    if (hold) context.hold(context.interval);
    else if (context.pacing === "held") context.reopen();
    tick = setTimeout(adjust, context.interval);
  }

  function stop() {
    clearTimeout(tick);
    tick = undefined;
    run++;
    context.idle();
  }

  return {
    start() {
      context.resume();
      tick = setTimeout(adjust, context.interval);
    },
    started: () => context.record,
    drained: stop,
    stop,
  };
}

/** Decides once every callback that started during one collection interval has settled. */
function settledTiming(context: TimingContext): Timing {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let window = 0;
  let collecting = false;
  let outstanding = 0;

  function open() {
    timer = undefined;
    if (!context.hasPendingWork()) {
      context.idle();
      return;
    }
    window++;
    collecting = true;
    outstanding = 0;
    context.resume();
    timer = setTimeout(close, context.interval);
  }

  function close() {
    timer = undefined;
    collecting = false;
    context.hold();
    if (outstanding === 0) finish();
  }

  function finish() {
    const current = window;
    const hold = context.decide();
    if (current !== window) return;
    if (hold) timer = setTimeout(endBackoff, context.interval);
    else open();
  }

  function endBackoff() {
    timer = undefined;
    context.endBackoff();
    if (context.hasPendingWork()) open();
  }

  return {
    start: open,
    started() {
      if (!collecting) return ignoreSettlement;
      const startedIn = window;
      outstanding++;
      return outcome => {
        if (startedIn !== window) return;
        context.record(outcome);
        outstanding--;
        if (!collecting && outstanding === 0) finish();
      };
    },
    drained() {},
    stop() {
      clearTimeout(timer);
      timer = undefined;
      collecting = false;
      window++;
      context.idle();
    },
  };
}

export function createAdaptiveRate(options: AdaptiveRateOptions, host: AdaptiveRateHost): AdaptiveRate {
  const { min_rpi, max_rpi, errors_per_interval, back_off, rateStrategy, rateOutcomeClassifier, onRateChange } = options;
  let rate = Math.ceil((max_rpi + min_rpi) / 2);
  let rateIncreases = 0;
  let rateDecreases = 0;
  let errorCount = 0;
  let wasBackedOff = false;
  let ignoringSettlements = false;
  let pacing: Pacing = "idle";

  function isRateReducing(outcome: RateFailureOutcome) {
    try {
      return rateOutcomeClassifier?.(outcome) ?? true;
    }
    catch {
      return true;
    }
  }

  function applyRate(next: number) {
    if (next === rate) return;
    if (next > rate) rateIncreases++;
    else rateDecreases++;
    rate = next;
    onRateChange?.(rate);
  }

  function decide() {
    const observation = Object.freeze({
      currentRate: rate,
      minRate: min_rpi,
      maxRate: max_rpi,
      errorCount,
      errorThreshold: errors_per_interval,
      hasPendingWork: host.hasPendingWork(),
      wasBackedOff,
    });
    let decision: RateStrategyDecision;
    try {
      decision = validateDecision(rateStrategy(observation));
    }
    catch (error) {
      timing.stop();
      host.failed(error);
      throw error;
    }
    const hold = back_off && decision.shouldBackOff;
    errorCount = 0;
    wasBackedOff = hold;
    applyRate(Math.min(max_rpi, Math.max(min_rpi, decision.nextRate)));
    return hold;
  }

  const context: TimingContext = {
    interval: options.interval,
    get pacing() {
      return pacing;
    },
    hasPendingWork: host.hasPendingWork,
    record(outcome) {
      if (!ignoringSettlements && outcome && isRateReducing(outcome)) errorCount++;
    },
    decide,
    resume() {
      pacing = "open";
      host.resumeStarts();
    },
    hold(deferBy) {
      pacing = "held";
      host.holdStarts(deferBy);
    },
    reopen() {
      pacing = "open";
    },
    endBackoff() {
      wasBackedOff = false;
    },
    idle() {
      wasBackedOff = false;
      pacing = "idle";
      host.idle();
    },
  };
  const timing = options.adjustmentTiming === "settled" ? settledTiming(context) : intervalTiming(context);

  return {
    get rate() {
      return rate;
    },
    get rateIncreases() {
      return rateIncreases;
    },
    get rateDecreases() {
      return rateDecreases;
    },
    get pacing() {
      return pacing;
    },
    start() {
      ignoringSettlements = false;
      if (pacing !== "idle" || !host.hasPendingWork()) return;
      timing.start();
    },
    drained() {
      timing.drained();
    },
    stop() {
      ignoringSettlements = false;
      timing.stop();
    },
    pause() {
      timing.stop();
      errorCount = 0;
      ignoringSettlements = true;
    },
    started: () => timing.started(),
  };
}
