import { linear } from "./adaptive-rate.ts";
import type { AdjustmentTiming, RateOutcomeClassifier, RateStrategy } from "./adaptive-rate.ts";
import { createRetryPolicy } from "./retry-policy.ts";
import type { RetryBackoff, RetryClassifier } from "./retry-policy.ts";
import { createScheduler } from "./scheduler.ts";
import type { ThrottleHandle } from "./scheduler.ts";

// eslint-disable-next-line no-barrel-files/no-barrel-files -- The package entry exposes the rate strategies owned by the adaptive-rate module.
export { aimd, linear } from "./adaptive-rate.ts";
// eslint-disable-next-line no-barrel-files/no-barrel-files -- The package entry exposes types owned by the adaptive-rate module.
export type { AdjustmentTiming, AimdOptions, RateFailureOutcome, RateOutcomeClassifier, RateStrategy, RateStrategyDecision, RateStrategyObservation } from "./adaptive-rate.ts";
// eslint-disable-next-line no-barrel-files/no-barrel-files -- The package entry exposes types owned by the retry policy module.
export type { RetryBackoff, RetryClassifier } from "./retry-policy.ts";
// eslint-disable-next-line no-barrel-files/no-barrel-files -- The package entry exposes types owned by the scheduler module.
export type { ExecutionContext, QueueLifecycleState, QueueState, TaskCallback, TaskHandle, ThrottleCallback, ThrottleFn, ThrottleHandle } from "./scheduler.ts";

const adjustmentTimings = new Set<string>([ "interval", "settled" ]);
/** The longest delay `setTimeout` honors; longer delays fire almost immediately. */
const maxTimerDelay = 2_147_483_647;

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
  /** Longest cooldown, in ms, that `cooldownFor()` applies; longer requests are clamped. Default and maximum 2147483647. */
  maxCooldown?: number;
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

export function createThrottledQueue(options: ThrottleOptions): ThrottleHandle {
  const { min_rpi, interval, max_rpi = min_rpi, concurrency, maxQueueSize, compact_threshold = 512, maxCooldown = maxTimerDelay } = options;

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
  if (!Number.isInteger(compact_threshold) || compact_threshold < 0) {
    throw new Error("compact_threshold must be a non-negative integer");
  }
  if (!Number.isFinite(maxCooldown) || maxCooldown <= 0 || maxCooldown > maxTimerDelay) {
    throw new Error(`maxCooldown must be a positive number no greater than ${maxTimerDelay}`);
  }
  if (options.adjustmentTiming !== undefined && !adjustmentTimings.has(options.adjustmentTiming)) {
    throw new Error("adjustmentTiming must be either interval or settled");
  }
  const retryPolicy = createRetryPolicy(options);
  return createScheduler({
    concurrency: concurrency ?? Infinity,
    capacity: maxQueueSize ?? Infinity,
    compactThreshold: compact_threshold,
    maxCooldown,
  }, {
    minRate: min_rpi,
    maxRate: max_rpi,
    interval,
    evenlySpaced: options.evenly_spaced ?? true,
    errorThreshold: errors_per_interval,
    backOff: options.back_off ?? false,
    adjustmentTiming: options.adjustmentTiming ?? "interval",
    rateStrategy: options.rateStrategy ?? linear,
    rateOutcomeClassifier: options.rateOutcomeClassifier,
    onRateChange: options.onRateChange,
  }, retryPolicy);
}
