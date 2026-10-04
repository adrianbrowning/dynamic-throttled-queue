---
name: configure-throttled-queue
description: >
  Use when creating, configuring, or debugging a dynamic-throttled-queue
  (createThrottledQueue): pacing calls to a rate-limited API, choosing
  min_rpi/max_rpi/interval/concurrency, adapting the rate to errors or HTTP
  429s, retrying failed work, honoring Retry-After, getting results back with
  submit() and cancelling them, or pausing, stopping, aborting, and draining
  the queue.
metadata:
  purpose: >
    Teach agents to configure dynamic-throttled-queue correctly: start-rate
    pacing versus async concurrency, adaptive-rate outcome classification
    versus retry eligibility, server-directed cooldowns, task handles, and the
    pause/resume/stop/abort/failed lifecycle semantics.
  type: core
  library: dynamic-throttled-queue
  library_version: 2.2.0
sources:
  - src/*.ts
  - src/__tests__/*.test.ts
  - tests/skills/configure-throttled-queue/*
  - README.md
---

# Configure a dynamic-throttled-queue

`createThrottledQueue(options)` returns a function that enqueues callbacks, plus
control methods. Work through the steps in order; each ends with a check.

## Setup

```ts
import { createThrottledQueue } from "dynamic-throttled-queue";

// At most 5 request starts per second, spread evenly (one every 200 ms).
const queue = createThrottledQueue({ min_rpi: 5, interval: 1000 });

queue(async ({ signal }) => {
  const response = await fetch("https://api.example.com/data", { signal });
  if (!response.ok) return false; // fire-and-forget failure signal
});
```

The package is ESM-only and requires Node.js 24 or later.

## 1. Pick the start rate

The rate counts **callback starts per `interval` milliseconds**. It says nothing
about how long a callback runs.

| Option | Meaning | Rule |
| --- | --- | --- |
| `min_rpi` | Lowest starts per interval | Required positive integer |
| `max_rpi` | Highest starts per interval | Integer `>= min_rpi`; defaults to `min_rpi` |
| `interval` | Window length in ms | Required positive number |
| `evenly_spaced` | `true` (default): one start every `interval / rate` ms. `false`: up to `rate` starts at once per interval | |

- A provider limit of "100 requests per minute" is `{ min_rpi: 100, interval: 60_000 }`.
  Use `evenly_spaced: false` only when bursts are allowed.
- With `max_rpi === min_rpi` the rate is fixed. With a range, the queue starts at
  `Math.ceil((min_rpi + max_rpi) / 2)` and adapts between the bounds (step 3).
- Set `max_rpi` to the provider's documented ceiling, never above it: the default
  strategy raises the rate after every clean interval that has pending work.

Check: `createThrottledQueue` throws synchronously on invalid numbers, and
`queue.getState().rate` shows the starting rate.

## 2. Bound in-flight work separately

`concurrency` caps callbacks still awaiting asynchronous settlement. It is
independent of the start rate; omitting it allows unlimited in-flight work.
Use both when the provider limits requests per window **and** simultaneous
connections:

```ts
import { createThrottledQueue } from "dynamic-throttled-queue";

const queue = createThrottledQueue({
  min_rpi: 10,
  interval: 1000,
  concurrency: 3, // never more than 3 unsettled callbacks
  maxQueueSize: 1000, // bound accepted, not-yet-terminal work
});
```

When `maxQueueSize` is reached, `queue(...)` and `submit(...)` **throw
synchronously** (`Cannot enqueue work: maxQueueSize has been reached`). Capacity covers
pending, active, and retrying work until each item is terminal.

Check: `getState().active` never exceeds `concurrency`.

## 3. Decide which failures adapt the rate

A failure is a callback that returns `false`, throws, or rejects. By default
every failure counts toward `errors_per_interval` (default `5`). When the count
reaches the threshold, the default `linear` strategy lowers the rate by 1; an
interval with zero errors and pending work raises it by 1. `back_off: true`
also skips one full interval after the threshold is hit.

Count only capacity signals with `rateOutcomeClassifier`. It receives
`{ kind: "returned-false" }`, `{ kind: "thrown", error }`, or
`{ kind: "rejected", error }` and returns whether the failure reduces the rate:

```ts
import { createThrottledQueue, type FailureOutcome } from "dynamic-throttled-queue";

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

function isCapacitySignal(outcome: FailureOutcome): boolean {
  if (outcome.kind === "returned-false") return false;
  const { error } = outcome;
  return error instanceof HttpError && (error.status === 429 || error.status >= 500);
}

const queue = createThrottledQueue({
  min_rpi: 1,
  max_rpi: 20,
  interval: 1000,
  errors_per_interval: 3,
  back_off: true,
  rateOutcomeClassifier: isCapacitySignal,
  onRateChange: rate => console.log(`rate is now ${rate}/s`),
});
```

If the classifier throws, the failure counts as rate-reducing. To change how
the rate moves (for example AIMD), read
[rate strategies and timing](references/rate-strategies.md).

Check: `getState().rateDecreases` grows only for the failures you classify as
capacity signals.

## 4. Configure retries independently

`retry` is the hard cap on extra attempts (default `0`). `retryClassifier`
decides eligibility per failure and must return literal `true` to retry.
`retryBackoff` delays retries; without it they are immediate.

```ts
import { createThrottledQueue } from "dynamic-throttled-queue";

const queue = createThrottledQueue({
  min_rpi: 5,
  interval: 1000,
  retry: 3,
  retryClassifier: (outcome, attempt) => outcome.kind !== "returned-false" && attempt <= 3,
  retryBackoff: { strategy: "exponential", baseDelay: 250, maxDelay: 10_000, jitter: 0.2 },
});
```

Retry and rate decisions are separate: a failure can be retryable,
rate-reducing, both, or neither. Every retry is a new attempt that obeys normal
pacing. For backoff formulas and validation, read
[retry details](references/retries.md).

Check: `getState().retried` counts scheduled retries; the callback's
`attempt` (1-based) counts up across retries.

## 5. Honor server cooldowns

When a server says when capacity returns (HTTP 429 with `Retry-After`), call
`cooldownFor(ms)`. The queue starts nothing new until then, keeps pending
work, and makes no rate decision meanwhile. It does not retry or lower the rate
on its own; combine it with steps 3 and 4.

```ts
import { createThrottledQueue } from "dynamic-throttled-queue";

const queue = createThrottledQueue({ min_rpi: 1, max_rpi: 10, interval: 1000, retry: 2, maxCooldown: 60_000 });

const task = queue.submit(async ({ signal }) => {
  const response = await fetch("https://api.example.com/data", { signal });
  if (response.status === 429) {
    const seconds = Number(response.headers.get("Retry-After"));
    if (Number.isFinite(seconds) && seconds >= 0) queue.cooldownFor(seconds * 1000);
    throw new Error("rate limited");
  }
  return response.json() as Promise<unknown>;
});
```

Convert the header yourself and clamp past dates to `0`: `NaN`, negative, and
infinite delays throw `RangeError`. Delays above `maxCooldown` are clamped. A
later deadline replaces an earlier one; overlapping hints do not add up.

Check: `getState().cooldownRemaining` is non-zero during the cooldown.

## 6. Get results with task handles

Use `submit()` when the caller needs the value. Its semantics differ from the
fire-and-forget form:

- Every returned value, **including `false`**, is a successful result. Only a
  throw or rejection fails, retries, and counts for the rate.
- `result` settles once: the final value, the last attempt's error, or the
  cancel reason.
- `cancel(reason?)` rejects `result` immediately (an `AbortError` by default).
  A pending item is removed; an active one has only its own signal aborted and
  keeps its concurrency slot until the callback returns. Cancelled work never
  retries and never counts as success, failure, or a rate error.

```ts
import { createThrottledQueue } from "dynamic-throttled-queue";

const queue = createThrottledQueue({ min_rpi: 5, interval: 1000, retry: 2 });

const task = queue.submit(async ({ signal, attempt }) => {
  const response = await fetch("https://api.example.com/item", { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status} on attempt ${attempt}`);
  return (await response.json()) as { id: string };
});

setTimeout(() => task.cancel(), 5000);
const item = await task.result.catch(() => undefined);
```

Check: every `result` you cancel or abort has a rejection handler.

## 7. Control the lifecycle

| Call | Effect | Reversible |
| --- | --- | --- |
| `pause()` | No new starts; keeps work; active callbacks finish | `resume()` |
| `stop()` | Clears timers; keeps work | The next enqueue restarts it |
| `abort()` | Discards pending work, aborts the shared signal, later enqueues throw | No |

A throwing or malformed `rateStrategy` moves the queue to `failed`: terminal,
pending work discarded, enqueues throw the strategy error, and `waitForIdle()`
promises reject with it.
Create a new queue to continue. For per-state rules, read
[lifecycle details](references/lifecycle.md) before writing shutdown,
pause, or error-recovery code.

Drain and inspect:

```ts
import { createThrottledQueue } from "dynamic-throttled-queue";

const queue = createThrottledQueue({ min_rpi: 5, interval: 1000 });
for (const id of ["a", "b", "c"]) {
  queue(async ({ signal }) => {
    await fetch(`https://api.example.com/items/${id}`, { signal });
  });
}

await queue.waitForIdle(); // pending, active, and delayed retries all terminal
const { succeeded, failed, state } = queue.getState();
console.log({ succeeded, failed, state });
```

For every `getState()` field and `waitForIdle()` edge case, read
[state and idle](references/state-and-idle.md).

Check: `waitForIdle()` resolves and `getState().pending` and `.active` are `0`.

## Common Mistakes

### CRITICAL: Ignoring the signal and expecting abort or cancel to stop work

```ts
import { createThrottledQueue } from "dynamic-throttled-queue";

const queue = createThrottledQueue({ min_rpi: 5, interval: 1000 });
// Wrong: abort() cannot stop this request
queue(async () => { await fetch("https://api.example.com/data"); });
// Right
queue(async ({ signal }) => { await fetch("https://api.example.com/data", { signal }); });
```

Cancellation is cooperative. A callback that ignores `signal` keeps running
after `abort()` or `cancel()`; only its outcome is discarded. Source: README
"Lifecycle"; `src/scheduler.ts`.

### CRITICAL: Starting a promise without returning or awaiting it

```ts
import { createThrottledQueue } from "dynamic-throttled-queue";

const queue = createThrottledQueue({ min_rpi: 5, interval: 1000, concurrency: 2, retry: 2 });
// Wrong: the queue sees a synchronous success; no retry, no concurrency slot
queue(({ signal }) => { void fetch("https://api.example.com/data", { signal }); });
// Right: return (or await) the work
queue(({ signal }) => fetch("https://api.example.com/data", { signal }));
```

The queue only tracks what the callback returns. An unreturned promise cannot
fail, retry, hold a `concurrency` slot, or delay `waitForIdle()`. Source: README
"Queuing work".

### HIGH: Using the rate to limit simultaneous requests

`min_rpi: 3` allows 3 starts per interval; slow callbacks pile up without
bound. Add `concurrency` for an in-flight cap. Source: `ThrottleOptions.concurrency`.

### HIGH: Returning `false` from `submit()` to signal failure

In `submit()`, `false` is a successful result: no retry, no rate reduction.
Throw instead. Fire-and-forget callbacks still treat `false` as failure; any
other returned value is success. Source: `TaskCallback` and `ThrottleCallback`
in `src/scheduler.ts`.

### HIGH: Expecting `retryClassifier` or cooldowns to change the rate

Retry eligibility, rate counting (`rateOutcomeClassifier`), and `cooldownFor`
are three independent decisions. Configure each one you need. Source: README
"Failure classification" and "Server-directed cooldown".

### HIGH: Unhandled rejections from cancelled or aborted tasks

`cancel()` and `abort()` reject `task.result`. Attach a handler such as
`task.result.catch(() => {})` if you do not await it.

### MEDIUM: Treating `stop()` as shutdown

`stop()` keeps pending work and the next enqueue restarts processing. Use
`abort()` for terminal shutdown.

### MEDIUM: Catching the `maxQueueSize` overflow as a return value

A full queue throws from `queue(...)` and `submit(...)`. Wrap enqueue
calls in `try`/`catch` when `maxQueueSize` is set.

## Completion

The configuration is complete when:

1. The start rate matches the provider limit and `max_rpi` does not exceed it.
2. `concurrency` is set when the provider limits simultaneous requests.
3. Each failure type is deliberately classified for rate reduction and retry.
4. Every async callback passes `signal` to its I/O.
5. Every `submit()` result is awaited or has a rejection handler.
6. Shutdown uses `abort()` or `waitForIdle()`, not `stop()`.

If the queue reports `state: "failed"`, fix the custom `rateStrategy` and
create a new queue.
