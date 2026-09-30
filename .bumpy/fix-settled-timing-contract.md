---
dynamic-throttled-queue: patch
---

Fixed settled adjustment timing to match the README: the window collected right after a backoff now holds the rate steady, empty collection intervals no longer produce a rate decision, and a backoff that ends with nothing queued no longer stops later callbacks from starting.
