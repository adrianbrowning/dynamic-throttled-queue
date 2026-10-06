# Retry details

Read this when choosing a `retryBackoff` policy, when `createThrottledQueue`
rejects retry options, or when retry counts in `getState()` look wrong.

## Eligibility

1. A failure (`false` in fire-and-forget form, a throw, or a rejection) is
   eligible only while `retry` budget remains. `retry` must be a non-negative
   integer.
2. If `retryClassifier` is set, it is called with the normalized outcome and the
   one-based attempt that just failed. Only literal `true` retries; any other
   value makes the failure permanent. It is not called once the budget is spent.
3. If the classifier throws, the queue retries within the remaining budget.

Cancelled tasks, and outcomes that settle after `abort()` or a strategy
failure, never retry.

## Backoff

`retryBackoff` is
`{ strategy: "fixed" | "linear" | "exponential"; baseDelay: number; maxDelay?: number; jitter?: number; random?: () => number }`.

For retry index `n` (first retry is `1`):

| Strategy | Delay before cap |
| --- | --- |
| `fixed` | `baseDelay` |
| `linear` | `baseDelay × n` |
| `exponential` | `baseDelay × 2^(n - 1)` |

The delay is capped at `maxDelay`, symmetric percentage `jitter` (`0`–`1`) is
applied, then it is capped again. `baseDelay` and `maxDelay` must be finite and
non-negative; an unknown `strategy` throws. Pass `random` to make jitter
deterministic in tests; a throwing or out-of-range `random` falls back to no
jitter.

Backoff starts when the failed attempt settles. It is independent of the
adaptive-rate `back_off` option.

## Scheduling

Delayed retries count as pending work and occupy `maxQueueSize` capacity. When
due, they rejoin the tail of the queue and obey normal pacing; equal due times
keep their scheduling order. While paused or stopped, their remaining delay
freezes. `abort()` discards them.

## Counters

`started`, `succeeded`, and `failed` count attempts: a failure is counted even
when a later retry succeeds. `retried` increments only when another attempt is
actually scheduled.
