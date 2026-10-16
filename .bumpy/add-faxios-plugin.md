---
dynamic-throttled-queue: minor
---

Added a `dynamic-throttled-queue/faxios` plugin that throttles a faxios client with pacing, whole-request concurrency, adaptive rate and `Retry-After` cooldowns. It needs `@gcmdev/faxios` 0.2.x as an optional peer dependency.
