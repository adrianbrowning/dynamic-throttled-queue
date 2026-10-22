# Throttle a faxios client

Read this when you throttle a [faxios](https://github.com/adrianbrowning/faxios)
client. The plugin is `dynamic-throttled-queue/faxios`. It needs
`@gcmdev/faxios` 0.2.x or 0.3.x (peer range `^0.2.0 || ^0.3.0`). That package
is an optional peer dependency, so
install it in the application. With npm, a `@gcmdev/faxios` outside those
versions anywhere in the tree fails the install with `ERESOLVE`, even if
nothing imports `dynamic-throttled-queue/faxios`.
Source: `src/faxios.ts`, README "faxios plugin".

## 1. If you use `retry`, install the plugin after it

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

If you use faxios's `retry` plugin, obey these two rules. No other `retry`
setup is supported:

- Install `dynamicThrottle` **after** `retry`. Then each attempt takes its own
  queue slot, and the retry backoff waits outside the queue.
- Use `retry({ respectRetryAfter: false })`. Then only the queue honours
  `Retry-After`. A 503's `Retry-After` is then ignored unless you set
  `retryAfterOn503: true` (section 4).

Do not give the queue its own retries. Retries belong to the faxios `retry`
plugin. The queue options type (`DynamicThrottleQueueOptions`) removes
`retry`, `retryBackoff` and `retryClassifier`.

Check: the `.use()` calls are in this order, and `retry` gets
`respectRetryAfter: false`.

## 2. Choose the queue form

The default form gives queue options. The plugin creates one queue for the
client. That queue never retries (`retry: 0`), uses `isRateLimited` as its
`rateOutcomeClassifier`, and caps cooldowns at 5 minutes (`maxCooldown`
defaults to 300 000 ms; pass `maxCooldown` to change it).

Use the `{ queue }` form only when the client must share a queue with other
work, or when you need the queue handle (for example, to call `abort()`). You
then must set `retry: 0` and `rateOutcomeClassifier: isRateLimited` yourself,
and a `maxCooldown` (the queue default is about 24.8 days). Queue options
can't be combined with `{ queue }`; TypeScript rejects
`dynamicThrottle({ queue, rateOutcomeClassifier })`:

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
  maxCooldown: 300_000,
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

Check: a shared queue has `retry: 0`, `rateOutcomeClassifier: isRateLimited`
and a `maxCooldown`, and `dynamicThrottle` gets only `{ queue }` plus
`retryAfterOn503` or `cooldownFrom`.

## 3. Know what reduces the rate

With `isRateLimited`, only a 429 response reduces the rate. 401, 403, other
4xx responses and cancellations do not. If you widen `validateStatus` so that a
429 resolves, the cooldown still applies, but the rate does not drop.

## 4. Configure cooldowns

The plugin calls `cooldownFor()` for you. Do not call it from your own code
for faxios responses. A cooldown pauses the whole queue, so every origin the
client calls waits.

- `Retry-After` accepts delay-seconds and the three RFC 9110 HTTP-date forms:
  IMF-fixdate (`Wed, 21 Oct 2015 07:28:00 GMT`), RFC 850
  (`Wednesday, 21-Oct-15 07:28:00 GMT`) and asctime
  (`Wed Oct 21 07:28:00 2015`, read as UTC). A past date gives `0`. The plugin
  ignores a malformed value, such as `1.5` or `10/21/2015`.
- `maxCooldown` clamps long values. On a queue the plugin creates, it defaults
  to 300 000 ms (5 minutes), the same limit as faxios `retry`'s
  `maxRetryAfter`, which `respectRetryAfter: false` turns off.
- By default, only a 429's `Retry-After` sets a cooldown. Set
  `retryAfterOn503: true` to also honour `Retry-After` on 503 responses. With
  `respectRetryAfter: false` and no `retryAfterOn503`, a 503's `Retry-After`
  is ignored.
- To read a vendor header, set `cooldownFrom: (response) => ms | undefined`.
  It runs for **every** response, including successful ones and a response
  that a rejection carries. Any number it returns starts a cooldown, so return
  `undefined` unless the response is rate-limited. A finite number >= 0 takes
  priority over `Retry-After`. `undefined`, `NaN`, a negative number,
  `Infinity` or a throw falls back to `Retry-After`.

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
    // Only a used-up window is a cooldown; X-RateLimit-Reset holds epoch seconds.
    cooldownFrom: (response) => {
      if (response.status !== 429 && response.headers.get("x-ratelimit-remaining") !== "0") return undefined;
      return Number(response.headers.get("x-ratelimit-reset")) * 1000 - Date.now();
    },
  }));
