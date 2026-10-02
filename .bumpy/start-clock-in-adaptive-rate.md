---
dynamic-throttled-queue: patch
$changelog: false
---

Internal refactor: the adaptive-rate module now owns the start clock (spacing, last start time, batch size and start timer); the scheduler keeps execution and concurrency. No user-facing change.
