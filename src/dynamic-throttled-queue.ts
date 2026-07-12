/** Return `false` to signal failure (increments error count, triggers retry if configured). */
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
  /** Minimum dead slots before queue compaction triggers. Default 512. */
  compact_threshold?: number;
  onRateChange?: (rate: number) => void;
  debug?: boolean;
};

type QueueItem = { fn: ThrottleCallback; retries: number; };

export type ThrottleFn = (callback: ThrottleCallback) => void;

export function createThrottledQueue(options: ThrottleOptions): ThrottleFn {
  const {
    min_rpi,
    interval,
    max_rpi = min_rpi,
    evenly_spaced = true,
    back_off = false,
    retry = 0,
    compact_threshold = 512,
    onRateChange,
    debug = false,
  } = options;

  // eslint-disable-next-line @typescript-eslint/no-deprecated, sonarjs/deprecation
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
  let head = 0;

  function log(...msgs: Array<unknown>) {
    // eslint-disable-next-line no-console
    if (debug) console.log(...msgs);
  }

  function stop() {
    isRunning = false;
    skippedLast = false;
    clearTimeout(timeout);
    timeout = undefined;
    clearTimeout(dynTimeout);
    dynTimeout = undefined;
    if (head >= queue.length) {
      queue.length = 0;
      head = 0;
    }
  }

  function handleResult(item: QueueItem, result: boolean | void) {
    if (result === false) {
      error_count++;
      if (item.retries > 0) {
        queue.push({ fn: item.fn, retries: item.retries - 1 });
        if (!isRunning && queue.length > head) {
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

    const end = Math.min(head + dyn_requests_per_interval, queue.length);
    for (let i = head; i < end; i++) {
      const item = queue[i]!;
      let result: ReturnType<ThrottleCallback>;
      try {
        result = item.fn();
      }
      catch {
        handleResult(item, false);
        continue;
      }
      if (result instanceof Promise) {
        void result.then(
          v => handleResult(item, v),
          () => handleResult(item, false)
        );
      }
      else {
        handleResult(item, result);
      }
    }
    head = end;

    last_called = Date.now();

    // ponytail: splice is O(n), amortized by only firing when head > half array length
    if (head > compact_threshold && head > queue.length / 2) {
      queue.splice(0, head);
      head = 0;
    }

    if (head >= queue.length) {
      stop();
      return;
    }
    timeout = setTimeout(dequeue, dyn_interval);
  }

  function applyRate(newRpi: number) {
    current_rpi = newRpi;
    onRateChange?.(current_rpi);
    if (evenly_spaced) {
      dyn_interval = interval / current_rpi;
    }
    else {
      dyn_requests_per_interval = current_rpi;
    }
  }

  // ponytail: async callbacks resolve after adjustRate fires — error_count may lag by one interval under async load
  function adjustRate() {
    dynTimeout = undefined;
    log("Error Count:", error_count);
    const wasSkipped = skippedLast;
    skippedLast = false;

    if (error_count >= errors_per_interval) {
      log("Decreasing rate limit");
      applyRate(Math.max(min_rpi, current_rpi - 1));

      if (isRunning && back_off && !wasSkipped) {
        clearTimeout(timeout);
        skippedLast = true;
        timeout = setTimeout(dequeue, dyn_interval + interval);
      }
    }
    else if (!wasSkipped && error_count === 0 && queue.length > head) {
      log("Increasing rate limit");
      applyRate(Math.min(max_rpi, current_rpi + 1));
    }

    error_count = 0;
    log(`current_rpi: ${current_rpi}`);

    if (isRunning) {
      dynTimeout = setTimeout(adjustRate, interval);
    }
  }

  function start() {
    if (skippedLast) return;
    isRunning = true;
    last_called = Date.now();
    clearTimeout(timeout);
    timeout = setTimeout(dequeue, dyn_interval);
    if (!dynTimeout) {
      dynTimeout = setTimeout(adjustRate, interval);
    }
  }

  return function enqueue(callback: ThrottleCallback) {
    queue.push({ fn: callback, retries: retry });
    if (!isRunning) {
      start();
    }
  };
}
