---
dynamic-throttled-queue: minor
---

Ships a TanStack Intent agent skill, `configure-throttled-queue`, in the package. It teaches coding agents how to pick start rates versus `concurrency`, classify failures for the adaptive rate and for retries, use `cooldownFor`, `submit()` handles and cancellation, and the `pause`/`resume`/`stop`/`abort` lifecycle. Load it with `npx @tanstack/intent load dynamic-throttled-queue#configure-throttled-queue`.
