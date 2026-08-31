import type { ThrottleCallback, ThrottleHandle, ThrottleOptions } from "./dynamic-throttled-queue.ts";
import type { RateController } from "./rate-controller.ts";

type QueueItem = { fn: ThrottleCallback; retries: number; };

export function createScheduler(options: ThrottleOptions, rateController: RateController): ThrottleHandle {
  const {
    interval,
    evenly_spaced = true,
    retry = 0,
    concurrency,
    compact_threshold = 512,
    back_off = false,
    onRateChange,
  } = options;
  let current_rpi = rateController.rate;
  let dyn_interval = evenly_spaced ? interval / current_rpi : interval;
  let dyn_requests_per_interval = evenly_spaced ? 1 : current_rpi;
  let skippedLast = false;
  let isRunning = false;
  let last_called = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let dynTimeout: ReturnType<typeof setTimeout> | undefined;
  let active_count = 0;
  let isStopped = false;
  let hasStrategyFailure = false;
  let strategyFailure: unknown;
  const max_concurrency = concurrency ?? Infinity;
  const queue: Array<QueueItem> = [];
  let head = 0;

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
    rateController.recordCompletion(result);
    if (result === false && item.retries > 0) {
      queue.push({ fn: item.fn, retries: item.retries - 1 });
      if (!isRunning && !isStopped && queue.length > head) start();
    }
  }

  function handleSettlement(item: QueueItem, result: boolean | void, resume = false) {
    active_count--;
    handleResult(item, result);
    if (resume && isRunning && !skippedLast && queue.length > head) dequeue();
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
    let started = 0;
    while (head < end && active_count < max_concurrency) {
      const item = queue[head++]!;
      active_count++;
      if (started++ === 0) last_called = Date.now();
      let result: ReturnType<ThrottleCallback>;
      try {
        result = item.fn();
      }
      catch {
        handleSettlement(item, false);
        continue;
      }
      if (result instanceof Promise) {
        void result.then(value => handleSettlement(item, value, true), () => handleSettlement(item, false, true));
      }
      else {
        handleSettlement(item, result);
      }
    }

    if (head > compact_threshold && head > queue.length / 2) {
      queue.splice(0, head);
      head = 0;
    }
    if (head >= queue.length) {
      halt();
      return;
    }
    if (active_count >= max_concurrency) return;
    timeout = setTimeout(dequeue, dyn_interval);
  }

  function applyRate(newRpi: number) {
    if (newRpi === current_rpi) return;
    current_rpi = newRpi;
    onRateChange?.(current_rpi);
    if (evenly_spaced) dyn_interval = interval / current_rpi;
    else dyn_requests_per_interval = current_rpi;
  }

  function adjustRate() {
    dynTimeout = undefined;
    const wasSkipped = skippedLast;
    skippedLast = false;
    let decision: ReturnType<RateController["observe"]>;
    try {
      decision = rateController.observe({ hasPendingWork: queue.length > head, wasBackedOff: wasSkipped });
    }
    catch (error) {
      hasStrategyFailure = true;
      strategyFailure = error;
      halt();
      throw error;
    }
    applyRate(decision.rate);
    if (decision.shouldBackOff && back_off) {
      clearTimeout(timeout);
      skippedLast = true;
      timeout = setTimeout(dequeue, dyn_interval + interval);
    }
    if (isRunning) dynTimeout = setTimeout(adjustRate, interval);
  }

  function start() {
    if (skippedLast) return;
    isRunning = true;
    last_called = Date.now();
    clearTimeout(timeout);
    timeout = setTimeout(dequeue, dyn_interval);
    if (!dynTimeout) dynTimeout = setTimeout(adjustRate, interval);
  }

  function enqueue(callback: ThrottleCallback) {
    if (hasStrategyFailure) throw strategyFailure;
    queue.push({ fn: callback, retries: retry });
    isStopped = false;
    if (!isRunning) start();
  }

  enqueue.stop = stop;
  Object.defineProperty(enqueue, "pending", { get: () => queue.length - head });
  return enqueue as ThrottleHandle;
}
