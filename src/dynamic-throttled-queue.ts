import { createRateController } from "./rate-controller.ts";
import { createScheduler } from "./scheduler.ts";

/** Return `false` to signal failure (increments error count, triggers retry if configured). */
export type ThrottleCallback = () => boolean | void | Promise<boolean | void>;

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
  onRateChange?: (rate: number) => void;
};

export type ThrottleFn = (callback: ThrottleCallback) => void;

export type ThrottleHandle = ThrottleFn & {
  stop: () => void;
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
    back_off: options.back_off ?? false,
  }));
}
