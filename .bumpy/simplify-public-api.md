---
dynamic-throttled-queue: major
---

Simplified the public API:

- **Breaking:** removed the `pending` property from the queue handle. Read `getState().pending` instead.
- **Breaking:** renamed the exported `RateFailureOutcome` type to `FailureOutcome`, since both `rateOutcomeClassifier` and `retryClassifier` receive it.
- Fire-and-forget callbacks may now return any value, so `throttle(() => fetch(url))` type-checks. Only `false` still counts as a failure.
