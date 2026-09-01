import type { RateFailureOutcome, ThrottleCallback, ThrottleHandle, ThrottleOptions } from "./dynamic-throttled-queue.ts";
import type { RateController } from "./rate-controller.ts";
import { calculateRetryDelay } from "./retry-backoff.ts";

type QueueItem = { fn: ThrottleCallback; retries: number; observationWindow?: number; };
type DelayedRetry = {
  item: QueueItem;
  remaining: number;
  due?: number;
  timeout?: ReturnType<typeof setTimeout>;
};

export function createScheduler(options: ThrottleOptions, rateController: RateController): ThrottleHandle {
  const {
    interval,
    evenly_spaced = true,
    retry = 0,
    retryBackoff,
    concurrency,
    maxQueueSize,
    compact_threshold = 512,
    back_off = false,
    rateOutcomeClassifier,
    retryClassifier,
    onRateChange,
    adjustmentTiming = "interval",
  } = options;
  const usesSettledTiming = adjustmentTiming === "settled";
  let current_rpi = rateController.rate;
  let dyn_interval = evenly_spaced ? interval / current_rpi : interval;
  let dyn_requests_per_interval = evenly_spaced ? 1 : current_rpi;
  let skippedLast = false;
  let isRunning = false;
  let last_called = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let dynTimeout: ReturnType<typeof setTimeout> | undefined;
  let active_count = 0;
  let isPaused = false;
  let isStopped = false;
  let isAborted = false;
  let hasStrategyFailure = false;
  let strategyFailure: unknown;
  const abortController = new AbortController();
  const max_concurrency = concurrency ?? Infinity;
  const max_queue_size = maxQueueSize ?? Infinity;
  const queue: Array<QueueItem> = [];
  const delayedRetries: Array<DelayedRetry> = [];
  let head = 0;
  let reserved_count = 0;
  let observationWindow: number | undefined;
  let nextObservationWindow = 0;
  let collectingSettledWindow = false;
  let settledOutstanding = 0;
  const idleWaiters: Array<() => void> = [];

  function isIdle() {
    return active_count === 0 && queue.length <= head && delayedRetries.length === 0;
  }

  function notifyIdle() {
    if (!isIdle()) return;
    const waiters = idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  function releaseDelayedRetry(delayedRetry: DelayedRetry) {
    const index = delayedRetries.indexOf(delayedRetry);
    if (index < 0) return;
    delayedRetries.splice(index, 1);
    queue.push(delayedRetry.item);
    if (!isRunning && !isPaused && !isStopped && queue.length > head) start();
  }

  function startDelayedRetry(delayedRetry: DelayedRetry) {
    delayedRetry.due = Date.now() + delayedRetry.remaining;
    delayedRetry.timeout = setTimeout(() => {
      releaseDelayedRetry(delayedRetry);
    }, delayedRetry.remaining);
  }

  function freezeDelayedRetries() {
    for (const delayedRetry of delayedRetries) {
      if (delayedRetry.timeout === undefined) continue;
      if (delayedRetry.due === undefined) continue;
      clearTimeout(delayedRetry.timeout);
      delayedRetry.timeout = undefined;
      delayedRetry.remaining = Math.max(0, delayedRetry.due - Date.now());
    }
  }

  function resumeDelayedRetries() {
    for (const delayedRetry of delayedRetries) {
      if (delayedRetry.timeout === undefined) startDelayedRetry(delayedRetry);
    }
  }

  function scheduleDelayedRetry(item: QueueItem, delay: number) {
    const delayedRetry: DelayedRetry = { item, remaining: delay };
    delayedRetries.push(delayedRetry);
    if (!isPaused && !isStopped) startDelayedRetry(delayedRetry);
  }

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

  function discardSettledWindow() {
    observationWindow = undefined;
    collectingSettledWindow = false;
    settledOutstanding = 0;
  }

  function stop() {
    isStopped = true;
    isPaused = false;
    freezeDelayedRetries();
    halt();
    discardSettledWindow();
  }

  function pause() {
    if (isAborted || isStopped || isPaused) return;
    isPaused = true;
    rateController.clearObservation();
    freezeDelayedRetries();
    halt();
    discardSettledWindow();
  }

  function resume() {
    if (!isPaused) return;
    isPaused = false;
    resumeDelayedRetries();
    if (queue.length > head) start();
  }

  function abort() {
    if (isAborted) return;
    isAborted = true;
    halt();
    discardSettledWindow();
    freezeDelayedRetries();
    delayedRetries.length = 0;
    queue.length = 0;
    head = 0;
    reserved_count = 0;
    abortController.abort();
  }

  function isRateReducing(outcome: RateFailureOutcome | undefined) {
    if (!outcome) return false;
    try {
      return rateOutcomeClassifier?.(outcome) ?? true;
    }
    catch {
      return true;
    }
  }

  function isRetryable(item: QueueItem, outcome: RateFailureOutcome | undefined) {
    if (!outcome || item.retries === 0) return false;
    try {
      return retryClassifier ? retryClassifier(outcome, retry - item.retries + 1) === true : true;
    }
    catch {
      return true;
    }
  }

  function handleResult(item: QueueItem, outcome: RateFailureOutcome | undefined) {
    if (isAborted) return;
    if (!isPaused && (!usesSettledTiming || item.observationWindow === observationWindow)) {
      rateController.recordCompletion(isRateReducing(outcome));
    }
    if (isRetryable(item, outcome)) {
      const retryItem = { fn: item.fn, retries: item.retries - 1 };
      if (retryBackoff === undefined) {
        queue.push(retryItem);
        if (!isRunning && !isPaused && !isStopped && queue.length > head) start();
      }
      else {
        const retryIndex = retry - item.retries + 1;
        scheduleDelayedRetry(retryItem, calculateRetryDelay(retryBackoff, retryIndex));
      }
    }
    else reserved_count--;
  }

  function handleSettlement(item: QueueItem, outcome: RateFailureOutcome | undefined, resume = false) {
    active_count--;
    handleResult(item, outcome);
    if (item.observationWindow === observationWindow) {
      settledOutstanding--;
      if (!collectingSettledWindow && settledOutstanding === 0) finishSettledWindow();
    }
    if (resume && isRunning && !skippedLast && queue.length > head && (!usesSettledTiming || collectingSettledWindow)) dequeue();
    notifyIdle();
  }

  function execute(item: QueueItem) {
    if (usesSettledTiming && collectingSettledWindow) {
      item.observationWindow = observationWindow;
      settledOutstanding++;
    }
    active_count++;
    let result: ReturnType<ThrottleCallback>;
    try {
      result = item.fn({ signal: abortController.signal });
    }
    catch (error) {
      handleSettlement(item, { kind: "thrown", error });
      return;
    }
    if (result instanceof Promise) {
      void result.then(
        value => handleSettlement(item, value === false ? { kind: "returned-false" } : undefined, true),
        (error: unknown) => handleSettlement(item, { kind: "rejected", error }, true)
      );
      return;
    }
    handleSettlement(item, result === false ? { kind: "returned-false" } : undefined);
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
      if (started++ === 0) last_called = Date.now();
      execute(item);
    }

    if (head > compact_threshold && head > queue.length / 2) {
      queue.splice(0, head);
      head = 0;
    }
    if (head >= queue.length && !usesSettledTiming) {
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

  function finishSettledWindow() {
    if (observationWindow === undefined || isPaused || isStopped || isAborted) return;
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
      discardSettledWindow();
      throw error;
    }
    observationWindow = undefined;
    applyRate(decision.rate);
    if (decision.shouldBackOff && back_off) {
      skippedLast = true;
      timeout = setTimeout(resumeSettledScheduling, interval);
      return;
    }
    if (queue.length > head) beginSettledWindow();
    else halt();
  }

  function closeSettledWindow() {
    dynTimeout = undefined;
    collectingSettledWindow = false;
    clearTimeout(timeout);
    timeout = undefined;
    if (settledOutstanding === 0) finishSettledWindow();
  }

  function resumeSettledScheduling() {
    skippedLast = false;
    beginSettledWindow();
  }

  function beginSettledWindow() {
    if (isAborted || isPaused || isStopped || skippedLast || queue.length <= head) return;
    isRunning = true;
    collectingSettledWindow = true;
    observationWindow = nextObservationWindow++;
    last_called = Date.now();
    clearTimeout(timeout);
    timeout = setTimeout(dequeue, dyn_interval);
    clearTimeout(dynTimeout);
    dynTimeout = setTimeout(closeSettledWindow, interval);
  }

  function start() {
    if (isAborted || isPaused || isStopped) return;
    if (skippedLast) return;
    if (usesSettledTiming) {
      beginSettledWindow();
      return;
    }
    isRunning = true;
    last_called = Date.now();
    clearTimeout(timeout);
    timeout = setTimeout(dequeue, dyn_interval);
    if (!dynTimeout) dynTimeout = setTimeout(adjustRate, interval);
  }

  function enqueue(callback: ThrottleCallback) {
    if (isAborted) throw new Error("Cannot enqueue work after the queue has been aborted");
    if (hasStrategyFailure) throw strategyFailure;
    if (reserved_count >= max_queue_size) throw new Error("Cannot enqueue work: maxQueueSize has been reached");
    reserved_count++;
    queue.push({ fn: callback, retries: retry });
    const wasStopped = isStopped;
    isStopped = false;
    if (wasStopped) resumeDelayedRetries();
    if (!isRunning && !isPaused) start();
  }

  enqueue.pause = pause;
  enqueue.resume = resume;
  enqueue.stop = stop;
  enqueue.abort = abort;
  enqueue.waitForIdle = async () => isIdle() ? Promise.resolve() : new Promise<void>(resolve => { idleWaiters.push(resolve); });
  Object.defineProperty(enqueue, "pending", { get: () => queue.length - head + delayedRetries.length });
  return enqueue as ThrottleHandle;
}