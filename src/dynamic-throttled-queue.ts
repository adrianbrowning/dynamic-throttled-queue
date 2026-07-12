export type ThrottleCallback = () => boolean | void | Promise<boolean | void>;

export type ThrottleOptions = {
  min_rpi: number;
  interval: number;
  max_rpi?: number;
  evenly_spaced?: boolean;
  /** Errors per interval before decreasing rate. Formerly "errors_per_second". */
  errors_per_interval?: number;
  /** @deprecated Use errors_per_interval */
  errors_per_second?: number;
  back_off?: boolean;
  retry?: number;
  onRateChange?: (rate: number) => void;
  debug?: boolean;
};

type QueueItem = ThrottleCallback | { fn: ThrottleCallback; retries: number; };

export type ThrottleFn = (callback: ThrottleCallback) => void;

export function createThrottledQueue(options: ThrottleOptions): ThrottleFn {
  const {
    min_rpi,
    interval,
    max_rpi = min_rpi,
    evenly_spaced = true,
    back_off = false,
    retry = 0,
    onRateChange,
    debug = false,
  } = options;

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const errors_per_interval = options.errors_per_interval ?? options.errors_per_second ?? 5;

  if (!Number.isInteger(min_rpi) || min_rpi < 1) {
    throw new Error("min_rpi must be a positive integer");
  }
  if (!Number.isInteger(max_rpi) || max_rpi < min_rpi) {
    throw new Error("max_rpi must be an integer >= min_rpi");
  }
  if (typeof interval !== "number" || interval <= 0) {
    throw new Error("interval must be a positive number");
  }

  let current_rpi = Math.ceil(max_rpi - (max_rpi - min_rpi) / 2);
  let dyn_interval = evenly_spaced ? interval / current_rpi : interval;
  let dyn_requests_per_interval = evenly_spaced ? 1 : current_rpi;
  let error_count = 0;
  let skippedLast = false;
  let isRunning = false;
  let last_called = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let dynTimeout: ReturnType<typeof setTimeout> | undefined;

  const queue: Array<QueueItem> = [];

  function log(...msgs: Array<unknown>) {
    // eslint-disable-next-line no-console
    if (debug) console.log(...msgs);
  }

  function stop() {
    isRunning = false;
    clearTimeout(timeout);
    clearTimeout(dynTimeout);
  }

  function handleResult(item: QueueItem, result: boolean | void) {
    if (result === false) {
      error_count++;
      if (retry > 0) {
        if (typeof item === "function") {
          queue.push({ fn: item, retries: retry - 1 });
        }
        else if (item.retries > 0) {
          queue.push({ fn: item.fn, retries: item.retries - 1 });
        }
        // Restart if queue was idle (async results arrive after dequeue stops)
        if (!isRunning && queue.length > 0) {
          start();
        }
      }
    }
  }

  function dequeue() {
    const threshold = last_called + dyn_interval;
    const now = Date.now();

    if (now < threshold) {
      clearTimeout(timeout);
      timeout = setTimeout(dequeue, threshold - now);
      return;
    }

    const batch = queue.splice(0, dyn_requests_per_interval);
    for (const item of batch) {
      const fn = typeof item === "function" ? item : item.fn;
      const result = fn();
      // ponytail: async support — if promise, handle async. No await in loop to keep batch parallel.
      if (result && typeof result === "object" && "then" in result) {
        (result).then(
          v => handleResult(item, v),
          () => handleResult(item, false)
        );
      }
      else {
        handleResult(item, result);
      }
    }

    skippedLast = false;
    last_called = Date.now();

    if (queue.length === 0) {
      stop();
      return;
    }
    timeout = setTimeout(dequeue, dyn_interval);
  }

  function adjustRate() {
    log("Error Count:", error_count);

    if (error_count >= errors_per_interval) {
      log("Decreasing rate limit");
      current_rpi = Math.max(min_rpi, current_rpi - 1);
      onRateChange?.(current_rpi);

      if (evenly_spaced) {
        dyn_interval = interval / current_rpi;
      }
      else {
        dyn_requests_per_interval = current_rpi;
      }

      if (back_off && !skippedLast) {
        clearTimeout(timeout);
        skippedLast = true;
        timeout = setTimeout(dequeue, dyn_interval + interval);
      }
    }
    else if (!skippedLast && error_count === 0 && queue.length > 0) {
      log("Increasing rate limit");
      current_rpi = Math.min(max_rpi, current_rpi + 1);
      onRateChange?.(current_rpi);

      if (evenly_spaced) {
        dyn_interval = interval / current_rpi;
      }
      else {
        dyn_requests_per_interval = current_rpi;
      }
    }

    error_count = 0;
    log(`current_rpi: ${current_rpi}`);

    if (isRunning) {
      dynTimeout = setTimeout(adjustRate, interval);
    }
  }

  function start() {
    isRunning = true;
    last_called = Date.now();
    timeout = setTimeout(dequeue, dyn_interval);
    dynTimeout = setTimeout(adjustRate, interval);
  }

  return function enqueue(callback: ThrottleCallback) {
    queue.push(callback);
    if (!isRunning) {
      start();
    }
  };
}
