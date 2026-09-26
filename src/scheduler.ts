import { createAdaptiveRate } from "./adaptive-rate.ts";
import type { AdaptiveRateOptions, SettlementReporter } from "./adaptive-rate.ts";
import type { QueueState, RateFailureOutcome, ThrottleCallback, ThrottleHandle, ThrottleOptions } from "./dynamic-throttled-queue.ts";
import { calculateRetryDelay } from "./retry-backoff.ts";

type QueueItem = { fn: ThrottleCallback; retries: number; };
type DelayedRetry = {
  item: QueueItem;
  remaining: number;
  due?: number;
  timeout?: ReturnType<typeof setTimeout>;
};

export function createScheduler(options: ThrottleOptions, adaptiveRateOptions: AdaptiveRateOptions): ThrottleHandle {
  const {
    interval,
    evenly_spaced = true,
    retry = 0,
    retryBackoff,
    concurrency,
    maxQueueSize,
    compact_threshold = 512,
    retryClassifier,
  } = options;
  let last_called = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let active_count = 0;
  let isPaused = false;
  let isStopped = false;
  let isAborted = false;
  let cnt_started = 0;
  let cnt_succeeded = 0;
  let cnt_failed = 0;
  let cnt_retried = 0;
  const abortController = new AbortController();
  const max_concurrency = concurrency ?? Infinity;
  const max_queue_size = maxQueueSize ?? Infinity;
  const queue: Array<QueueItem> = [];
  const delayedRetries: Array<DelayedRetry> = [];
  let head = 0;
  let reserved_count = 0;
  const idleWaiters: Array<() => void> = [];
  const adaptiveRate = createAdaptiveRate(adaptiveRateOptions, {
    hasPendingWork: () => queue.length > head,
    resumeStarts() {
      last_called = Date.now();
      clearTimeout(timeout);
      timeout = setTimeout(dequeue, spacing());
    },
    holdStarts(deferBy) {
      clearTimeout(timeout);
      timeout = deferBy === undefined ? undefined : setTimeout(dequeue, spacing() + deferBy);
    },
    idle() {
      clearTimeout(timeout);
      timeout = undefined;
      if (head >= queue.length) {
        queue.length = 0;
        head = 0;
      }
    },
  });

  function spacing() {
    return evenly_spaced ? interval / adaptiveRate.rate : interval;
  }

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
    start();
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

  function stop() {
    isStopped = true;
    isPaused = false;
    freezeDelayedRetries();
    adaptiveRate.stop();
  }

  function pause() {
    if (isAborted || isStopped || isPaused) return;
    isPaused = true;
    freezeDelayedRetries();
    adaptiveRate.pause();
  }

  function resume() {
    if (!isPaused) return;
    isPaused = false;
    resumeDelayedRetries();
    start();
  }

  function abort() {
    if (isAborted) return;
    isAborted = true;
    adaptiveRate.stop();
    freezeDelayedRetries();
    delayedRetries.length = 0;
    queue.length = 0;
    head = 0;
    reserved_count = 0;
    abortController.abort();
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

  function handleResult(item: QueueItem, outcome: RateFailureOutcome | undefined, reportSettlement: SettlementReporter) {
    if (isAborted) return;
    if (outcome) cnt_failed++;
    else cnt_succeeded++;
    if (isRetryable(item, outcome)) {
      cnt_retried++;
      const retryItem = { fn: item.fn, retries: item.retries - 1 };
      if (retryBackoff === undefined) {
        queue.push(retryItem);
        start();
      }
      else {
        const retryIndex = retry - item.retries + 1;
        scheduleDelayedRetry(retryItem, calculateRetryDelay(retryBackoff, retryIndex));
      }
    }
    else reserved_count--;
    reportSettlement(outcome);
  }

  function handleSettlement(item: QueueItem, outcome: RateFailureOutcome | undefined, reportSettlement: SettlementReporter, resume = false) {
    active_count--;
    handleResult(item, outcome, reportSettlement);
    if (resume && adaptiveRate.pacing === "open" && queue.length > head) dequeue();
    notifyIdle();
  }

  function execute(item: QueueItem) {
    const reportSettlement = adaptiveRate.started();
    cnt_started++;
    active_count++;
    let result: ReturnType<ThrottleCallback>;
    try {
      result = item.fn({ signal: abortController.signal });
    }
    catch (error) {
      handleSettlement(item, { kind: "thrown", error }, reportSettlement);
      return;
    }
    if (result instanceof Promise) {
      void result.then(
        value => handleSettlement(item, value === false ? { kind: "returned-false" } : undefined, reportSettlement, true),
        (error: unknown) => handleSettlement(item, { kind: "rejected", error }, reportSettlement, true)
      );
      return;
    }
    handleSettlement(item, result === false ? { kind: "returned-false" } : undefined, reportSettlement);
  }

  function dequeue() {
    const threshold = last_called + spacing();
    const now = Date.now();
    if (now < threshold) {
      clearTimeout(timeout);
      timeout = setTimeout(dequeue, threshold - now);
      return;
    }

    const end = Math.min(head + (evenly_spaced ? 1 : adaptiveRate.rate), queue.length);
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
    if (head >= queue.length) adaptiveRate.drained();
    if (adaptiveRate.pacing !== "open" || active_count >= max_concurrency) return;
    timeout = setTimeout(dequeue, spacing());
  }

  function start() {
    if (isAborted || isPaused || isStopped) return;
    adaptiveRate.start();
  }

  function enqueue(callback: ThrottleCallback) {
    if (isAborted) throw new Error("Cannot enqueue work after the queue has been aborted");
    adaptiveRate.throwIfFailed();
    if (reserved_count >= max_queue_size) throw new Error("Cannot enqueue work: maxQueueSize has been reached");
    reserved_count++;
    queue.push({ fn: callback, retries: retry });
    const wasStopped = isStopped;
    isStopped = false;
    if (wasStopped) resumeDelayedRetries();
    start();
  }

  function getLifecycleState() {
    if (isAborted) return "aborted" as const;
    if (isStopped) return "stopped" as const;
    if (isPaused) return "paused" as const;
    return "running" as const;
  }

  enqueue.pause = pause;
  enqueue.resume = resume;
  enqueue.stop = stop;
  enqueue.abort = abort;
  enqueue.waitForIdle = async () => isIdle() ? Promise.resolve() : new Promise<void>(resolve => { idleWaiters.push(resolve); });
  enqueue.getState = (): QueueState => Object.freeze({
    rate: adaptiveRate.rate,
    pending: queue.length - head + delayedRetries.length,
    active: active_count,
    state: getLifecycleState(),
    started: cnt_started,
    succeeded: cnt_succeeded,
    failed: cnt_failed,
    retried: cnt_retried,
    rateIncreases: adaptiveRate.rateIncreases,
    rateDecreases: adaptiveRate.rateDecreases,
  });
  Object.defineProperty(enqueue, "pending", { get: () => queue.length - head + delayedRetries.length });
  return enqueue as ThrottleHandle;
}
