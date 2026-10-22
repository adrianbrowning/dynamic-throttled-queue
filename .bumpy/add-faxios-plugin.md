---
dynamic-throttled-queue: minor
---

Added a `dynamic-throttled-queue/faxios` plugin that throttles a faxios client with pacing, whole-request concurrency, adaptive rate and `Retry-After` cooldowns. It needs `@gcmdev/faxios` 0.2.x or 0.3.x as an optional peer dependency. With npm, a `@gcmdev/faxios` outside those versions anywhere in your dependency tree now fails the install with `ERESOLVE`, even if you don't import `dynamic-throttled-queue/faxios`. On faxios 0.3, `timeout` also covers time in the queue, including the first start of a new or idle queue, which waits one spacing (a full `interval` with `evenly_spaced: false`). The README now documents that first-start wait.
