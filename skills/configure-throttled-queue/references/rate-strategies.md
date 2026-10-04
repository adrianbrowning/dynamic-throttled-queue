# Rate strategies and adjustment timing

Read this when the default one-step `linear` adaptation is too slow or too
fast, when writing a custom `RateStrategy`, or when slow callbacks make rate
decisions land in the wrong interval.

## Built-in strategies

| Strategy | Threshold reached | Clean interval with pending work | Otherwise |
| --- | --- | --- | --- |
| `linear` (default) | `currentRate - 1`, request backoff | `currentRate + 1` | hold |
| `aimd({ increaseBy = 1, decreaseFactor = 0.5 })` | `Math.floor(currentRate * decreaseFactor)`, request backoff | `currentRate + increaseBy` | hold |

A backoff request (`shouldBackOff: true`) skips an interval only when the queue
has `back_off: true`.

"Clean" means zero counted errors and the previous window was not a backoff.
Partial-error, empty, and immediately-post-backoff windows hold the rate. The
queue clamps every `nextRate` to `[min_rpi, max_rpi]`. `aimd()` throws unless
`increaseBy` is a positive integer and `0 < decreaseFactor < 1`.

```ts
import { aimd, createThrottledQueue } from "dynamic-throttled-queue";

const queue = createThrottledQueue({
  min_rpi: 1,
  max_rpi: 100,
  interval: 1000,
  rateStrategy: aimd({ increaseBy: 2, decreaseFactor: 0.5 }),
});
```

## Custom strategies

A `RateStrategy` is a pure function. It receives a frozen observation
`{ currentRate, minRate, maxRate, errorCount, errorThreshold, hasPendingWork, wasBackedOff }`
and returns `{ nextRate, shouldBackOff }`.

```ts
import { createThrottledQueue, type RateStrategy } from "dynamic-throttled-queue";

const decreaseOnly: RateStrategy = ({ currentRate, minRate, errorCount, errorThreshold }) => ({
  nextRate: errorCount >= errorThreshold ? Math.max(minRate, currentRate - 1) : currentRate,
  shouldBackOff: errorCount >= errorThreshold,
});

const queue = createThrottledQueue({ min_rpi: 1, max_rpi: 10, interval: 1000, rateStrategy: decreaseOnly });
```

- `nextRate` must be a finite integer and `shouldBackOff` a boolean. Anything
  else, or a thrown error, **fails the queue permanently** (see
  [lifecycle](lifecycle.md)). Never return `NaN`, fractions, or `undefined`.
- `shouldBackOff` only pauses scheduling when the queue has `back_off: true`.

## Adjustment timing

- `adjustmentTiming: "interval"` (default): each interval decides from the
  outcomes that have settled so far. A slow callback can settle after its start
  interval and affect a later decision.
- `adjustmentTiming: "settled"`: a window holds every attempt started during one
  interval. When collection closes, no further callbacks start until every
  attempt in the window settles, then exactly one decision is made. Use it when
  callbacks run longer than `interval` and decisions must reflect complete
  windows. A callback that never settles blocks later windows until it settles
  or the queue is aborted, so give callbacks timeouts.

While paused, settled outcomes do not count toward the rate. In settled timing,
`pause()` discards the open window.
