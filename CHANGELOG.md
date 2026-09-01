# Changelog


## 2.2.0
<sub>2026-09-01</sub>

- *(minor)* Add configurable adaptive rate strategies with the built-in linear strategy.
- *(minor)* Add configurable failure classification for adaptive-rate accounting.
- *(minor)* Add configurable AIMD adaptive rate strategy
- *(minor)* Add AbortSignal support and terminal queue abortion
- *(minor)* Add pause and resume queue lifecycle operations
- *(minor)* Add settled adaptive-rate adjustment timing.
- *(minor)* Add configurable retry backoff strategies and jitter
- *(minor)* Add configurable retry classification.
- *(minor)* Add a configurable maximum queue capacity with synchronous overflow rejection.
- *(minor)*
  Added getState() to expose a frozen QueueState snapshot with rate, pending, active, lifecycle state, and monotonic attempt/rate-direction counters.
- *(minor)* Add `waitForIdle()` — resolves once all pending, active, and delayed-retry work has completed
- *(patch)* Prevent stopped queues from restarting after in-flight callback failures.
- *(patch)* Validate retry, error-threshold, and compaction-threshold options at queue creation.

## 2.1.0
<sub>2026-08-30</sub>

- *(minor)* Add concurrency control
