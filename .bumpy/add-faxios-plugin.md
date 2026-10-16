---
dynamic-throttled-queue: minor
---

Added a `dynamic-throttled-queue/faxios` plugin that throttles a faxios client with pacing, whole-request concurrency, adaptive rate and `Retry-After` cooldowns. It needs `@gcmdev/faxios` 0.2.x as an optional peer dependency. With npm, a `@gcmdev/faxios` outside 0.2.x anywhere in your dependency tree now fails the install with `ERESOLVE`, even if you don't import `dynamic-throttled-queue/faxios`.
