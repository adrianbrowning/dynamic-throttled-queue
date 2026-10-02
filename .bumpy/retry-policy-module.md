---
dynamic-throttled-queue: patch
---

`createThrottledQueue` now rejects an unknown `retryBackoff.strategy` with `retryBackoff.strategy must be fixed, linear, or exponential`. Before, it silently used the fixed delay. Internally, retry validation, the retry budget, the retry classifier and the backoff delay moved into one retry-policy module.
