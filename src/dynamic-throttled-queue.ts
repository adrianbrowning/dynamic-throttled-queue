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

type QueueItem = { fn: ThrottleCallback; retries: number; };

export type ThrottleFn = (callback: ThrottleCallback) => void;

export type ThrottleHandle = ThrottleFn & {
  stop: () => void;
  readonly pending: number;
};

export function createThrottledQueue(options: ThrottleOptions): ThrottleHandle {
  const {
    min_rpi,
    interval,
    max_rpi = min_rpi,
    evenly_spaced = true,
    back_off = false,
    retry = 0,
    concurrency,
    compact_threshold = 512,
    onRateChange,
  } = options;

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
  let current_rpi = Math.ceil((max_rpi + min_rpi) / 2);
  let dyn_interval = evenly_spaced ? interval / current_rpi : interval;
  let dyn_requests_per_interval = evenly_spaced ? 1 : current_rpi;
  let error_count = 0;
  let skippedLast = false;
  let isRunning = false;
  let last_called = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let dynTimeout: ReturnType<typeof setTimeout> | undefined;
  let active_count = 0;
  let isStopped = false;
  const max_concurrency = concurrency ?? Infinity;

  const queue: Array<QueueItem> = [];
  let head = 0;

  /** Halts timers. Retains unprocessed queue items; next enqueue resumes from where it left off. */
  function halt() {
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

  function stop() {
    isStopped = true;
    halt();
  }

  function handleResult(item: QueueItem, result: boolean | void) {
    if (result === false) {
      error_count++;
      if (item.retries > 0) {
        queue.push({ fn: item.fn, retries: item.retries - 1 });
        if (!isRunning && !isStopped && queue.length > head) {
          start();
        }
      }
    }
  }

  function handleSettlement(item: QueueItem, result: boolean | void, resume = false) {
    active_count--;
    handleResult(item, result);

    // A released slot can unblock pending work; dequeue still observes rate pacing.
    if (resume && isRunning && !skippedLast && queue.length > head) {
      dequeue();
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

    // Retries appended by settlement are outside this batch and need another start opportunity.
    const end = Math.min(head + dyn_requests_per_interval, queue.length);
    let started = 0;
    while (head < end && active_count < max_concurrency) {
      const item = queue[head++]!;
      active_count++;
      if (started++ === 0) {
        last_called = Date.now();
      }

      let result: ReturnType<ThrottleCallback>;
      try {
        result = item.fn();
      }
      catch {
        handleSettlement(item, false);
        continue;
      }
      if (result instanceof Promise) {
        void result.then(
          value => handleSettlement(item, value, true),
          () => handleSettlement(item, false, true)
        );
      }
      else {
        handleSettlement(item, result);
      }
    }

    // ponytail: splice is O(n), amortized by only firing when head > half array length
    if (head > compact_threshold && head > queue.length / 2) {
      queue.splice(0, head);
      head = 0;
    }

    if (head >= queue.length) {
      halt();
      return;
    }
    if (active_count >= max_concurrency) {
      return;
    }
    timeout = setTimeout(dequeue, dyn_interval);
  }
  function applyRate(newRpi: number) {
    if (newRpi === current_rpi) return;
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
    const wasSkipped = skippedLast;
    skippedLast = false;

    if (error_count >= errors_per_interval) {
      applyRate(Math.max(min_rpi, current_rpi - 1));

      if (isRunning && back_off && !wasSkipped) {
        clearTimeout(timeout);
        skippedLast = true;
        timeout = setTimeout(dequeue, dyn_interval + interval);
      }
    }
    else if (!wasSkipped && error_count === 0 && queue.length > head) {
      applyRate(Math.min(max_rpi, current_rpi + 1));
    }

    error_count = 0;

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

  function enqueue(callback: ThrottleCallback) {
    queue.push({ fn: callback, retries: retry });
    isStopped = false;
    if (!isRunning) {
      start();
    }
  }

  enqueue.stop = stop;
  // ponytail: defineProperty needed for getter; stop is plain assignment
  Object.defineProperty(enqueue, "pending", { get: () => queue.length - head });

  return enqueue as ThrottleHandle;
}
