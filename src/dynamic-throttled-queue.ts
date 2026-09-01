import { createRateController } from "./rate-controller.ts";
import { createScheduler } from "./scheduler.ts";

export type RetryBackoff = {
  strategy: "fixed" | "linear" | "exponential";
  baseDelay: number;
  maxDelay?: number;
  jitter?: number;
  random?: () => number;
};

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

export type RetryClassifier = (outcome: RateFailureOutcome, attempt: number) => boolean;

export type AdjustmentTiming = "interval" | "settled";

const adjustmentTimings = new Set<string>([ "interval", "settled" ]);

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

export type ExecutionContext = Readonly<{
  signal: AbortSignal;
}>;

/** Return `false` to signal failure (increments error count, triggers retry if configured). */
export type ThrottleCallback = (context: ExecutionContext) => boolean | void | Promise<boolean | void>;

export type ThrottleOptions = {
  min_rpi: number;
  interval: number;
  max_rpi?: number;
  evenly_spaced?: boolean;
  /** Positive integer error threshold per interval before rate decrease. Default 5. */
  errors_per_interval?: number;
  back_off?: boolean;
  /** Non-negative integer retries for each failed callback. Default 0. */
  retry?: number;
  /** Per-retry delay policy. Omit to preserve immediate retries. */
  retryBackoff?: RetryBackoff;
  /** Maximum number of callbacks awaiting asynchronous settlement. Omit for no limit. */
  concurrency?: number;
  /** Maximum accepted callbacks that have not reached a terminal outcome. Omit for no limit. */
  maxQueueSize?: number;
  /** Non-negative integer dead slots before queue compaction triggers. Default 512. */
  compact_threshold?: number;
  /** Policy used to request the next rate and any backoff after each observation window. */
  rateStrategy?: RateStrategy;
  /** Decides whether a failed callback outcome contributes to adaptive-rate error counting. */
  rateOutcomeClassifier?: RateOutcomeClassifier;
  /** Decides whether a failed callback outcome is eligible for another attempt. */
  retryClassifier?: RetryClassifier;
  /** When adaptive-rate observations are adjusted. Defaults to interval compatibility behavior. */
  adjustmentTiming?: AdjustmentTiming;
  onRateChange?: (rate: number) => void;
};

export type ThrottleFn = (callback: ThrottleCallback) => void;

export type QueueLifecycleState = "running" | "paused" | "stopped" | "aborted";

export type QueueState = Readonly<{
  rate: number;
  pending: number;
  active: number;
  state: QueueLifecycleState;
  started: number;
  succeeded: number;
  failed: number;
  retried: number;
  rateIncreases: number;
  rateDecreases: number;
}>;

export type ThrottleHandle = ThrottleFn & {
  pause: () => void;
  resume: () => void;
  stop: () => void;
  abort: () => void;
  waitForIdle: () => Promise<void>;
  getState: () => QueueState;
  readonly pending: number;
};

function validateRetryBackoff(retryBackoff: RetryBackoff | undefined) {
  if (retryBackoff === undefined) return;
  if (!Number.isFinite(retryBackoff.baseDelay) || retryBackoff.baseDelay < 0) {
    throw new Error("retryBackoff.baseDelay must be a finite non-negative number");
  }
  if (retryBackoff.maxDelay !== undefined && (!Number.isFinite(retryBackoff.maxDelay) || retryBackoff.maxDelay < 0)) {
    throw new Error("retryBackoff.maxDelay must be a finite non-negative number");
  }
  if (retryBackoff.jitter !== undefined && (!Number.isFinite(retryBackoff.jitter) || retryBackoff.jitter < 0 || retryBackoff.jitter > 1)) {
    throw new Error("retryBackoff.jitter must be a finite number from 0 through 1");
  }
}

export function createThrottledQueue(options: ThrottleOptions): ThrottleHandle {
  const { min_rpi, interval, max_rpi = min_rpi, concurrency, maxQueueSize, retry = 0, compact_threshold = 512 } = options;

  const errors_per_interval = options.errors_per_interval ?? 5;

  if (!Number.isInteger(min_rpi) || min_rpi < 1) {
    throw new Error("min_rpi must be a positive integer");
  }
  if (!Number.isInteger(max_rpi) || max_rpi < min_rpi) {
    throw new Error("max_rpi must be an integer >= min_rpi");
  }
  if (typeof interval !== "number" || interval <= 0) {
    throw new Error("interval must be a positive number");
  }

  if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1)) {
    throw new Error("concurrency must be a positive integer");
  }
  if (maxQueueSize !== undefined && (!Number.isSafeInteger(maxQueueSize) || maxQueueSize < 0)) {
    throw new Error("maxQueueSize must be a non-negative safe integer");
  }
  if (!Number.isInteger(errors_per_interval) || errors_per_interval < 1) {
    throw new Error("errors_per_interval must be a positive integer");
  }
  if (!Number.isInteger(retry) || retry < 0) {
    throw new Error("retry must be a non-negative integer");
  }
  if (!Number.isInteger(compact_threshold) || compact_threshold < 0) {
    throw new Error("compact_threshold must be a non-negative integer");
  }
  if (options.adjustmentTiming !== undefined && !adjustmentTimings.has(options.adjustmentTiming)) {
    throw new Error("adjustmentTiming must be either interval or settled");
  }
  validateRetryBackoff(options.retryBackoff);
  return createScheduler(options, createRateController({
    min_rpi,
    max_rpi,
    errors_per_interval,
  }, options.rateStrategy ?? linear));
}
