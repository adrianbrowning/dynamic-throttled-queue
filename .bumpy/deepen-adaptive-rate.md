---
dynamic-throttled-queue: patch
---

Moved adaptive-rate observation, backoff and rate application into one module behind the scheduler. Settled adjustment timing now matches the documented contract: the decision after a backoff reports `wasBackedOff`, empty collection intervals make no decision, and a backoff that ends with no queued work no longer blocks later enqueues. A strategy failure can no longer be restarted by a retry.
