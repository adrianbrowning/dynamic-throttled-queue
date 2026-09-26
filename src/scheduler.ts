import { createAdaptiveRate } from "./adaptive-rate.ts";
import type { AdaptiveRateOptions, SettlementReporter } from "./adaptive-rate.ts";
import type { QueueLifecycleState, QueueState, RateFailureOutcome, ThrottleCallback, ThrottleHandle, ThrottleOptions } from "./dynamic-throttled-queue.ts";
import { createPendingWork } from "./pending-work.ts";
import type { Retry } from "./pending-work.ts";
import { calculateRetryDelay } from "./retry-backoff.ts";

type QueueItem = { fn: ThrottleCallback; retries: number; };

type Lifecycle =
  | Readonly<{ state: Exclude<QueueLifecycleState, "failed">; }>
  | Readonly<{ state: "failed"; error: unknown; }>;
type LifecycleEvent = "pause" | "resume" | "stop" | "restart" | "abort" | "fail";

/** The state each event leads to. An event missing from the current state's row is a no-op. */
const lifecycleTransitions: Readonly<Record<QueueLifecycleState, Partial<Readonly<Record<LifecycleEvent, QueueLifecycleState>>>>> = {
  running: { pause: "paused", stop: "stopped", abort: "aborted", fail: "failed" },
  paused: { resume: "running", stop: "stopped", abort: "aborted" },
  stopped: { restart: "running", abort: "aborted" },
  aborted: {},
  failed: {},
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
  let lifecycle: Lifecycle = { state: "running" };
  let cnt_started = 0;
  let cnt_succeeded = 0;
  let cnt_failed = 0;
  let cnt_retried = 0;
  const abortController = new AbortController();
  const max_concurrency = concurrency ?? Infinity;
  const work = createPendingWork<QueueItem>(
    { capacity: maxQueueSize ?? Infinity, compactThreshold: compact_threshold },
    { retryQueued: start }
  );
  const adaptiveRate = createAdaptiveRate(adaptiveRateOptions, {
    hasPendingWork: () => work.queued > 0,
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
    },
    failed(error) {
      transition("fail", error);
    },
  });

  function spacing() {
    return evenly_spaced ? interval / adaptiveRate.rate : interval;
  }

  /** Moves the lifecycle for `event` and runs the cleanup that entering the new state requires. */
  function transition(event: LifecycleEvent, error?: unknown) {
    const next = lifecycleTransitions[lifecycle.state][event];
    if (next === undefined) return;
    lifecycle = next === "failed" ? { state: next, error } : { state: next };
    switch (next) {
      case "running":
        work.thaw();
        adaptiveRate.start();
        return;
      case "paused":
        work.freeze();
        adaptiveRate.pause();
        return;
      case "stopped":
        work.freeze();
        adaptiveRate.stop();
        return;
      case "aborted":
        adaptiveRate.stop();
        work.discard();
        abortController.abort();
        return;
      case "failed":
        adaptiveRate.stop();
        work.fail(error);
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

  function nextAttempt(item: QueueItem, outcome: RateFailureOutcome | undefined): Retry<QueueItem> | undefined {
    if (!isRetryable(item, outcome)) return undefined;
    cnt_retried++;
    const retryItem = { fn: item.fn, retries: item.retries - 1 };
    if (retryBackoff === undefined) return { item: retryItem };
    return { item: retryItem, delay: calculateRetryDelay(retryBackoff, retry - item.retries + 1) };
  }

  function handleSettlement(item: QueueItem, outcome: RateFailureOutcome | undefined, reportSettlement: SettlementReporter, resume = false) {
    if (lifecycle.state === "aborted" || lifecycle.state === "failed") {
      work.settle();
      return;
    }
    if (outcome) cnt_failed++;
    else cnt_succeeded++;
    work.settle(() => nextAttempt(item, outcome), () => {
      reportSettlement(outcome);
      if (resume && adaptiveRate.pacing === "open" && work.queued > 0) dequeue();
    });
  }

  function execute(item: QueueItem) {
    const reportSettlement = adaptiveRate.started();
    cnt_started++;
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

    const batch = Math.min(evenly_spaced ? 1 : adaptiveRate.rate, work.queued);
    let started = 0;
    while (started < batch && work.active < max_concurrency) {
      const item = work.take();
      if (item === undefined) break;
      if (started++ === 0) last_called = Date.now();
      execute(item);
    }

    if (work.queued === 0) adaptiveRate.drained();
    if (adaptiveRate.pacing !== "open" || work.active >= max_concurrency) return;
    timeout = setTimeout(dequeue, spacing());
  }

  function start() {
    if (lifecycle.state === "running") adaptiveRate.start();
  }

  function enqueue(callback: ThrottleCallback) {
    if (lifecycle.state === "aborted") throw new Error("Cannot enqueue work after the queue has been aborted");
    if (lifecycle.state === "failed") throw lifecycle.error;
    work.accept({ fn: callback, retries: retry });
    if (lifecycle.state === "stopped") transition("restart");
    else start();
  }

  enqueue.pause = () => transition("pause");
  enqueue.resume = () => transition("resume");
  enqueue.stop = () => transition("stop");
  enqueue.abort = () => transition("abort");
  enqueue.waitForIdle = async () => {
    if (lifecycle.state === "failed") throw lifecycle.error;
    return work.whenIdle();
  };
  enqueue.getState = (): QueueState => Object.freeze({
    rate: adaptiveRate.rate,
    pending: work.pending,
    active: work.active,
    state: lifecycle.state,
    started: cnt_started,
    succeeded: cnt_succeeded,
    failed: cnt_failed,
    retried: cnt_retried,
    rateIncreases: adaptiveRate.rateIncreases,
    rateDecreases: adaptiveRate.rateDecreases,
  });
  Object.defineProperty(enqueue, "pending", { get: () => work.pending });
  return enqueue as ThrottleHandle;
}
