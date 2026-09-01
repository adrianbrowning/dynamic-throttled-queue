# dynamic-throttled-queue

Dynamically throttles arbitrary code to execute between a minimum and maximum number of times per interval. Best for making throttled API requests.

For example, making network calls to popular APIs such as Twitter is subject to rate limits. By wrapping all of your API calls in a throttle, it will automatically adjust your requests to be within the acceptable rate limits.

Unlike the `throttle` functions of popular libraries like lodash and underscore, `dynamic-throttled-queue` will not prevent any executions. Instead, every execution is placed into a queue, which will be drained at the desired rate limit.

Originally forked from [shaunpersad/throttled-queue](https://github.com/shaunpersad/throttled-queue).

## Installation

```bash
pnpm add dynamic-throttled-queue
```

## Usage

```ts
import { createThrottledQueue } from "dynamic-throttled-queue";

const throttle = createThrottledQueue({ min_rpi: 5, interval: 1000 });

throttle(() => {
  // perform some type of activity in here.
});
```

Callbacks can return `false` to signal a failure (used for dynamic rate adjustment and retry). Async callbacks (returning a Promise) are also supported — rejections and `false` resolutions count as failures. By default, every failure reduces the adaptive rate; use `rateOutcomeClassifier` when only selected failures should do so. Use `retryClassifier` to separately decide whether a failure is eligible for retry.

Each callback receives an execution context containing the queue-owned `AbortSignal`. Existing zero-argument callbacks remain supported. Use the signal to cooperatively cancel in-flight work:

```ts
throttle(async ({ signal }) => {
  const response = await fetch("/api/data", { signal });
  if (!response.ok) return false;
});
```

Set `concurrency` to bound callbacks that are still awaiting asynchronous completion. This limit is independent of the request-start rate; omitting it preserves the existing unlimited in-flight behavior.

Set `maxQueueSize` to bound accepted work. Capacity is reserved from enqueue through terminal success or failure, including pending callbacks, active callbacks, and retries. A full queue makes `enqueue()` throw synchronously in v2; unlimited capacity remains the default. In v3, a full queue will return `false` instead.

## Options

| Param | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `min_rpi` | `number` | *required* | Minimum requests per interval |
| `max_rpi` | `number` | `min_rpi` | Maximum requests per interval |
| `interval` | `number` | *required* | Milliseconds between each batch of requests |
| `evenly_spaced` | `boolean` | `true` | Distribute requests evenly throughout the interval |
| `errors_per_interval` | `number` | `5` | Positive integer error threshold per interval before adjusting rate |
| `back_off` | `boolean` | `false` | Back off for 1 full interval when error threshold is hit |
| `retry` | `number` | `0` | Non-negative integer number of times to retry failed callbacks |
| `retryBackoff` | `RetryBackoff` | — | Per-retry fixed, linear, or exponential delay policy; omit for immediate retries |
| `concurrency` | `number` | — | Maximum callbacks awaiting asynchronous completion; omit for no limit |
| `maxQueueSize` | `number` | — | Maximum accepted callbacks not yet terminal, including pending, active, and retried work; omit for no limit |
| `compact_threshold` | `number` | `512` | Non-negative integer minimum dead slots before internal queue compaction triggers; `0` compacts at the earliest eligible point |
| `rateStrategy` | `RateStrategy` | `linear` | Pure policy that requests the next rate and an optional backoff after each observation window |
| `rateOutcomeClassifier` | `RateOutcomeClassifier` | — | Decides whether a failed callback outcome contributes to adaptive-rate error counting |
| `adjustmentTiming` | `"interval" \| "settled"` | `"interval"` | Defines whether rate decisions use outcomes settled each interval or complete started-attempt sets |
| `retryClassifier` | `RetryClassifier` | — | Decides whether a failed callback outcome is eligible for another attempt |
| `onRateChange` | `(rate: number) => void` | — | Called when the current rate changes |

`retry`, `errors_per_interval`, `compact_threshold`, and `maxQueueSize` reject fractional and non-finite values. `errors_per_interval` must be at least `1`; `retry` and `compact_threshold` may be `0`. `retryBackoff.baseDelay` and optional `maxDelay` are finite non-negative millisecond values (fractional values are accepted); optional `jitter` is finite from `0` through `1`.

`retryBackoff` is `{ strategy: "fixed" | "linear" | "exponential"; baseDelay: number; maxDelay?: number; jitter?: number; random?: () => number }`. The first retry has index `1`: fixed uses `baseDelay`, linear uses `baseDelay × retryIndex`, and exponential uses `baseDelay × 2^(retryIndex - 1)`. The calculated delay is capped at `maxDelay`, when supplied, then optional symmetric percentage jitter is applied and capped again. `random` makes jitter deterministic for tests; a thrown, non-finite, or out-of-range result safely falls back to no jitter. Retry backoff begins when the failed attempt settles and is independent of adaptive-rate `back_off`.

### Adaptive-rate timing

`adjustmentTiming: "interval"` is the compatibility default: each configured interval observes the callback outcomes that have settled so far. A slow callback can therefore settle after its start interval and affect a later rate decision.

With `adjustmentTiming: "settled"`, an observation window contains every callback attempt that starts during one full configured interval. When collection closes, no further callbacks start until every attempt in that window settles; the queue then makes exactly one rate decision from the complete window. The next collection interval begins immediately after that decision, unless adaptive-rate `back_off` delays scheduling. Empty settled intervals do not produce a decision. A never-settling callback blocks further settled windows until it settles, or until terminal `abort()`.

## Handle API

`createThrottledQueue` returns a function with additional properties:

| Property | Type | Description |
| -------- | ---- | ----------- |
| `pause()` | `() => void` | Temporarily prevent new callback starts while retaining accepted work |
| `resume()` | `() => void` | Resume a paused queue with a fresh pacing and observation window |
| `stop()` | `() => void` | Stop processing the queue immediately |
| `abort()` | `() => void` | Terminally discard queued work and signal active callbacks |
| `waitForIdle()` | `() => Promise<void>` | Resolves when all pending, active, and delayed-retry work has completed |
| `getState()` | `() => QueueState` | Returns a frozen point-in-time snapshot of queue state and counters |
| `pending` | `number` (readonly) | Number of callbacks waiting in the queue, including delayed retries |

```ts
const throttle = createThrottledQueue({ min_rpi: 5, interval: 1000 });

throttle(() => fetch("/api/data"));
console.log(throttle.pending); // number of queued callbacks

throttle.stop(); // halt processing
```

## Lifecycle

| State | Pending work and enqueue | Active work | Scheduling and lifecycle operations |
| ----- | ------------------------ | ----------- | ----------------------------------- |
| Running | Pending work can start; new callbacks are accepted. | Continues normally. | `pause()` retains work and stops new starts. `stop()` retains work and clears timers. `abort()` is terminal. |
| Paused | Pending work, newly enqueued callbacks, and retries are retained but do not start. | Continues and settles normally. | `resume()` restarts pacing at the current rate and begins a fresh adaptive-rate observation window. Delayed retries freeze their remaining delay and continue only after resume. `pause()` is idempotent. `stop()` clears the paused state. |
| Stopped | Pending work is retained. A later enqueue restarts scheduling. | Continues and settles normally. | Delayed retries freeze their remaining delay; the later enqueue resumes them. `pause()` and `resume()` are no-ops. `stop()` is idempotent. |
| Aborted | Pending work is discarded and future enqueues throw. | Receives the shared abort signal and may finish cooperatively. | `pause()`, `resume()`, `stop()`, and `abort()` do not restart scheduling; `abort()` is idempotent. |

While paused, callback outcomes do not contribute to adaptive-rate adjustment. A failed active callback may still create a configured retry, but that retry remains pending until `resume()`.

In settled timing, `pause()` discards the in-progress observation window rather than making a partial or late rate decision. `stop()` retains its non-restarting behavior, and `abort()` remains terminal: neither produces post-stop or post-abort settled-window accounting.

`stop()` clears scheduler timers and retains callbacks that have not started. It cannot cancel an active asynchronous callback; if that callback later succeeds, returns `false`, or rejects, its settlement does not restart scheduling. A retry created by a failed active callback is retained with the pending work. Enqueueing another callback resumes the queue and any frozen delayed retries.

`abort()` is terminal and idempotent. It clears scheduler timers, discards pending callbacks, and aborts the one shared signal supplied to active callbacks. Future enqueue attempts throw. Cancellation is cooperative: callbacks that ignore the signal can continue running, but their later success or failure does not retry work or affect adaptive-rate accounting.

`getState()` returns a frozen `QueueState` snapshot. Each call is independent; mutations to the returned object do not affect the queue. Fields: `rate` (current rate), `pending` (queued + delayed retries), `active` (callbacks executing), `state` (`"running"` | `"paused"` | `"stopped"` | `"aborted"`), and monotonic lifetime counters `started`, `succeeded`, `failed`, `retried`, `rateIncreases`, `rateDecreases`. `started`/`succeeded`/`failed` count callback attempts: a retry is a new attempt; a failure is counted even when a later retry succeeds. `retried` increments only when another attempt is actually scheduled. Rate-direction counters match applied rate changes and `onRateChange` notifications exactly. Counters do not change for settlements after `abort()`.

`waitForIdle()` returns a `Promise<void>` that resolves once all pending callbacks, active executions, and delayed retries have reached a terminal outcome. If the queue is already idle the promise resolves immediately. Each call is one-shot: a later enqueue does not affect a promise that has already resolved. Multiple simultaneous callers all resolve at the same idle transition without retaining waiter state. A callback failure that triggers a retry never exposes a transient idle transition between the failed attempt and the retry. `stop()` retains pending work, so existing waiters remain pending until that work completes after a later enqueue resumes the queue. `abort()` discards pending work but waiters remain pending until every active callback settles; post-abort settlements do not create new retry work. A paused queue resolves waiters only when both pending and active work are zero.

## Examples

### Basic

```ts
import { createThrottledQueue } from "dynamic-throttled-queue";

const throttle = createThrottledQueue({ min_rpi: 1, interval: 1000 });

for (let i = 0; i < 100; i++) {
  throttle(() => {
    fetch("https://api.example.com/data").then(console.log);
  });
}
```

### Batch mode (not evenly spaced)

```ts
const throttle = createThrottledQueue({ min_rpi: 10, interval: 1000, evenly_spaced: false });

for (let i = 0; i < 100; i++) {
  throttle(() => {
    // Fires up to 10 at once per second
    fetch("https://api.example.com/data").then(console.log);
  });
}
```

### Dynamic rate adjustment

When `max_rpi` > `min_rpi`, the queue dynamically adjusts throughput based on errors. Starts at the midpoint and scales up (0 errors) or down (>= threshold errors) each interval.

```ts
const throttle = createThrottledQueue({
  min_rpi: 1,
  max_rpi: 10,
  interval: 1000,
  errors_per_interval: 3,
  onRateChange: (rate) => console.log(`Rate: ${rate}/interval`),
});

for (let i = 0; i < 100; i++) {
  throttle(async () => {
    const res = await fetch("https://api.example.com/data");
    if (!res.ok) return false; // signals an error
  });
}
```

### Rate outcome classification

`rateOutcomeClassifier` receives only failed callback outcomes and returns whether each one should reduce the adaptive rate. It does not change retry eligibility: `false`, thrown errors, and rejected promises still retry under the existing `retry` option.

```ts
import {
  createThrottledQueue,
  type RateFailureOutcome,
} from "dynamic-throttled-queue";

function affectsCapacity(outcome: RateFailureOutcome) {
  if (outcome.kind === "returned-false") return false;

  // Treat HTTP 429 and 5xx as capacity signals, while ignoring other failures.
  const status = (outcome.error as { status?: number }).status;
  return status === 429 || (status !== undefined && status >= 500 && status < 600);
}

const throttle = createThrottledQueue({
  min_rpi: 1,
  max_rpi: 10,
  interval: 1000,
  rateOutcomeClassifier: affectsCapacity,
});
```

The normalized outcomes are `{ kind: "returned-false" }`, `{ kind: "thrown", error }`, and `{ kind: "rejected", error }`. Omitting the classifier preserves the default behavior: every failure reduces the adaptive rate. If the classifier throws, the original failure safely counts as rate-reducing and no separate classifier error is surfaced.

### Retry classification

`retryClassifier` receives the same normalized failure outcome and a one-based attempt number, including the initial callback start. It must return literal `true` for the failure to be retried; any other value makes it permanent. The configured `retry` value remains the hard cap on additional attempts, so the classifier is not called after that budget is exhausted. If it throws, the queue preserves legacy behavior and retries subject to the remaining budget.

Retry eligibility is independent from adaptive-rate accounting. A failure can be retryable, rate-reducing, both, or neither:

```ts
const throttle = createThrottledQueue({
  min_rpi: 1,
  interval: 1000,
  retry: 2,
  retryClassifier: (outcome, attempt) =>
    outcome.kind === "rejected" && attempt < 3,
  rateOutcomeClassifier: outcome => outcome.kind === "rejected",
});
```

### Rate strategies

The default `linear` strategy preserves the adaptive behavior above: it changes the rate by one request per interval. Use `aimd` when a capacity signal should reduce throughput more quickly while recovery remains gradual. AIMD increases by a fixed amount after a clean eligible observation window and reduces the rate by a multiplier when the error threshold is reached.

```ts
import { aimd, createThrottledQueue } from "dynamic-throttled-queue";

const throttle = createThrottledQueue({
  min_rpi: 1,
  max_rpi: 100,
  interval: 1000,
  rateStrategy: aimd({ increaseBy: 2, decreaseFactor: 0.5 }),
});
```

`aimd()` defaults to `{ increaseBy: 1, decreaseFactor: 0.5 }`. `increaseBy` must be a positive integer; `decreaseFactor` must be greater than `0` and less than `1`. AIMD uses `Math.floor(currentRate * decreaseFactor)` when reducing the rate, then the queue applies its configured `min_rpi` and `max_rpi` bounds. Like `linear`, it holds steady for partial-error, empty, and immediately-post-backoff observation windows.

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

A `RateStrategy` receives a frozen observation with `currentRate`, `minRate`, `maxRate`, `errorCount`, `errorThreshold`, `hasPendingWork`, and `wasBackedOff`; it returns `{ nextRate, shouldBackOff }`. Every queue starts at the midpoint of its configured range. The queue clamps finite integer `nextRate` values to its bounds. `shouldBackOff` requests a pause, which the queue performs only when `back_off` is `true`.

Strategies must return a finite integer `nextRate` and a boolean `shouldBackOff`. A malformed decision or a strategy exception permanently halts that queue, clears its timers, retains unstarted callbacks in `pending`, and surfaces the original error. Create a new queue instance to resume work.

### Backoff

```ts
const throttle = createThrottledQueue({
  min_rpi: 10,
  interval: 1000,
  back_off: true,
  errors_per_interval: 2,
});
```

### Retry

```ts
const throttle = createThrottledQueue({
  min_rpi: 5,
  interval: 1000,
  retry: 3, // retry failed callbacks up to 3 times
});

throttle(async () => {
  const res = await fetch("https://api.example.com/data");
  if (!res.ok) return false; // will be retried
});
```

### Retry backoff

```ts
const throttle = createThrottledQueue({
  min_rpi: 5,
  interval: 1000,
  retry: 3,
  retryBackoff: {
    strategy: "exponential",
    baseDelay: 250,
    maxDelay: 10_000,
    jitter: 0.2,
  },
});
```

Delayed retries remain pending, return to the normal queue tail when due, and then obey normal scheduler pacing. Equal due times preserve the order their retry delays were scheduled. `abort()` discards delayed retries along with other pending work.

## Migration from v1

- `errors_per_second` removed — use `errors_per_interval` (counts errors per full interval window, not per second).
- `debug` option removed — use `onRateChange` callback for observability.

## Development

```bash
pnpm install
pnpm build      # build with zshy (ESM only)
pnpm test       # run vitest
pnpm lint       # type-check
```

## License

MIT
