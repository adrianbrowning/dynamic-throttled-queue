# Changelog



## 3.0.0
<sub>2026-10-06</sub>

- *(major)*
  Simplified the public API:

  - **Breaking:** removed the `pending` property from the queue handle. Read `getState().pending` instead.
  - **Breaking:** renamed the exported `RateFailureOutcome` type to `FailureOutcome`, since both `rateOutcomeClassifier` and `retryClassifier` receive it.
  - Fire-and-forget callbacks may now return any value, so `throttle(() => fetch(url))` type-checks. Only `false` still counts as a failure.
- *(minor)*
  Added a terminal `"failed"` lifecycle state: when `rateStrategy` throws or returns a malformed decision, the queue discards pending work, reports `state: "failed"`, and rejects `waitForIdle()` with the strategy error. Fixed `abort()` leaving `waitForIdle()` pending when no callback was active.
- *(minor)*
  Added `submit()`, which returns a per-item `{ result, cancel }` handle that settles exactly once on final success, final failure, cancellation, `abort()`, or strategy failure; callbacks now also receive their one-based `attempt` number, and `getState()` reports `canceled`.
- *(minor)*
  Added `cooldownFor(delay)` and the `maxCooldown` option: a server-directed cooldown that holds new starts without pausing the queue, suspends rate decisions while still counting failures, and is reported by `getState()` as `cooldownRemaining`, `cooldowns` and `cooldownTotal`.
- *(minor)*
  Ships a TanStack Intent agent skill, `configure-throttled-queue`, in the package. It teaches coding agents how to pick start rates versus `concurrency`, classify failures for the adaptive rate and for retries, use `cooldownFor`, `submit()` handles and cancellation, and the `pause`/`resume`/`stop`/`abort` lifecycle. Load it with `npx @tanstack/intent load dynamic-throttled-queue#configure-throttled-queue`.
- *(patch)*
  Fixed `getState().started` counting phantom starts when a callback calls `abort()` partway through a batch. Internally, the queue, delayed retries, capacity reservations and idle notification moved behind one pending-work module.
- *(patch)*
  Fixed settled adjustment timing to match the README: the window collected right after a backoff now holds the rate steady, empty collection intervals no longer produce a rate decision, and a backoff that ends with nothing queued no longer stops later callbacks from starting.
- *(patch)*
  Moved `@varlock/bumpy` from `dependencies` to `devDependencies`, so installing the library no longer installs the release CLI.
- *(patch)*
  `createThrottledQueue` now rejects an unknown `retryBackoff.strategy` with `retryBackoff.strategy must be fixed, linear, or exponential`. Before, it silently used the fixed delay. Internally, retry validation, the retry budget, the retry classifier and the backoff delay moved into one retry-policy module.
- *(patch)*
  Fixed two timers that kept an idle queue alive. Canceling the last queued item while every `concurrency` slot was busy left the interval rate tick running forever: it kept the Node.js process alive, kept calling `rateStrategy`, and made the next enqueue start its callback synchronously. `cooldownFor()` armed its expiry timer even with nothing queued, so a script that honoured a `Retry-After` on its last response stayed alive for the whole delay after `waitForIdle()` resolved. The cooldown timer is now armed only while work is queued; the deadline and `cooldownRemaining` are unchanged.
- *(patch)*
  Fixed `npm install dynamic-throttled-queue` failing with `only-allow: command not found`. The published package ran the repository's `preinstall` guard in every consumer project; that script is removed.

## 2.2.0
<sub>2026-09-01</sub>

- *(minor)* Add configurable adaptive rate strategies with the built-in linear strategy.
- *(minor)* Add configurable failure classification for adaptive-rate accounting.
- *(minor)* Add configurable AIMD adaptive rate strategy
- *(minor)* Add AbortSignal support and terminal queue abortion
- *(minor)* Add pause and resume queue lifecycle operations
- *(minor)* Add settled adaptive-rate adjustment timing.
- *(minor)* Add configurable retry backoff strategies and jitter
- *(minor)* Add configurable retry classification.
- *(minor)* Add a configurable maximum queue capacity with synchronous overflow rejection.
- *(minor)*
  Added getState() to expose a frozen QueueState snapshot with rate, pending, active, lifecycle state, and monotonic attempt/rate-direction counters.
- *(minor)* Add `waitForIdle()` — resolves once all pending, active, and delayed-retry work has completed
- *(patch)* Prevent stopped queues from restarting after in-flight callback failures.
- *(patch)* Validate retry, error-threshold, and compaction-threshold options at queue creation.

## 2.1.0
<sub>2026-08-30</sub>

- *(minor)* Add concurrency control
