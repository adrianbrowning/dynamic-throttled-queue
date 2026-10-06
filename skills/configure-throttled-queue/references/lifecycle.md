# Lifecycle details

Read this before writing shutdown, pause/resume, or error-recovery code, or
when a queue stops starting work unexpectedly.

| State | Pending work and enqueue | Active work | Lifecycle calls |
| --- | --- | --- | --- |
| `running` | Starts normally; enqueues accepted | Runs | `pause()` retains work and stops starts. `stop()` retains work and clears timers. `abort()` is terminal. A strategy failure moves to `failed`. |
| `paused` | Pending work, new enqueues, and retries are kept but do not start | Continues and settles | `resume()` restarts pacing at the current rate with a fresh observation window. `pause()` is idempotent. `stop()` clears the paused state. |
| `stopped` | Pending work kept; the next enqueue restarts scheduling | Continues and settles | `pause()` and `resume()` do nothing. `stop()` is idempotent. |
| `aborted` | Pending work discarded; enqueues throw | Receives the aborted shared signal and may finish cooperatively | Nothing restarts scheduling. `abort()` is idempotent. |
| `failed` | Pending work and delayed retries discarded; enqueues throw the strategy error | Continues and settles without retries or accounting; the shared signal is **not** aborted | Terminal. All lifecycle calls do nothing. |

## Rules that are easy to miss

- While paused, outcomes do not adjust the rate. A failure can still create a
  retry, which waits for `resume()`.
- `stop()` cannot cancel an active callback, and that callback settling does not
  restart scheduling. Only a new enqueue does, and it also resumes frozen
  delayed retries.
- `abort()` aborts one shared signal for fire-and-forget callbacks; `submit()`
  callbacks get a per-item signal that `abort()` also aborts. Late outcomes are
  discarded and never retry.
- On `failed`, the strategy error is rethrown where the decision ran: as an
  uncaught exception from the adaptive-rate timer, or as an unhandled rejection
  when a slow async callback completes a settled-timing window. Pending and
  later `waitForIdle()` calls reject with it. Create a new queue to resume.

## Cooldown interaction

- `pause()` and `cooldownFor()` are separate. A cooldown keeps elapsing while
  paused, its end does not resume a paused queue, and `resume()` does not end it.
- `stop()` clears the cooldown timer but keeps the deadline, so the restarting
  enqueue still waits for it.
- `abort()` and a strategy failure clear the cooldown; later valid
  `cooldownFor()` calls do nothing, but invalid delays still throw `RangeError`.
- A cooldown replaces any adaptive-rate backoff in progress. Failures that
  settle during a cooldown count toward the first decision after it.

## Task handles across the lifecycle

- `pause()` and `stop()` leave `result` pending.
- `abort()` rejects every unsettled `result` with the queue signal's
  `AbortError`; a strategy failure rejects them with the strategy error.
- `submit()` throws synchronously and returns no handle when the queue is full,
  aborted, or failed.
