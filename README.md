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

Callbacks can return `false` to signal a failure (used for dynamic rate adjustment and retry). Async callbacks (returning a Promise) are also supported — rejections and `false` resolutions count as failures. By default, every failure reduces the adaptive rate; use `rateOutcomeClassifier` when only selected failures should do so.

Set `concurrency` to bound callbacks that are still awaiting asynchronous completion. This limit is independent of the request-start rate; omitting it preserves the existing unlimited in-flight behavior.

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
| `concurrency` | `number` | — | Maximum callbacks awaiting asynchronous completion; omit for no limit |
| `compact_threshold` | `number` | `512` | Non-negative integer minimum dead slots before internal queue compaction triggers; `0` compacts at the earliest eligible point |
| `rateStrategy` | `RateStrategy` | `linear` | Pure policy that requests the next rate and an optional backoff after each observation window |
| `rateOutcomeClassifier` | `RateOutcomeClassifier` | — | Decides whether a failed callback outcome contributes to adaptive-rate error counting |
| `onRateChange` | `(rate: number) => void` | — | Called when the current rate changes |

`retry`, `errors_per_interval`, and `compact_threshold` reject fractional and non-finite values. `errors_per_interval` must be at least `1`; `retry` and `compact_threshold` may be `0`.

## Handle API

`createThrottledQueue` returns a function with additional properties:

| Property | Type | Description |
| -------- | ---- | ----------- |
| `stop()` | `() => void` | Stop processing the queue immediately |
| `pending` | `number` (readonly) | Number of callbacks still waiting in the queue |

```ts
const throttle = createThrottledQueue({ min_rpi: 5, interval: 1000 });

throttle(() => fetch("/api/data"));
console.log(throttle.pending); // number of queued callbacks

throttle.stop(); // halt processing
```

`stop()` clears scheduler timers and retains callbacks that have not started. It cannot cancel an active asynchronous callback; if that callback later succeeds, returns `false`, or rejects, its settlement does not restart scheduling. A retry created by a failed active callback is retained with the pending work. Enqueueing another callback resumes the queue.

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

### Rate strategies

The default `linear` strategy preserves the adaptive behavior above. You can import and pass it explicitly, or provide a custom pure strategy:

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
