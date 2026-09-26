---
dynamic-throttled-queue: patch
---

Fixed `getState().started` counting phantom starts when a callback calls `abort()` partway through a batch. Internally, the queue, delayed retries, capacity reservations and idle notification moved behind one pending-work module.
