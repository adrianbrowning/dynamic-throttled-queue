# Throttle a faxios client

Read this when you throttle a [faxios](https://github.com/adrianbrowning/faxios)
client. The plugin is `dynamic-throttled-queue/faxios`. It needs
`@gcmdev/faxios` with `.use()` middleware. That package is an optional peer
dependency, so install it in the application. Source: `src/faxios.ts`, README
"faxios plugin".

## 1. Install the plugin after `retry`

```ts
import faxios from "@gcmdev/faxios";
import { retry } from "@gcmdev/faxios/plugins/retry";
import { dynamicThrottle } from "dynamic-throttled-queue/faxios";

const api = faxios
  .create({ baseURL: "https://api.example.com", timeout: 10_000 })
  .use(retry({ respectRetryAfter: false }))
  .use(dynamicThrottle({ min_rpi: 5, max_rpi: 20, interval: 1_000, concurrency: 4 }));

const { data } = await api.get("/items");
```

Obey these two rules. No other `retry` setup is supported:

- Install `dynamicThrottle` **after** `retry`. Then each attempt takes its own
  queue slot, and the retry backoff waits outside the queue.
- Use `retry({ respectRetryAfter: false })`. Then only the queue honours
  `Retry-After`.

Do not give the queue its own retries. Retries belong to the faxios `retry`
plugin. The queue options type (`DynamicThrottleQueueOptions`) removes
`retry`, `retryBackoff` and `retryClassifier`.

Check: the `.use()` calls are in this order, and `retry` gets
`respectRetryAfter: false`.

## 2. Choose the queue form

The default form gives queue options. The plugin creates one queue for the
client. That queue never retries (`retry: 0`) and uses `isRateLimited` as its
`rateOutcomeClassifier`.

Use the `{ queue }` form only when the client must share a queue with other
work, or when you need the queue handle (for example, to call `abort()`). You
then must set `retry: 0` and `rateOutcomeClassifier: isRateLimited` yourself:

```ts
import faxios from "@gcmdev/faxios";
import { retry } from "@gcmdev/faxios/plugins/retry";
import { createThrottledQueue } from "dynamic-throttled-queue";
import { dynamicThrottle, isRateLimited } from "dynamic-throttled-queue/faxios";

const queue = createThrottledQueue({
  min_rpi: 5,
  max_rpi: 20,
  interval: 1_000,
  concurrency: 4,
  retry: 0,
  rateOutcomeClassifier: isRateLimited,
});

const api = faxios
  .create({ baseURL: "https://api.example.com" })
  .use(retry({ respectRetryAfter: false }))
  .use(dynamicThrottle({ queue }));

// Shut down: queued requests are never sent; in-flight requests are aborted.
queue.abort();
```

If you omit `retry: 0`, the queue and the `retry` plugin both retry. If you
omit `isRateLimited`, every failure (also 401, 404 and cancellations) reduces
the rate.

Check: a shared queue has `retry: 0` and `rateOutcomeClassifier: isRateLimited`.

## 3. Know what reduces the rate

With `isRateLimited`, only a 429 response reduces the rate. 401, 403, other
4xx responses and cancellations do not. If you widen `validateStatus` so that a
429 resolves, the cooldown still applies, but the rate does not drop.

## 4. Configure cooldowns

The plugin calls `cooldownFor()` for you. Do not call it from your own code
for faxios responses.

- `Retry-After` accepts delay-seconds and the IMF-fixdate HTTP-date
  (`Wed, 21 Oct 2015 07:28:00 GMT`). A past date gives `0`. The plugin ignores
  a malformed value. The queue's `maxCooldown` clamps long values.
- By default, only a 429 sets a cooldown. Set `retryAfterOn503: true` to also
  honour `Retry-After` on 503 responses.
- To read a vendor header, set `cooldownFrom: (response) => ms | undefined`.
  It runs for every response, including a response that a rejection carries. A
  number that it returns takes priority over `Retry-After`. `undefined` falls
  back to `Retry-After`.

```ts
import faxios from "@gcmdev/faxios";
import { retry } from "@gcmdev/faxios/plugins/retry";
import { dynamicThrottle } from "dynamic-throttled-queue/faxios";

const api = faxios
  .create({ baseURL: "https://api.example.com" })
  .use(retry({ respectRetryAfter: false }))
  .use(dynamicThrottle({
    min_rpi: 5,
    interval: 1_000,
    maxCooldown: 60_000,
    retryAfterOn503: true,
    // X-RateLimit-Reset holds epoch seconds.
    cooldownFrom: (response) => {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      return Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : undefined;
    },
  }));
```

`parseRetryAfter(value, now?)` is also exported if you need the same parsing.

## 5. Read or cancel every stream

A request holds its concurrency slot until faxios has read the body. For
`responseType: "stream"`, the slot is held until the stream ends, errors, or is
cancelled, or until the request or queue aborts. If you do not read or cancel a
stream, it keeps its slot. When all slots are held, no other request starts.

```ts
const response = await api.get("/export", { responseType: "stream" });
try {
  for await (const chunk of response.data) {
    process(chunk);
  }
} finally {
  // Releases the slot if the loop stopped early.
  await response.data.cancel().catch(() => {});
}
```

Check: every stream response is read to the end or cancelled.

## 6. Timeout

faxios starts the `timeout` timer when it dispatches the request. Time in the
queue does not count against `timeout`. To limit the total wait, also pass a
`signal` (for example `AbortSignal.timeout(30_000)`).

## 7. Handle the errors

| Cause | Rejection | `error.code` |
| --- | --- | --- |
| The caller's `signal` aborts, or `queue.abort()` runs | `CanceledError` | `ERR_CANCELED` |
| The queue refuses to admit the request (queue aborted, or `maxQueueSize` reached) | `FaxiosError` | `ERR_THROTTLE_REJECTED` |

When the request is still queued at cancellation, it is never sent.
`ERR_THROTTLE_REJECTED` is exported as a constant:

```ts
import { isFaxiosError } from "@gcmdev/faxios";
import { ERR_THROTTLE_REJECTED } from "dynamic-throttled-queue/faxios";

try {
  await api.get("/items");
} catch (error) {
  if (isFaxiosError(error) && error.code === ERR_THROTTLE_REJECTED) {
    // The queue is full or aborted. Do not retry immediately.
  }
  throw error;
}
```

Check: the code handles `ERR_THROTTLE_REJECTED` where `maxQueueSize` is set,
and treats `ERR_CANCELED` as a cancellation, not as a server failure.
