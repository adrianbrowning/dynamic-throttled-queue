import { createAdaptiveRate } from "./adaptive-rate.ts";
import type { AdaptiveRateOptions, RateFailureOutcome, SettlementReporter } from "./adaptive-rate.ts";
import { createPendingWork } from "./pending-work.ts";
import type { PendingWorkOptions, Retry } from "./pending-work.ts";
import type { RetryPolicy } from "./retry-policy.ts";

export type ExecutionContext = Readonly<{
  signal: AbortSignal;
  /** One-based attempt number; retries of the same item count up from 1. */
  attempt: number;
}>;

/** Return `false` to signal failure (increments error count, triggers retry if configured). */
export type ThrottleCallback = (context: ExecutionContext) => boolean | void | Promise<boolean | void>;

export type ThrottleFn = (callback: ThrottleCallback) => void;

/** Submitted work. Every returned value, including `false`, is a result; only a throw or rejection fails. */
export type TaskCallback<T> = (context: ExecutionContext) => T | Promise<T>;

/** One accepted logical item across all of its attempts. */
export type TaskHandle<T> = Readonly<{
  /** Settles once: the final value, the final failure, or the cancellation reason. */
  result: Promise<T>;
  /**
   * Rejects `result` with `reason` (an `AbortError` by default) unless it already settled. A pending
   * item is removed; an active one has its signal aborted and is never retried. Repeat calls do nothing.
   */
  cancel: (reason?: unknown) => void;
}>;

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
  /** Submitted items whose result was rejected by `cancel()`. */
  canceled: number;
  rateIncreases: number;
  rateDecreases: number;
}>;

export type ThrottleHandle = ThrottleFn & {
  submit: <T>(callback: TaskCallback<T>) => TaskHandle<T>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  abort: () => void;
  waitForIdle: () => Promise<void>;
  getState: () => QueueState;
  readonly pending: number;
};

/** The caller-facing side of a submitted item. Present in `tasks` until its result settles. */
type Task = {
  readonly controller: AbortController;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  /** Whether an attempt has started and not yet been placed for retry. */
  active: boolean;
};

/** `attempt` is the one-based number of the attempt this item runs next. */
type QueueItem = { fn: (context: ExecutionContext) => unknown; attempt: number; task?: Task; };

const returnedFalse: RateFailureOutcome = Object.freeze({ kind: "returned-false" });

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
  let cnt_canceled = 0;
  const abortController = new AbortController();
  /** Submitted items whose result has not settled. */
  const tasks = new Set<Task>();
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
        rejectTasks(abortController.signal.reason);
        return;
      case "failed":
        adaptiveRate.stop();
        work.fail(error);
        rejectTasks(error);
    }
  }

  /** Rejects every unsettled submitted item with `reason` and aborts its signal. */
  function rejectTasks(reason: unknown) {
    // Snapshot first: abort listeners run synchronously and may re-enter the queue.
    const affected = [ ...tasks ];
    tasks.clear();
    for (const task of affected) {
      task.controller.abort(reason);
      task.reject(reason);
    }
  }

  function nextAttempt(item: QueueItem, outcome: RateFailureOutcome | undefined, value: unknown): Retry<QueueItem> | undefined {
    const { task } = item;
    if (outcome) {
      const decision = retryPolicy.decide(outcome, item.attempt);
      if (decision && (task === undefined || tasks.has(task))) {
        cnt_retried++;
        item.attempt++;
        if (task) task.active = false;
        return { item, ...decision };
      }
    }
    if (task && tasks.delete(task)) {
      // Submitted items never return-false, so a failure always carries its error.
      if (outcome) task.reject("error" in outcome ? outcome.error : undefined);
      else task.resolve(value);
    }
    return undefined;
  }

  function handleSettlement(item: QueueItem, outcome: RateFailureOutcome | undefined, value: unknown, reportSettlement: SettlementReporter, resume = false) {
    if (lifecycle.state === "aborted" || lifecycle.state === "failed") {
      work.settle();
      return;
    }
    const observe = () => {
      reportSettlement(outcome);
      // An async settlement frees a slot; a start may be due if concurrency held one back.
      if (resume) start();
    };
    if (item.task && !tasks.has(item.task)) {
      // Canceled: the attempt's outcome neither counts nor retries, but the observation window still closes.
      outcome = undefined;
      work.settle(undefined, observe);
      return;
    }
    if (outcome) cnt_failed++;
    else cnt_succeeded++;
    work.settle(() => nextAttempt(item, outcome, value), observe);
  }

  /** Only fire-and-forget callbacks report failure by returning `false`. */
  function returnedOutcome(item: QueueItem, value: unknown): RateFailureOutcome | undefined {
    return value === false && item.task === undefined ? returnedFalse : undefined;
  }

  function execute(item: QueueItem) {
    const reportSettlement = adaptiveRate.started();
    cnt_started++;
    const { task } = item;
    if (task) task.active = true;
    let result: unknown;
    try {
      result = item.fn({ signal: task?.controller.signal ?? abortController.signal, attempt: item.attempt });
    }
    catch (error) {
      handleSettlement(item, { kind: "thrown", error }, undefined, reportSettlement);
      return;
    }
    if (result instanceof Promise) {
      void result.then(
        (value: unknown) => handleSettlement(item, returnedOutcome(item, value), value, reportSettlement, true),
        (error: unknown) => handleSettlement(item, { kind: "rejected", error }, undefined, reportSettlement, true)
      );
      return;
    }
    handleSettlement(item, returnedOutcome(item, result), result, reportSettlement);
  }

  function start() {
    if (lifecycle.state === "running") adaptiveRate.start();
  }

  /** Admits `item` or throws: the queue is terminal or every capacity reservation is taken. */
  function accept(item: QueueItem) {
    if (lifecycle.state === "aborted") throw new Error("Cannot enqueue work after the queue has been aborted");
    if (lifecycle.state === "failed") throw lifecycle.error;
    work.accept(item);
  }

  /** Schedules newly accepted work. */
  function schedule() {
    if (lifecycle.state === "stopped") transition("restart");
    else start();
  }

  function enqueue(callback: ThrottleCallback) {
    accept({ fn: callback, attempt: 1 });
    schedule();
  }

  enqueue.submit = <T>(callback: TaskCallback<T>): TaskHandle<T> => {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const task: Task = { controller: new AbortController(), resolve: resolve as (value: unknown) => void, reject, active: false };
    const item: QueueItem = { fn: callback, attempt: 1, task };
    accept(item);
    tasks.add(task);
    schedule();
    return {
      result: promise,
      cancel(reason?: unknown) {
        if (!tasks.delete(task)) return;
        cnt_canceled++;
        if (!task.active) work.remove(item);
        task.controller.abort(reason);
        task.reject(task.controller.signal.reason);
      },
    };
  };

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
    canceled: cnt_canceled,
    rateIncreases: adaptiveRate.rateIncreases,
    rateDecreases: adaptiveRate.rateDecreases,
  });
  Object.defineProperty(enqueue, "pending", { get: () => work.pending });
  return enqueue as ThrottleHandle;
}
