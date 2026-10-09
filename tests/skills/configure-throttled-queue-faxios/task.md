# Task: throttled faxios client

Write `src/api.ts` exporting `createApi(fetch)`. `fetch` has the type of
`globalThis.fetch`; pass it to faxios as `env: { fetch }`.

`createApi` returns `{ api, shutdown(): void }`, where `api` is a
`@gcmdev/faxios` instance with `baseURL: "https://api.example.com"`, throttled with
`dynamic-throttled-queue`, such that:

- At most 10 requests start per second, and at most 1 is in flight at once.
- Responses with status 429 or 5xx are retried up to 2 more times.
- A request that waits to retry does not block other requests.
- A 429 `Retry-After` header is honoured.
- Only 429 responses lower the adaptive rate (range 1–10 per second).
- Other non-2xx statuses reject without a retry.
- `shutdown()` stops all work: queued requests are never sent, and in-flight
  requests are aborted.
