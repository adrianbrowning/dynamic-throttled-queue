---
dynamic-throttled-queue: minor
---

A new queue, and a queue whose work has drained, now start the next callback at once, instead of one spacing (`interval / rate`, or a full `interval` with `evenly_spaced: false`) later. If one spacing has not yet passed since the last start, the callback waits only the rest of it. Spacing between starts, batches one `interval` apart, and the rate limit are unchanged. After `stop()` and a restart, `pause()` and `resume()`, a backoff that ends with work waiting, or a cooldown, the next start is still due one spacing later.
