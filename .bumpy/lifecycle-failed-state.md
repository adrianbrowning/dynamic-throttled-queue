---
dynamic-throttled-queue: minor
---

Added a terminal `"failed"` lifecycle state: when `rateStrategy` throws or returns a malformed decision, the queue discards pending work, reports `state: "failed"`, and rejects `waitForIdle()` with the strategy error. Fixed `abort()` leaving `waitForIdle()` pending when no callback was active.