```

## 5. Read or cancel every stream

A request holds its concurrency slot until faxios has read the body. For
`responseType: "stream"`, the slot is held until the stream ends, errors, or is
cancelled, or until the request or queue aborts. If you do not read or cancel a
stream, it keeps its slot. When all slots are held, no other request starts.

```ts
const response = await api.get<ReadableStream<Uint8Array>>("/export", { responseType: "stream" });
for await (const chunk of response.data) {
  handle(chunk);
}
// Leaving the loop early (break, return or a throw in the body) cancels the stream.
```

If you don't read a stream at all, cancel it: `await response.data.cancel()`.

A stream request that rejects (for example with a 4xx or 5xx status) frees its
slot at once. If `error.response.data` is a stream, read or cancel it too.

Check: every stream response is read to the end or cancelled.

## 6. Timeout

The two faxios lines count `timeout` differently. Check the installed version
(`VERSION` from `@gcmdev/faxios`, or `package.json`):

- **faxios 0.3:** `timeout` covers the whole request, including time in the
  queue. A request that times out while queued rejects with `ETIMEDOUT` and is
  never sent. Set `timeout` to include the longest queue wait you accept,
  including the first start of a new or idle queue: it waits one spacing
  (`interval / rate`), or a full `interval` with `evenly_spaced: false`.
  `retry({ attemptTimeout })` limits each try, and also includes that try's
  wait in the queue.
- **faxios 0.2:** faxios starts the `timeout` timer when it dispatches the
  request, so time in the queue does not count. To limit the total wait, also
  pass a `signal` (for example `AbortSignal.timeout(30_000)`); it rejects with
  `ERR_CANCELED`, which `retry` does not retry.

Check: the `timeout` value allows for queue wait on faxios 0.3.

## 7. Handle the errors

| Cause | Rejection | `error.code` |
| --- | --- | --- |
| The caller's `signal` aborts, or `queue.abort()` runs while the request is queued or in flight | `CanceledError` | `ERR_CANCELED` |
| `queue.abort()` runs after a stream response is delivered | the stream errors with the abort's `AbortError` | none (a `DOMException`) |
| The queue refuses to admit the request: it was aborted or has failed, or `maxQueueSize` is reached | `FaxiosError` | `ERR_THROTTLE_REJECTED` |
| The queue fails (its `rateStrategy` throws) while the request is queued or in flight | `FaxiosError`, `cause` is the strategy error | `ERR_THROTTLE_REJECTED` |

When the request is still queued at cancellation, it is never sent. A failed
queue also rethrows the strategy error from its timer (see "Lifecycle" in the
README); create a new queue to resume. `ERR_THROTTLE_REJECTED` is
exported as a constant:

```ts
import { isFaxiosError } from "@gcmdev/faxios";
import { ERR_THROTTLE_REJECTED } from "dynamic-throttled-queue/faxios";

try {
  await api.get("/items");
} catch (error) {
  if (isFaxiosError(error) && error.code === ERR_THROTTLE_REJECTED) {
    // The queue is full, aborted or failed. Do not retry immediately.
  }
  throw error;
}
```

Check: the code handles `ERR_THROTTLE_REJECTED` where `maxQueueSize` is set,
and treats `ERR_CANCELED` as a cancellation, not as a server failure.
