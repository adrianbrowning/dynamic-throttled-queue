---
dynamic-throttled-queue: patch
---

Fixed two timers that kept an idle queue alive. Canceling the last queued item while every `concurrency` slot was busy left the interval rate tick running forever: it kept the Node.js process alive, kept calling `rateStrategy`, and made the next enqueue start its callback synchronously. `cooldownFor()` armed its expiry timer even with nothing queued, so a script that honoured a `Retry-After` on its last response stayed alive for the whole delay after `waitForIdle()` resolved. The cooldown timer is now armed only while work is queued; the deadline and `cooldownRemaining` are unchanged.
