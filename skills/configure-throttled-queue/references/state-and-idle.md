# State and idle

Read this when reporting queue metrics, asserting on queue state in tests, or
waiting for work to finish.

## `getState()`

Returns a frozen snapshot; mutating it does not affect the queue.

| Field | Meaning |
| --- | --- |
| `rate` | Current starts per interval |
| `pending` | Queued items plus delayed retries (same as the `pending` property) |
| `active` | Callbacks currently executing |
| `state` | `"running"`, `"paused"`, `"stopped"`, `"aborted"`, or `"failed"` |
| `cooldownRemaining` | Ms until the cooldown ends, rounded up; `0` when none |
| `started`, `succeeded`, `failed` | Attempts; a retry is a new attempt |
| `retried` | Retries actually scheduled |
| `canceled` | Submitted items whose `result` `cancel()` rejected |
| `rateIncreases`, `rateDecreases` | Applied rate changes; match `onRateChange` calls exactly |
| `cooldowns`, `cooldownTotal` | `cooldownFor()` calls that moved the deadline later, and the ms they added |

Counters are monotonic and stop changing after `abort()` or a strategy failure.
A cancelled active attempt counts as neither succeeded nor failed.

## `waitForIdle()`

Resolves once pending work, active callbacks, and delayed retries are all
terminal; immediately if already idle.

- One-shot: a later enqueue does not affect a resolved promise. Concurrent
  callers resolve together.
- A failure that schedules a retry never produces a transient idle.
- After `stop()`, waiters stay pending until a later enqueue lets the work
  finish. Do not use `stop()` + `waitForIdle()` as shutdown.
- After `abort()`, waiters resolve as soon as no callback is active.
- While paused, waiters resolve only when pending and active are both `0`.
- On `failed`, every waiter rejects with the strategy error at once.
