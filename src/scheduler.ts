import { createAdaptiveRate } from "./adaptive-rate.ts";
import type { AdaptiveRateOptions, RateFailureOutcome, SettlementReporter } from "./adaptive-rate.ts";
import { createPendingWork } from "./pending-work.ts";
import type { PendingWorkOptions, Retry } from "./pending-work.ts";
import type { RetryPolicy } from "./retry-policy.ts";

export type ExecutionContext = Readonly<{
  signal: AbortSignal;
}>;

/** Return `false` to signal failure (increments error count, triggers retry if configured). */
export type ThrottleCallback = (context: ExecutionContext) => boolean | void | Promise<boolean | void>;

export type ThrottleFn = (callback: ThrottleCallback) => void;

export type QueueLifecycleState = "running" | "paused" | "stopped" | "aborted" | "failed";

export type QueueState = Readonly<{
  rate: number;
  pending: number;
  active: number;
  state: QueueLifecycleState;
  started: number;
  succeeded: number;
  failed: number;
  retried: number;
  rateIncreases: number;
  rateDecreases: number;
}>;

export type ThrottleHandle = ThrottleFn & {
  pause: () => void;
  resume: () => void;
  stop: () => void;
  abort: () => void;
  waitForIdle: () => Promise<void>;
  getState: () => QueueState;
  readonly pending: number;
};

/** `attempt` is the one-based number of the attempt this item runs next. */
type QueueItem = { fn: ThrottleCallback; attempt: number; };

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

export type SchedulerOptions = PendingWorkOptions & {
  /** Most callbacks awaiting asynchronous settlement at once. */
  concurrency: number;
};

export function createScheduler(options: SchedulerOptions, adaptiveRateOptions: AdaptiveRateOptions, retryPolicy: RetryPolicy): ThrottleHandle {
  const { concurrency, ...pendingWorkOptions } = options;
  let lifecycle: Lifecycle = { state: "running" };
  let cnt_started = 0;
  let cnt_succeeded = 0;
  let cnt_failed = 0;
  let cnt_retried = 0;
  const abortController = new AbortController();
  const work = createPendingWork<QueueItem>(pendingWorkOptions, { retryQueued: start });
  const adaptiveRate = createAdaptiveRate(adaptiveRateOptions, {
    hasPendingWork: () => work.queued > 0,
    startsDue(limit) {
      const batch = Math.min(limit, work.queued);
      for (let started = 0; started < batch && work.active < concurrency; started++) {
        const item = work.take();
        if (item === undefined) break;
        execute(item);
      }
      return work.active < concurrency;
    },
    failed(error) {
      transition("fail", error);
    },
  });

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

  function nextAttempt(item: QueueItem, outcome: RateFailureOutcome | undefined): Retry<QueueItem> | undefined {
    if (!outcome) return undefined;
    const decision = retryPolicy.decide(outcome, item.attempt);
    if (!decision) return undefined;
    cnt_retried++;
    return { item: { fn: item.fn, attempt: item.attempt + 1 }, ...decision };
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
      // An async settlement frees a slot; a start may be due if concurrency held one back.
      if (resume) start();
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

  function start() {
    if (lifecycle.state === "running") adaptiveRate.start();
  }

  function enqueue(callback: ThrottleCallback) {
    if (lifecycle.state === "aborted") throw new Error("Cannot enqueue work after the queue has been aborted");
    if (lifecycle.state === "failed") throw lifecycle.error;
    work.accept({ fn: callback, attempt: 1 });
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
