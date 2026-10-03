---
dynamic-throttled-queue: minor
---

Added `cooldownFor(delay)` and the `maxCooldown` option: a server-directed cooldown that holds new starts without pausing the queue, suspends rate decisions while still counting failures, and is reported by `getState()` as `cooldownRemaining`, `cooldowns` and `cooldownTotal`.
