import { createRateController } from "./rate-controller.ts";
import { createScheduler } from "./scheduler.ts";

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
  /** Maximum number of callbacks awaiting asynchronous settlement. Omit for no limit. */
  concurrency?: number;
  /** Non-negative integer dead slots before queue compaction triggers. Default 512. */
  compact_threshold?: number;
  /** Policy used to request the next rate and any backoff after each observation window. */
  rateStrategy?: RateStrategy;
  /** Decides whether a failed callback outcome contributes to adaptive-rate error counting. */
  rateOutcomeClassifier?: RateOutcomeClassifier;
  onRateChange?: (rate: number) => void;
};

export type ThrottleFn = (callback: ThrottleCallback) => void;

export type ThrottleHandle = ThrottleFn & {
  stop: () => void;
  abort: () => void;
  readonly pending: number;
};

export function createThrottledQueue(options: ThrottleOptions): ThrottleHandle {
  const { min_rpi, interval, max_rpi = min_rpi, concurrency, retry = 0, compact_threshold = 512 } = options;

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
  if (!Number.isInteger(errors_per_interval) || errors_per_interval < 1) {
    throw new Error("errors_per_interval must be a positive integer");
  }
  if (!Number.isInteger(retry) || retry < 0) {
    throw new Error("retry must be a non-negative integer");
  }
  if (!Number.isInteger(compact_threshold) || compact_threshold < 0) {
    throw new Error("compact_threshold must be a non-negative integer");
  }
  return createScheduler(options, createRateController({
    min_rpi,
    max_rpi,
    errors_per_interval,
  }, options.rateStrategy ?? linear));
}
