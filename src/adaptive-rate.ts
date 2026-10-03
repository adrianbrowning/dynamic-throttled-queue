export type RateStrategyObservation = Readonly<{
  currentRate: number;
  minRate: number;
  maxRate: number;
  errorCount: number;
  errorThreshold: number;
  hasPendingWork: boolean;
  wasBackedOff: boolean;
}>;

export type RateStrategyDecision = Readonly<{
  nextRate: number;
  shouldBackOff: boolean;
}>;

export type RateStrategy = (observation: RateStrategyObservation) => RateStrategyDecision;

export type AimdOptions = {
  increaseBy?: number;
  decreaseFactor?: number;
};

export type RateFailureOutcome =
  | Readonly<{ kind: "returned-false"; }>
  | Readonly<{ kind: "thrown"; error: unknown; }>
  | Readonly<{ kind: "rejected"; error: unknown; }>;

export type RateOutcomeClassifier = (outcome: RateFailureOutcome) => boolean;

export type AdjustmentTiming = "interval" | "settled";

export const linear: RateStrategy = ({
  minRate,
  maxRate,
  currentRate,
  errorCount,
  errorThreshold,
  hasPendingWork,
  wasBackedOff,
}) => {
  if (errorCount >= errorThreshold) {
    return { nextRate: Math.max(minRate, currentRate - 1), shouldBackOff: true };
  }
  if (!wasBackedOff && errorCount === 0 && hasPendingWork) {
    return { nextRate: Math.min(maxRate, currentRate + 1), shouldBackOff: false };
  }
  return { nextRate: currentRate, shouldBackOff: false };
};

export function aimd({ increaseBy = 1, decreaseFactor = 0.5 }: AimdOptions = {}): RateStrategy {
  if (!Number.isInteger(increaseBy) || increaseBy < 1) {
    throw new Error("increaseBy must be a positive integer");
  }
  if (!Number.isFinite(decreaseFactor) || decreaseFactor <= 0 || decreaseFactor >= 1) {
    throw new Error("decreaseFactor must be a number greater than 0 and less than 1");
  }
  return ({ currentRate, errorCount, errorThreshold, hasPendingWork, wasBackedOff }) => {
    if (errorCount >= errorThreshold) {
      return { nextRate: Math.floor(currentRate * decreaseFactor), shouldBackOff: true };
    }
    if (!wasBackedOff && errorCount === 0 && hasPendingWork) {
      return { nextRate: currentRate + increaseBy, shouldBackOff: false };
    }
    return { nextRate: currentRate, shouldBackOff: false };
  };
}

/**
 * Whether starts may become due. `open` makes paced starts due, `held` makes none due until the module
 * reopens them, and `idle` means the module is not observing and waits for `start()`.
 */
type Pacing = "idle" | "open" | "held";

/** Reports how one started callback settled: `undefined` for success, otherwise the failure. */
export type SettlementReporter = (outcome: RateFailureOutcome | undefined) => void;

export type AdaptiveRateOptions = {
  min_rpi: number;
  max_rpi: number;
  interval: number;
  /** Makes one start due every `interval / rate` ms instead of `rate` starts once per interval. */
  evenly_spaced: boolean;
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
  /**
   * Starts are due: start up to `limit` queued callbacks as concurrency allows, calling `started()` for each.
   * Returns whether a slot is still free. When none is, no further start becomes due until `start()`
   * reports a freed slot.
   */
  startsDue: (limit: number) => boolean;
  /** The rate strategy failed; the host must call `stop()`. The error is rethrown after this returns. */
  failed: (error: unknown) => void;
};

export type AdaptiveRate = {
  readonly rate: number;
  readonly rateIncreases: number;
  readonly rateDecreases: number;
  /**
   * Ends a pause, then begins observing if idle and work is pending. While starts are open and no start
   * is scheduled (concurrency was full), makes starts due now once a spacing has passed since the last
   * start, or schedules them for when it has. During `startsDue`, the batch's own follow-up covers it.
   */
  start: () => void;
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
  /** Opens starts with fresh pacing: the next start is due one spacing from now. */
  resume: () => void;
  /** Holds starts; `deferBy` keeps the next start due `deferBy` ms beyond one spacing from now. */
  hold: (deferBy?: number) => void;
  /** Opens starts without moving the next due start. */
  reopen: () => void;
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
  let starts = 0;
  let outstanding = 0;

  function open() {
    timer = undefined;
    if (!context.hasPendingWork()) {
      context.idle();
      return;
    }
    window++;
    collecting = true;
    starts = 0;
    outstanding = 0;
    context.resume();
    timer = setTimeout(close, context.interval);
  }

  function close() {
    timer = undefined;
    // An empty collection interval makes no decision; collect again, or go idle when nothing is pending.
    if (starts === 0) {
      open();
      return;
    }
    collecting = false;
    context.hold();
    if (outstanding === 0) finish();
  }

  function finish() {
    const current = window;
    const hold = context.decide();
    if (current !== window) return;
    if (hold) timer = setTimeout(open, context.interval);
    else open();
  }

  return {
    start: open,
    started() {
      if (!collecting) return ignoreSettlement;
      const startedIn = window;
      starts++;
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
  const {
    min_rpi,
    max_rpi,
    interval,
    evenly_spaced,
    errors_per_interval,
    back_off,
    rateStrategy,
    rateOutcomeClassifier,
    onRateChange,
  } = options;
  let rate = Math.ceil((max_rpi + min_rpi) / 2);
  let rateIncreases = 0;
  let rateDecreases = 0;
  let errorCount = 0;
  let wasBackedOff = false;
  let ignoringSettlements = false;
  let pacing: Pacing = "idle";
  let lastStart = 0;
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  let dispatching = false;
  let batchStarts = 0;

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
      host.failed(error);
      throw error;
    }
    const hold = back_off && decision.shouldBackOff;
    errorCount = 0;
    wasBackedOff = hold;
    applyRate(Math.min(max_rpi, Math.max(min_rpi, decision.nextRate)));
    return hold;
  }

  function spacing() {
    return evenly_spaced ? interval / rate : interval;
  }

  function scheduleStart(delay: number) {
    clearTimeout(startTimer);
    startTimer = setTimeout(startDue, delay);
  }

  function cancelStart() {
    clearTimeout(startTimer);
    startTimer = undefined;
  }

  /** Makes a batch of starts due once one spacing has passed since the last start. */
  function startDue() {
    startTimer = undefined;
    const wait = lastStart + spacing() - Date.now();
    if (wait > 0) {
      scheduleStart(wait);
      return;
    }
    dispatching = true;
    batchStarts = 0;
    let slotFree: boolean;
    try {
      slotFree = host.startsDue(evenly_spaced ? 1 : rate);
    }
    finally {
      dispatching = false;
    }
    if (!host.hasPendingWork()) timing.drained();
    if (pacing === "open" && slotFree) scheduleStart(spacing());
  }

  const context: TimingContext = {
    interval,
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
      lastStart = Date.now();
      scheduleStart(spacing());
    },
    hold(deferBy) {
      pacing = "held";
      if (deferBy === undefined) cancelStart();
      else scheduleStart(spacing() + deferBy);
    },
    reopen() {
      pacing = "open";
    },
    idle() {
      wasBackedOff = false;
      pacing = "idle";
      cancelStart();
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
    start() {
      ignoringSettlements = false;
      if (!host.hasPendingWork()) return;
      if (pacing === "idle") timing.start();
      else if (pacing === "open" && startTimer === undefined && !dispatching) startDue();
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
    started() {
      if (dispatching && batchStarts++ === 0) lastStart = Date.now();
      return timing.started();
    },
  };
}
