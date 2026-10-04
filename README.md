# dynamic-throttled-queue

Dynamically throttles arbitrary code to execute between a minimum and maximum number of times per interval. Best for making throttled API requests.

For example, making network calls to popular APIs such as Twitter is subject to rate limits. By wrapping all of your API calls in a throttle, it will automatically adjust your requests to be within the acceptable rate limits.

Unlike the `throttle` functions of popular libraries like lodash and underscore, `dynamic-throttled-queue` will not prevent any executions. Instead, every execution is placed into a queue, which will be drained at the desired rate limit.

Originally forked from [shaunpersad/throttled-queue](https://github.com/shaunpersad/throttled-queue).

## Installation

```bash
pnpm add dynamic-throttled-queue
```

Requires Node.js 24 or later. The package is ESM only.

## Quick start

```ts
import { createThrottledQueue } from "dynamic-throttled-queue";

// At most 5 starts per second, spaced 200 ms apart.
const throttle = createThrottledQueue({ min_rpi: 5, interval: 1000 });

throttle(async ({ signal }) => {
  const res = await fetch("https://api.example.com/data", { signal });
  return res.ok; // `false` counts as a failure
});
```

`createThrottledQueue` returns a queue. Call it with a callback to queue fire-and-forget work, or call `queue.submit(callback)` when you need the callback's result.

## Queuing work

| | `throttle(callback)` | `throttle.submit(callback)` |
| - | -------------------- | --------------------------- |
| Returns | nothing | a `TaskHandle<T>`: `{ result, cancel }` |
| Failure | returning `false`, throwing, or rejecting | throwing or rejecting only; `false` is a normal result |
| Final failure | dropped; only `getState().failed` sees it | rejects `result` |
| Cancel one item | no | `cancel(reason?)` |
| Signal passed to the callback | the queue's signal, aborted only by `abort()` | the item's own signal, aborted by `cancel()` or `abort()` |

Both forms retry, count toward the adaptive rate, and respect `concurrency` and `maxQueueSize` the same way. Use `submit()` when you need a value back or need to know that an item finally failed.

Return or await async work. The queue only sees what the callback returns: an `async` callback is tracked until it settles, but a promise the callback starts and neither awaits nor returns cannot fail, retry, hold a `concurrency` slot, or delay `waitForIdle()`.

Each callback receives an `ExecutionContext` with an `AbortSignal` and the one-based `attempt` number (retries count up from 1). Zero-argument callbacks work too. Pass the signal to cancellable APIs such as `fetch` so that `abort()` and `cancel()` can stop in-flight work.

## Examples

### Rate-limit API calls

```ts
import { createThrottledQueue } from "dynamic-throttled-queue";

const throttle = createThrottledQueue({ min_rpi: 1, interval: 1000 });

for (let i = 0; i < 100; i++) {
  throttle(({ signal }) =>
    fetch(`https://api.example.com/items/${i}`, { signal })
      .then(res => res.json())
      .then(console.log)
  );
}
```

### Burst instead of spacing

`evenly_spaced: false` starts up to `min_rpi` callbacks together at the start of each interval.

```ts
const throttle = createThrottledQueue({ min_rpi: 10, interval: 1000, evenly_spaced: false });

for (let i = 0; i < 100; i++) {
  throttle(() => fetch("https://api.example.com/data")); // up to 10 at once per second
}
```

### Get results back

```ts
const queue = createThrottledQueue({ min_rpi: 5, interval: 1000 });

