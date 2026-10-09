import { createAdaptiveRate } from "./adaptive-rate.ts";
import type { AdaptiveRateOptions, FailureOutcome, SettlementReporter } from "./adaptive-rate.ts";
import { createPendingWork } from "./pending-work.ts";
import type { PendingWorkOptions, Retry } from "./pending-work.ts";
import type { RetryPolicy } from "./retry-policy.ts";

export type ExecutionContext = Readonly<{
  signal: AbortSignal;
  /** One-based attempt number; retries of the same item count up from 1. */
  attempt: number;
}>;

/** Return `false` to signal failure (counts as an error, retries if configured). Any other value is success. */
export type ThrottleCallback = (context: ExecutionContext) => unknown;

export type ThrottleFn = (callback: ThrottleCallback) => void;

/** Submitted work. Every returned value, including `false`, is a result; only a throw or rejection fails. */
export type TaskCallback<T> = (context: ExecutionContext) => Promise<T> | T;

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

export type QueueLifecycleState = "aborted" | "failed" | "paused" | "running" | "stopped";

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
  /** Milliseconds, rounded up, until a server-directed cooldown ends; `0` when none is active. */
  cooldownRemaining: number;
  /** `cooldownFor()` calls that moved the cooldown deadline later. */
  cooldowns: number;
  /** Total milliseconds those calls added to the cooldown deadline. */
  cooldownTotal: number;
}>;

export type ThrottleHandle = ThrottleFn & {
  submit: <T>(callback: TaskCallback<T>) => TaskHandle<T>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  abort: () => void;
  /** Starts nothing new for `delay` ms (capped at `maxCooldown`); never shortens an active cooldown. */
  cooldownFor: (delay: number) => void;
  waitForIdle: () => Promise<void>;
  getState: () => QueueState;
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

const returnedFalse: FailureOutcome = Object.freeze({ kind: "returned-false" });

type Lifecycle =
  | Readonly<{ state: "failed"; error: unknown; }>
  | Readonly<{ state: Exclude<QueueLifecycleState, "failed">; }>;
type LifecycleEvent = "abort" | "fail" | "pause" | "restart" | "resume" | "stop";

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
  /** Longest cooldown, in ms, that `cooldownFor()` applies; longer requests are clamped to it. */
  maxCooldown: number;
};

