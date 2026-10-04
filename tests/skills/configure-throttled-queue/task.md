# Task: rate-limited API client

Write `src/api-queue.ts` exporting `createApiQueue(request)`, where
`request(signal)` performs one HTTP call and resolves to `{ status: number; body: unknown }`.

`createApiQueue` returns `{ get(): Promise<unknown>; shutdown(): void }` built on
`dynamic-throttled-queue` such that:

- At most 10 requests start per second, and at most 2 are in flight at once.
- Responses with status 429 or 5xx are retried up to 2 more times.
- Only 429 responses lower the adaptive rate (range 1–10 per second).
- Other non-2xx statuses reject `get()` without a retry.
- `get()` resolves to the 2xx response body.
- `shutdown()` stops all work and aborts in-flight requests.
