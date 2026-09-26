---
dynamic-throttled-queue: patch
$changelog: false
---

Internal refactor: the queue, delayed retries, capacity reservations and idle notification moved behind one pending-work module. No user-facing change.