export function createScheduler(options: SchedulerOptions, adaptiveRateOptions: AdaptiveRateOptions, retryPolicy: RetryPolicy): ThrottleHandle {
  const { concurrency, maxCooldown, ...pendingWorkOptions } = options;
  let lifecycle: Lifecycle = { state: "running" };
  let cnt_started = 0;
  let cnt_succeeded = 0;
  let cnt_failed = 0;
  let cnt_retried = 0;
  let cnt_canceled = 0;
  let cnt_cooldowns = 0;
  let cooldownTotal = 0;
  /** Monotonic (`performance.now()`) time before which nothing starts; `undefined` when no cooldown is active. */
  let cooldownDeadline: number | undefined;
  /** Fires at the deadline, armed only while queued work waits on it; `start()` arms it when work arrives. */
  let cooldownTimer: ReturnType<typeof setTimeout> | undefined;
  const abortController = new AbortController();
  /** Submitted items whose result has not settled. */
  const tasks = new Set<Task>();
  const work = createPendingWork<QueueItem>(pendingWorkOptions, { retryQueued: start });
  const adaptiveRate = createAdaptiveRate(adaptiveRateOptions, {
    hasPendingWork: () => work.queued > 0,
    startsDue(limit) {
      const batch = Math.min(limit, work.queued);
      for (let started = 0; started < batch && work.active < concurrency && cooldownDeadline === undefined; started++) {
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
        if (coolingDown()) {
          armCooldown();
          adaptiveRate.suspend();
          return;
        }
        adaptiveRate.start();
        return;
      case "paused":
        // A cooldown keeps elapsing while paused: its deadline is the server's, not the queue's.
        work.freeze();
        adaptiveRate.pause();
        return;
      case "stopped":
        clearTimeout(cooldownTimer);
        cooldownTimer = undefined;
        work.freeze();
        adaptiveRate.stop();
        return;
      case "aborted":
        clearCooldown();
        adaptiveRate.stop();
        work.discard();
        abortController.abort();
        rejectTasks(abortController.signal.reason);
        return;
      case "failed":
        clearCooldown();
        adaptiveRate.stop();
        work.fail(error);
        rejectTasks(error);
    }
  }

  /** Re-arms the expiry timer for the current deadline, or leaves it unarmed while nothing is queued. */
  function armCooldown() {
    clearTimeout(cooldownTimer);
    cooldownTimer = cooldownDeadline !== undefined && work.queued > 0
      ? setTimeout(expireCooldown, Math.max(0, cooldownDeadline - performance.now()))
      : undefined;
  }

  function expireCooldown() {
    cooldownTimer = undefined;
    // A timer can fire slightly before the monotonic deadline; `start()` then waits out the remainder.
    start();
  }

  /** Ends a cooldown whose deadline has passed; returns whether one still holds starts. */
  function coolingDown() {
    if (cooldownDeadline === undefined) return false;
    if (performance.now() < cooldownDeadline) return true;
    cooldownDeadline = undefined;
    return false;
  }

  function clearCooldown() {
    clearTimeout(cooldownTimer);
    cooldownTimer = undefined;
    cooldownDeadline = undefined;
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

  function nextAttempt(item: QueueItem, outcome: FailureOutcome | undefined, value: unknown): Retry<QueueItem> | undefined {
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

  function handleSettlement(item: QueueItem, outcome: FailureOutcome | undefined, value: unknown, reportSettlement: SettlementReporter, resume = false) {
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
  function returnedOutcome(item: QueueItem, value: unknown): FailureOutcome | undefined {
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

  /** Lets due work start; during a cooldown, keeps the expiry timer armed exactly while work is queued. */
  function start() {
    if (lifecycle.state !== "running") return;
    if (!coolingDown()) adaptiveRate.start();
    else if (cooldownTimer === undefined || work.queued === 0) armCooldown();
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
        const queued = !task.active;
        if (queued) work.remove(item);
        task.controller.abort(reason);
        task.reject(task.controller.signal.reason);
        // The removed item may have been the last queued: pacing can drain and a cooldown timer unarm.
        if (queued) start();
      },
    };
  };

  enqueue.pause = () => transition("pause");
  enqueue.resume = () => transition("resume");
  enqueue.stop = () => transition("stop");
  enqueue.abort = () => transition("abort");
  enqueue.cooldownFor = (delay: number) => {
    if (!Number.isFinite(delay) || delay < 0) throw new RangeError("cooldownFor delay must be a finite non-negative number");
    if (lifecycle.state === "aborted" || lifecycle.state === "failed") return;
    const now = performance.now();
    const beginning = !coolingDown();
    const latest = Math.max(now, cooldownDeadline ?? now);
    const deadline = now + Math.min(delay, maxCooldown);
    // Hints are absolute ("not before now + delay"), so overlapping ones keep the later deadline, never add up.
    if (deadline <= latest) return;
    cnt_cooldowns++;
    cooldownTotal += deadline - latest;
    cooldownDeadline = deadline;
    // Stopped: the restart arms the timer for whatever remains.
    if (lifecycle.state === "stopped") return;
    armCooldown();
    // Paused: adaptive rate is already stopped; `resume()` suspends it instead of starting it.
    if (beginning && lifecycle.state === "running") adaptiveRate.suspend();
  };
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
    cooldownRemaining: cooldownDeadline === undefined ? 0 : Math.max(0, Math.ceil(cooldownDeadline - performance.now())),
    cooldowns: cnt_cooldowns,
    cooldownTotal,
  });
  return enqueue;
}
