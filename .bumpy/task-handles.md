---
dynamic-throttled-queue: minor
---

Added `submit()`, which returns a per-item `{ result, cancel }` handle that settles exactly once on final success, final failure, cancellation, `abort()`, or strategy failure; callbacks now also receive their one-based `attempt` number, and `getState()` reports `canceled`.
