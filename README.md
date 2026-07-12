# dynamic-throttled-queue

Dynamically throttles arbitrary code to execute between a minimum and maximum number of times per interval. Best for making throttled API requests.

For example, making network calls to popular APIs such as Twitter is subject to rate limits. By wrapping all of your API calls in a throttle, it will automatically adjust your requests to be within the acceptable rate limits.

Unlike the `throttle` functions of popular libraries like lodash and underscore, `dynamic-throttled-queue` will not prevent any executions. Instead, every execution is placed into a queue, which will be drained at the desired rate limit.

Originally forked from [shaunpersad/throttled-queue](https://github.com/shaunpersad/throttled-queue).

## Installation

```bash
pnpm add dynamic-throttled-queue
```

## Usage

```ts
import { createThrottledQueue } from "dynamic-throttled-queue";

const throttle = createThrottledQueue({ min_rpi: 5, interval: 1000 });

throttle(() => {
  // perform some type of activity in here.
});
```

Callbacks can return `false` to signal an error (used for dynamic rate adjustment and retry). Async callbacks (returning a Promise) are also supported — rejections and `false` resolutions count as errors.

## Options

| Param | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `min_rpi` | `number` | *required* | Minimum requests per interval |
| `max_rpi` | `number` | `min_rpi` | Maximum requests per interval |
| `interval` | `number` | *required* | Milliseconds between each batch of requests |
| `evenly_spaced` | `boolean` | `true` | Distribute requests evenly throughout the interval |
| `errors_per_interval` | `number` | `5` | Error threshold per interval before adjusting rate |
| `back_off` | `boolean` | `false` | Back off for 1 full interval when error threshold is hit |
| `retry` | `number` | `0` | Number of times to retry failed callbacks |
| `compact_threshold` | `number` | `512` | Minimum dead slots before internal queue compaction triggers |
| `onRateChange` | `(rate: number) => void` | — | Called when the current rate changes |
| `debug` | `boolean` | `false` | Log internal state to console |

> **Deprecated:** `errors_per_second` still works as an alias for `errors_per_interval` but will be removed in a future major version.

## Examples

### Basic

```ts
import { createThrottledQueue } from "dynamic-throttled-queue";

const throttle = createThrottledQueue({ min_rpi: 1, interval: 1000 });

for (let i = 0; i < 100; i++) {
  throttle(() => {
    fetch("https://api.example.com/data").then(console.log);
  });
}
```

### Batch mode (not evenly spaced)

```ts
const throttle = createThrottledQueue({ min_rpi: 10, interval: 1000, evenly_spaced: false });

for (let i = 0; i < 100; i++) {
  throttle(() => {
    // Fires up to 10 at once per second
    fetch("https://api.example.com/data").then(console.log);
  });
}
```

### Dynamic rate adjustment

When `max_rpi` > `min_rpi`, the queue dynamically adjusts throughput based on errors. Starts at the midpoint and scales up (0 errors) or down (>= threshold errors) each interval.

```ts
const throttle = createThrottledQueue({
  min_rpi: 1,
  max_rpi: 10,
  interval: 1000,
  errors_per_interval: 3,
  onRateChange: (rate) => console.log(`Rate: ${rate}/interval`),
});

for (let i = 0; i < 100; i++) {
  throttle(async () => {
    const res = await fetch("https://api.example.com/data");
    if (!res.ok) return false; // signals an error
  });
}
```

### Backoff

```ts
const throttle = createThrottledQueue({
  min_rpi: 10,
  interval: 1000,
  back_off: true,
  errors_per_interval: 2,
});
```

### Retry

```ts
const throttle = createThrottledQueue({
  min_rpi: 5,
  interval: 1000,
  retry: 3, // retry failed callbacks up to 3 times
});

throttle(async () => {
  const res = await fetch("https://api.example.com/data");
  if (!res.ok) return false; // will be retried
});
```

## Development

```bash
pnpm install
pnpm build      # build with zshy (ESM only)
pnpm test       # run vitest
pnpm lint       # type-check
```

## License

MIT