const users = await Promise.all(
  [ 1, 2, 3 ].map(id =>
    queue.submit(async ({ signal, attempt }) => {
      const res = await fetch(`https://api.example.com/users/${id}`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} on attempt ${attempt}`);
      return res.json() as Promise<{ name: string; }>;
    }).result
  )
);
```

### Cancel an item

```ts
const task = queue.submit(({ signal }) => fetch("https://api.example.com/slow", { signal }));

const timer = setTimeout(() => task.cancel(), 5000);
try {
  const res = await task.result;
  console.log(res.status);
}
catch (error) {
  console.log("canceled or failed", error);
}
finally {
  clearTimeout(timer);
}
```

`result` is an ordinary promise. If you cancel or abort without awaiting it, attach a handler (for example `task.result.catch(() => {})`) so the rejection is not reported as unhandled.

### Adapt the rate to errors

When `max_rpi` is greater than `min_rpi`, the queue adjusts throughput based on failures. It starts at the midpoint of the range, then each interval scales up after a window with no errors and down after a window that reaches `errors_per_interval` errors.

```ts
const throttle = createThrottledQueue({
  min_rpi: 1,
  max_rpi: 10,
  interval: 1000,
  errors_per_interval: 3,
  back_off: true, // also pause for one interval when the threshold is hit
  onRateChange: rate => console.log(`Rate: ${rate}/interval`),
});

for (let i = 0; i < 100; i++) {
  throttle(async () => {
    const res = await fetch("https://api.example.com/data");
    return res.ok;
  });
}
```

### Retry failures

```ts
const throttle = createThrottledQueue({
  min_rpi: 5,
  interval: 1000,
  retry: 3, // up to 3 more attempts per item
  retryBackoff: {
    strategy: "exponential", // 250 ms, 500 ms, 1000 ms
    baseDelay: 250,
    maxDelay: 10_000,
    jitter: 0.2,
  },
});

throttle(async () => {
  const res = await fetch("https://api.example.com/data");
  return res.ok; // `false` is retried
});
```

Without `retryBackoff`, retries rejoin the queue immediately.

### Choose which failures retry or slow the queue

`retryClassifier` decides whether a failure is retried; `rateOutcomeClassifier` decides whether it reduces the adaptive rate. Each receives a `FailureOutcome`: `{ kind: "thrown", error }`, `{ kind: "rejected", error }`, or, for fire-and-forget callbacks only, `{ kind: "returned-false" }`. A failure can be retryable, rate-reducing, both, or neither.

```ts
import { createThrottledQueue, type FailureOutcome } from "dynamic-throttled-queue";

function affectsCapacity(outcome: FailureOutcome) {
  if (outcome.kind === "returned-false") return false;

  // Treat HTTP 429 and 5xx as capacity signals, while ignoring other failures.
  const status = (outcome.error as { status?: number; }).status;
  return status === 429 || (status !== undefined && status >= 500 && status < 600);
}

const throttle = createThrottledQueue({
  min_rpi: 1,
  max_rpi: 10,
  interval: 1000,
  retry: 2,
  retryClassifier: (outcome, attempt) => outcome.kind === "rejected" && attempt < 3,
  rateOutcomeClassifier: affectsCapacity,
});
```

### Honour `Retry-After` on HTTP 429

`cooldownFor(delay)` stops the queue from starting anything new for `delay` milliseconds. Combine it with the classifiers to retry rate-limited calls and slow down, without retrying client errors.

```ts
import { createThrottledQueue, type FailureOutcome } from "dynamic-throttled-queue";

class HttpError extends Error {
  status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

const isCapacityError = (outcome: FailureOutcome) =>
  "error" in outcome && outcome.error instanceof HttpError && (outcome.error.status === 429 || outcome.error.status >= 500);

const queue = createThrottledQueue({
  min_rpi: 1,
  max_rpi: 20,
  interval: 1000,
  retry: 3,
  retryBackoff: { strategy: "exponential", baseDelay: 500, maxDelay: 10_000, jitter: 0.2 },
  retryClassifier: isCapacityError,
  rateOutcomeClassifier: isCapacityError,
  maxCooldown: 60_000,
});

function getJson(url: string): Promise<unknown> {
  return queue.submit(async ({ signal }) => {
    const res = await fetch(url, { signal });
    if (res.status === 429) {
      const seconds = Number(res.headers.get("Retry-After"));
      if (Number.isFinite(seconds) && seconds > 0) queue.cooldownFor(seconds * 1000);
    }
    if (!res.ok) throw new HttpError(res.status);
    return res.json();
  }).result;
}
```

The queue does not read HTTP responses: convert the hint to milliseconds yourself, clamping past dates to `0`.

### Swap the rate strategy

The default `linear` strategy changes the rate by one request per interval. Use `aimd` when a capacity signal should cut throughput quickly while recovery stays gradual.

```ts
import { aimd, createThrottledQueue } from "dynamic-throttled-queue";

const throttle = createThrottledQueue({
  min_rpi: 1,
  max_rpi: 100,
  interval: 1000,
  rateStrategy: aimd({ increaseBy: 2, decreaseFactor: 0.5 }),
});
```

You can also import and pass `linear` explicitly, or provide a custom pure strategy:

```ts
import {
  createThrottledQueue,
  linear,
  type RateStrategy,
} from "dynamic-throttled-queue";

const conservative: RateStrategy = ({
  currentRate,
  minRate,
  errorCount,
  errorThreshold,
}) => ({
  nextRate: errorCount >= errorThreshold ? Math.max(minRate, currentRate - 1) : currentRate,
  shouldBackOff: errorCount >= errorThreshold,
});

const throttle = createThrottledQueue({
  min_rpi: 1,
  max_rpi: 10,
  interval: 1000,
  rateStrategy: conservative,
});

// Equivalent to omitting rateStrategy:
createThrottledQueue({ min_rpi: 1, max_rpi: 10, interval: 1000, rateStrategy: linear });
```

### Bound in-flight work and queue size

```ts
const throttle = createThrottledQueue({
  min_rpi: 10,
  interval: 1000,
  concurrency: 3, // at most 3 callbacks awaiting completion
  maxQueueSize: 1000, // at most 1000 accepted items not yet finished
});

try {
  throttle(() => fetch("https://api.example.com/data"));
}
catch {
  // The queue is full: shed the work or try later.
}
```

`concurrency` is independent of the start rate. `maxQueueSize` reserves capacity from the moment work is queued until it finally succeeds or fails, including active callbacks and retries. A full queue makes `throttle()` and `submit()` throw synchronously.

### Pause, drain and shut down

```ts
throttle.pause(); // nothing new starts; queued work is kept
throttle.resume();

await throttle.waitForIdle(); // every queued, active and retrying item has finished

throttle.abort(); // terminal: discard queued work and abort the signal
```

### Monitor the queue

```ts
const { rate, pending, active, state, failed, retried } = throttle.getState();
console.log({ rate, pending, active, state, failed, retried });
```

## Options

### Rate

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| `min_rpi` | `number` | *required* | Minimum requests per interval |
| `max_rpi` | `number` | `min_rpi` | Maximum requests per interval |
| `interval` | `number` | *required* | Milliseconds between each batch of requests |
| `evenly_spaced` | `boolean` | `true` | Distribute requests evenly throughout the interval |
| `errors_per_interval` | `number` | `5` | Positive integer error threshold per interval before adjusting rate |
| `back_off` | `boolean` | `false` | Back off for 1 full interval when error threshold is hit |
| `rateStrategy` | `RateStrategy` | `linear` | Pure policy that requests the next rate and an optional backoff after each observation window |
| `rateOutcomeClassifier` | `RateOutcomeClassifier` | — | Decides whether a failed callback outcome contributes to adaptive-rate error counting |
| `adjustmentTiming` | `"interval" \| "settled"` | `"interval"` | Whether rate decisions use outcomes settled each interval or complete started-attempt sets; see [Adaptive-rate timing](#adaptive-rate-timing) |
| `onRateChange` | `(rate: number) => void` | — | Called when the current rate changes |

### Retry

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| `retry` | `number` | `0` | Non-negative integer number of times to retry failed callbacks |
| `retryBackoff` | `RetryBackoff` | — | Per-retry fixed, linear, or exponential delay policy; omit for immediate retries |
| `retryClassifier` | `RetryClassifier` | — | Decides whether a failed callback outcome is eligible for another attempt |

### Capacity and cooldown

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| `concurrency` | `number` | — | Maximum callbacks awaiting asynchronous completion; omit for no limit |
| `maxQueueSize` | `number` | — | Maximum accepted callbacks not yet terminal, including pending, active, and retried work; omit for no limit |
| `maxCooldown` | `number` | `2147483647` | Longest cooldown, in milliseconds, that `cooldownFor()` applies; longer requests are clamped. Must be positive and at most `2147483647`, the largest delay timers honor |
| `compact_threshold` | `number` | `512` | Non-negative integer minimum dead slots before internal queue compaction triggers; `0` compacts at the earliest eligible point |

### Validation

`createThrottledQueue` throws when an option is out of range. `min_rpi` must be a positive integer and `max_rpi` an integer no smaller than it; `interval` must be a positive number. `retry`, `errors_per_interval`, `compact_threshold`, `concurrency`, and `maxQueueSize` reject fractional and non-finite values. `errors_per_interval` and `concurrency` must be at least `1`; `retry`, `compact_threshold`, and `maxQueueSize` may be `0`. `retryBackoff.strategy` must be `fixed`, `linear`, or `exponential`. `retryBackoff.baseDelay` and optional `maxDelay` are finite non-negative millisecond values (fractional values are accepted); optional `jitter` is finite from `0` through `1`.

### `retryBackoff`

`retryBackoff` is `{ strategy: "fixed" | "linear" | "exponential"; baseDelay: number; maxDelay?: number; jitter?: number; random?: () => number }`. The first retry has index `1`: fixed uses `baseDelay`, linear uses `baseDelay × retryIndex`, and exponential uses `baseDelay × 2^(retryIndex - 1)`. The calculated delay is capped at `maxDelay`, when supplied, then optional symmetric percentage jitter is applied and capped again. `random` makes jitter deterministic for tests; a thrown, non-finite, or out-of-range result safely falls back to no jitter. Retry backoff begins when the failed attempt settles and is independent of adaptive-rate `back_off`.

Delayed retries remain pending, return to the normal queue tail when due, and then obey normal scheduler pacing. Equal due times preserve the order their retry delays were scheduled. `abort()` discards delayed retries along with other pending work.

## Queue API

`createThrottledQueue(options)` returns a `ThrottleHandle`: a function that queues fire-and-forget work, with these methods.

| Method | Type | Description |
| ------ | ---- | ----------- |
| `(callback)` | `(callback: ThrottleCallback) => void` | Queue fire-and-forget work; see [Queuing work](#queuing-work) |
| `submit(callback)` | `<T>(callback: TaskCallback<T>) => TaskHandle<T>` | Queue one item and return its `{ result, cancel }` handle; see [Task handles](#task-handles) |
| `pause()` | `() => void` | Temporarily prevent new callback starts while retaining accepted work |
| `resume()` | `() => void` | Resume a paused queue with a fresh pacing and observation window |
| `stop()` | `() => void` | Stop scheduling until more work is queued; queued work is kept |
| `abort()` | `() => void` | Terminally discard queued work and signal active callbacks |
| `cooldownFor(delay)` | `(delay: number) => void` | Start nothing new for `delay` ms, for example after a server's `Retry-After`; see [Server-directed cooldown](#server-directed-cooldown) |
| `waitForIdle()` | `() => Promise<void>` | Resolves when all pending, active, and delayed-retry work has completed |
| `getState()` | `() => QueueState` | Returns a frozen point-in-time snapshot of queue state and counters |

The package also exports `aimd` and `linear`, and these types: `ThrottleOptions`, `ThrottleHandle`, `ThrottleFn`, `ThrottleCallback`, `TaskCallback`, `TaskHandle`, `ExecutionContext`, `QueueState`, `QueueLifecycleState`, `FailureOutcome`, `RateOutcomeClassifier`, `RetryClassifier`, `RetryBackoff`, `RateStrategy`, `RateStrategyObservation`, `RateStrategyDecision`, `AimdOptions`, and `AdjustmentTiming`.

## Behaviour in detail

### Task handles

`submit()` accepts a callback like the fire-and-forget form, but returns a handle for that one item, covering every attempt it makes.

- **Results.** Every value the callback returns or resolves, including `false`, is the result. Only a throw or a rejection is a failure, and it goes through `retry`, `retryClassifier`, and `rateOutcomeClassifier` the same as any other failure. `result` fulfills once, with the final successful value, or rejects once, with the final attempt's error after retries end.
- **Cancellation.** `cancel(reason?)` rejects `result` immediately with `reason`, or with an `AbortError` when no reason is given. A canceled item that has not started (including one waiting on a delayed retry) is removed: it never starts, frees its `maxQueueSize` slot, and does not use a start slot. A canceled active item has its own signal aborted, and only that signal; other work and the queue signal are unaffected. It keeps its concurrency slot until the callback returns, and `waitForIdle()` waits for it. Its outcome never retries and never counts as a success, a failure, or a rate-reducing error. Calling `cancel()` again, or after `result` has settled, does nothing.
- **Queue termination.** `abort()` rejects every unsettled item at once with the queue signal's `AbortError` and aborts each item's signal. A strategy failure (see [Lifecycle](#lifecycle)) does the same with the strategy error. Values that arrive later are discarded.
- **Retained work.** `pause()` and `stop()` keep items and leave their results pending.
- **Admission.** `submit()` throws synchronously and returns no handle when the queue would reject fire-and-forget work: the queue is full, aborted, or failed.

### Lifecycle

| State | Pending work and new work | Active work | Scheduling and lifecycle operations |
| ----- | ------------------------- | ----------- | ----------------------------------- |
| Running | Pending work can start; new callbacks are accepted. | Continues normally. | `pause()` retains work and stops new starts. `stop()` retains work and clears timers. `abort()` is terminal. A rate strategy failure moves the queue to Failed. |
| Paused | Pending work, newly queued callbacks, and retries are retained but do not start. | Continues and settles normally. | `resume()` restarts pacing at the current rate and begins a fresh adaptive-rate observation window. Delayed retries freeze their remaining delay and continue only after resume. `pause()` is idempotent. `stop()` clears the paused state. |
| Stopped | Pending work is retained. Queuing new work restarts scheduling. | Continues and settles normally. | Delayed retries freeze their remaining delay; the restart resumes them. `pause()` and `resume()` are no-ops. `stop()` is idempotent. |
| Aborted | Pending work is discarded and new work throws. | Receives the shared abort signal and may finish cooperatively. | `pause()`, `resume()`, `stop()`, and `abort()` do not restart scheduling; `abort()` is idempotent. |
| Failed | Pending work is discarded and new work throws the strategy error. | Continues and settles without retries or accounting. The shared signal is not aborted. | Terminal. `pause()`, `resume()`, `stop()`, and `abort()` are no-ops. |

While paused, callback outcomes do not contribute to adaptive-rate adjustment. A failed active callback may still create a configured retry, but that retry remains pending until `resume()`.

In settled timing, `pause()` discards the in-progress observation window rather than making a partial or late rate decision. `stop()` retains its non-restarting behavior, and `abort()` remains terminal: neither produces post-stop or post-abort settled-window accounting.

`stop()` clears scheduler timers and retains callbacks that have not started. It cannot cancel an active asynchronous callback; if that callback later succeeds, returns `false`, or rejects, its settlement does not restart scheduling. A retry created by a failed active callback is retained with the pending work. Queuing another callback resumes the queue and any frozen delayed retries.

`abort()` is terminal and idempotent. It clears scheduler timers, discards pending callbacks, and aborts the one shared signal supplied to active callbacks. Queuing more work throws. Cancellation is cooperative: callbacks that ignore the signal can continue running, but their later success or failure does not retry work or affect adaptive-rate accounting.

A queue fails when `rateStrategy` throws or returns a malformed decision. The queue clears its timers, discards pending callbacks and delayed retries, and reports `state: "failed"`. The original error is still rethrown where the decision ran: an uncaught exception from the adaptive-rate timer, or an unhandled rejection when a slow asynchronous callback completes a settled-timing window. Pending `waitForIdle()` promises reject with that error immediately, even while callbacks are still active; later `waitForIdle()` calls reject with it and queuing more work throws it. Unlike `abort()`, failure does not wait for active callbacks to settle. Create a new queue to resume work.

### `getState()`

`getState()` returns a frozen `QueueState` snapshot. Each call is independent; mutations to the returned object do not affect the queue. Fields: `rate` (current rate), `pending` (queued + delayed retries), `active` (callbacks executing), `state` (`"running"` | `"paused"` | `"stopped"` | `"aborted"` | `"failed"`), `cooldownRemaining` (milliseconds, rounded up, until an active cooldown ends; `0` when none is active), and monotonic lifetime counters `started`, `succeeded`, `failed`, `retried`, `canceled`, `rateIncreases`, `rateDecreases`, `cooldowns`, `cooldownTotal`. `started`/`succeeded`/`failed` count callback attempts: a retry is a new attempt; a failure is counted even when a later retry succeeds. `retried` increments only when another attempt is actually scheduled. `canceled` counts submitted items whose result `cancel()` rejected; a canceled active attempt counts as neither succeeded nor failed. Rate-direction counters match applied rate changes and `onRateChange` notifications exactly. `cooldowns` counts `cooldownFor()` calls that moved the deadline later, and `cooldownTotal` is the milliseconds they added. Counters do not change for settlements after `abort()` or a strategy failure.

### `waitForIdle()`

`waitForIdle()` returns a `Promise<void>` that resolves once all pending callbacks, active executions, and delayed retries have reached a terminal outcome. If the queue is already idle the promise resolves immediately. Each call is one-shot: queuing more work does not affect a promise that has already resolved. Multiple simultaneous callers all resolve at the same idle transition without retaining waiter state. A callback failure that triggers a retry never exposes a transient idle transition between the failed attempt and the retry. `stop()` retains pending work, so existing waiters remain pending until that work completes after newly queued work resumes the queue. `abort()` discards pending work, so waiters resolve as soon as no callback is active: immediately when none is running, otherwise when the last active callback settles. Post-abort settlements do not create new retry work. A paused queue resolves waiters only when both pending and active work are zero. A failed queue rejects every waiter with the strategy error at once, without waiting for active callbacks.

### Adaptive-rate timing

`adjustmentTiming: "interval"` is the default: each configured interval observes the callback outcomes that have settled so far. A slow callback can therefore settle after its start interval and affect a later rate decision.

With `adjustmentTiming: "settled"`, an observation window contains every callback attempt that starts during one full configured interval. When collection closes, no further callbacks start until every attempt in that window settles; the queue then makes exactly one rate decision from the complete window. The next collection interval begins immediately after that decision, unless adaptive-rate `back_off` delays scheduling. Empty settled intervals do not produce a decision. A never-settling callback blocks further settled windows until it settles, or until terminal `abort()`.

### Rate strategies

AIMD increases by a fixed amount after a clean eligible observation window and reduces the rate by a multiplier when the error threshold is reached. `aimd()` defaults to `{ increaseBy: 1, decreaseFactor: 0.5 }`. `increaseBy` must be a positive integer; `decreaseFactor` must be greater than `0` and less than `1`. AIMD uses `Math.floor(currentRate * decreaseFactor)` when reducing the rate, then the queue applies its configured `min_rpi` and `max_rpi` bounds. Like `linear`, it holds steady for partial-error, empty, and immediately-post-backoff observation windows.

A `RateStrategy` receives a frozen observation with `currentRate`, `minRate`, `maxRate`, `errorCount`, `errorThreshold`, `hasPendingWork`, and `wasBackedOff`; it returns `{ nextRate, shouldBackOff }`. Every queue starts at the midpoint of its configured range. The queue clamps finite integer `nextRate` values to its bounds. `shouldBackOff` requests a pause, which the queue performs only when `back_off` is `true`.

Strategies must return a finite integer `nextRate` and a boolean `shouldBackOff`. A malformed decision or a strategy exception fails that queue permanently: see [Lifecycle](#lifecycle) for what the failed state discards, rejects and rethrows. Create a new queue instance to resume work.

### Failure classification

`rateOutcomeClassifier` receives only failed callback outcomes and returns whether each one should reduce the adaptive rate. It does not change retry eligibility. Omitting it preserves the default behavior: every failure reduces the adaptive rate. If the classifier throws, the original failure safely counts as rate-reducing and no separate classifier error is surfaced.

`retryClassifier` receives the same `FailureOutcome` and a one-based attempt number, including the initial callback start. Submitted items never produce `returned-false`, because `false` is a normal `submit()` result. The classifier must return literal `true` for the failure to be retried; any other value makes it permanent. The configured `retry` value remains the hard cap on additional attempts, so the classifier is not called after that budget is exhausted. If it throws, the queue retries subject to the remaining budget.

### Server-directed cooldown

`cooldownFor(delay)` stops the queue from starting anything new for `delay` milliseconds. See [Honour `Retry-After` on HTTP 429](#honour-retry-after-on-http-429) for a full example.

- **Scheduling.** Pending work, newly queued work, and retries are kept and do not start. Active callbacks keep running and settle normally. When the cooldown ends, starts resume without new work being queued; the first one is due one spacing later, as after any fresh start. Delayed retries keep counting down and join the queue when due.
- **Overlaps.** Each call asks for "nothing before now + `delay`". A later deadline replaces the current one; an earlier one is ignored. Two 60-second hints that arrive together give one 60-second cooldown, not two.
- **Validation.** `NaN`, negative, and infinite delays throw a `RangeError` in every lifecycle state, including after `abort()` or a strategy failure. Delays above `maxCooldown` are clamped to it. `0` does nothing.
- **Lifecycle.** `pause()` and cooldown are separate: a cooldown keeps elapsing while paused, its end does not resume a paused queue, and `resume()` does not end it. `stop()` clears the cooldown timer but keeps the deadline, so the work that restarts the queue still waits for it. `abort()` and a strategy failure clear the cooldown; later valid calls do nothing.
- **Adaptive rate.** No rate decision is made while cooling down, so quiet intervals do not raise the rate. Failures that settle during the cooldown still count toward the first decision after it. In interval timing, a fresh interval begins when the cooldown ends. In settled timing, a cooldown closes the open collection interval early; once it ends and every callback started in that window has settled, the queue decides that window and opens the next. A cooldown replaces any adaptive-rate backoff already in progress. Outcomes that settle while paused stay ignored, as without a cooldown.
- **Separate decisions.** A cooldown does not reduce the rate or retry anything. Use `rateOutcomeClassifier` and `retryClassifier` for those; the three can be combined freely.

## Migration

### From v2

- The `pending` property is removed. Read `getState().pending` instead.
- The `RateFailureOutcome` type is renamed to `FailureOutcome`.

### From v1

- `errors_per_second` removed. Use `errors_per_interval`, which counts errors per full interval window, not per second.
- `debug` option removed. Use the `onRateChange` callback for observability.

## Development

```bash
pnpm install
pnpm build      # build with zshy (ESM only)
pnpm test       # run vitest
pnpm lint       # type-check and ESLint
```

## License

MIT
