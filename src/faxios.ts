import { CanceledError, FaxiosError, isFaxiosError } from "@gcmdev/faxios";
import type { FaxiosPlugin, FaxiosRequestConfig, FaxiosResponse, InternalFaxiosRequestConfig } from "@gcmdev/faxios";
import { definePlugin } from "@gcmdev/faxios/plugins";
import { createThrottledQueue } from "./dynamic-throttled-queue.ts";
import type { FailureOutcome, ThrottleHandle, ThrottleOptions } from "./dynamic-throttled-queue.ts";
import { parseRetryAfter } from "./retry-after.ts";

/**
 * The `FaxiosError` code of a request the queue refused to admit (the queue was aborted or has
 * failed, or `maxQueueSize` was reached), or one the queue failed while it was queued or in flight.
 * `cause` is the queue's error.
 */
export const ERR_THROTTLE_REJECTED = "ERR_THROTTLE_REJECTED";

/** Queue options for a queue the plugin creates. Retries belong to faxios's `retry` plugin, so the queue never retries. */
export type DynamicThrottleQueueOptions = Omit<ThrottleOptions, "retry" | "retryBackoff" | "retryClassifier">;

/** The longest server-directed cooldown on a queue the plugin creates: 5 minutes, as faxios `retry`'s `maxRetryAfter`. */
const defaultMaxCooldown = 300_000;

export type DynamicThrottleOptions = (
  | (DynamicThrottleQueueOptions & { queue?: never; })
  | ({
    /**
     * An existing queue to share. Create it with `retry: 0` and `rateOutcomeClassifier: isRateLimited`;
     * queue options can't be combined with it.
     */
    queue: ThrottleHandle;
  } & { [K in keyof DynamicThrottleQueueOptions]?: never; })
) & {
  /** Also honour `Retry-After` on 503 responses. Default `false`: only a 429's `Retry-After` sets a cooldown. */
  retryAfterOn503?: boolean;
  /**
   * Reads a cooldown, in ms, from every response, including successful ones and one a rejection
   * carries, for vendor headers such as `X-RateLimit-Reset`. Any number it returns starts a
   * cooldown, so return `undefined` unless the response is rate-limited. A finite number >= 0 wins
   * over `Retry-After`; `undefined`, any other value, or a throw falls back to `Retry-After`.
   */
  cooldownFrom?: (response: FaxiosResponse) => number | undefined;
};

/** The default `rateOutcomeClassifier`: only a 429 response reduces capacity. */
export function isRateLimited(outcome: FailureOutcome): boolean {
  return "error" in outcome && isFaxiosError(outcome.error) && outcome.error.response?.status === 429;
}

type Unlink = () => void;
type CallerSignal = NonNullable<FaxiosRequestConfig["signal"]>;

type Listenable = {
  addEventListener: (type: "abort", listener: () => void) => unknown;
  removeEventListener?: (type: "abort", listener: () => void) => unknown;
};

/** faxios 0.2 accepts signal-like objects with no listener methods, or only `addEventListener`; 0.3 requires both. */
function isListenable(signal: CallerSignal): signal is CallerSignal & Listenable {
  return typeof signal.addEventListener === "function";
}

/** Calls `onAbort` when `signal` aborts; a signal without `addEventListener` can't be watched. */
function onAbortOf(signal: CallerSignal, onAbort: () => void): Unlink {
  if (!isListenable(signal)) return () => {};
  const target: Listenable = signal;
  target.addEventListener("abort", onAbort);
  return () => target.removeEventListener?.("abort", onAbort);
}

/** The `CanceledError` faxios gives an aborted request: its message and cause come from the abort reason. */
function canceledBy(signal: CallerSignal, config: InternalFaxiosRequestConfig): CanceledError {
  const reason = "reason" in signal ? signal.reason : undefined;
  let message: null | string = null;
  if (reason instanceof Error) message = reason.message;
  else if (typeof reason === "string") message = reason;
  const error = new CanceledError(message, config);
  if (reason instanceof Error) error.cause = reason;
  return error;
}

/** The `ERR_THROTTLE_REJECTED` error for a queue that refused or failed a request; `cause` is the queue's error. */
function throttleRejected(cause: unknown, config: InternalFaxiosRequestConfig): FaxiosError {
  const error = new FaxiosError(cause instanceof Error ? cause.message : String(cause), ERR_THROTTLE_REJECTED, config);
  if (cause instanceof Error) error.cause = cause;
  return error;
}

/** Wraps `stream` so `release` runs exactly once: on end, read error, consumer cancel or `signal` abort. */
function holdUntilDone(stream: ReadableStream, signal: AbortSignal, release: () => void): ReadableStream {
  const reader = stream.getReader();
  let controller!: ReadableStreamDefaultController;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    signal.removeEventListener("abort", onAbort);
    release();
  };
  function onAbort() {
    if (done) return;
    finish();
    controller.error(signal.reason);
    reader.cancel(signal.reason).catch(() => {});
  }
  // highWaterMark 0: read the source only when the consumer reads, so no chunk is buffered ahead.
  const wrapped = new ReadableStream({
    start(c) {
      controller = c;
    },
    async pull(c) {
      try {
        const chunk = await reader.read();
        if (done) return;
        if (chunk.done) {
          finish();
          c.close();
        }
        else c.enqueue(chunk.value);
      }
      catch (error) {
        finish();
        throw error;
      }
    },
    async cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
  // The signal can abort between next() resolving and this wrapper existing.
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return wrapped;
}

/**
 * Throttles a faxios client through a dynamic-throttled-queue: start pacing, bounded concurrency
 * (held until the body is read; for a `stream` body, until it ends, errors, is cancelled or
 * aborts), adaptive rate and `Retry-After` cooldowns. If you use `retry`, install it before this
 * plugin with `retry({ respectRetryAfter: false })`, so each attempt takes a slot and only the
 * queue honours `Retry-After`.
 */
export function dynamicThrottle(options: DynamicThrottleOptions): FaxiosPlugin {
  const { retryAfterOn503 = false, cooldownFrom } = options;
  const queue = options.queue === undefined
    ? createThrottledQueue({
      ...options,
      rateOutcomeClassifier: options.rateOutcomeClassifier ?? isRateLimited,
      maxCooldown: options.maxCooldown ?? defaultMaxCooldown,
      retry: 0,
    })
    : options.queue;

  function customCooldown(response: FaxiosResponse): number | undefined {
    let ms: unknown;
    try {
      ms = cooldownFrom?.(response);
    }
    catch {
      return undefined;
    }
    return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms : undefined;
  }

  function applyCooldown(response: FaxiosResponse) {
    const custom = customCooldown(response);
    if (custom !== undefined) {
      queue.cooldownFor(custom);
      return;
    }
    if (response.status !== 429 && (!retryAfterOn503 || response.status !== 503)) return;
    const ms = parseRetryAfter(response.headers.get("retry-after"));
    if (ms !== undefined) queue.cooldownFor(ms);
  }

  return definePlugin({
    name: "dynamicThrottle",
    middleware: async (ctx, next) => {
      const caller = ctx.config.signal;
      // Async middleware before this one can call next() after the caller aborted; queue nothing then.
      if (caller?.aborted) throw canceledBy(caller, ctx.config);
      const delivered = Promise.withResolvers<FaxiosResponse>();

      let handle;
      try {
        handle = queue.submit(async ({ signal }) => {
          try {
            // The queue item's signal: the caller's abort cancels the item (below), and so does queue.abort().
            // A fresh context: retry reuses ctx for its next attempt and must not see this signal.
            const response = await next({ ...ctx, config: { ...ctx.config, signal } });
            applyCooldown(response);
            if (!(response.data instanceof ReadableStream)) {
              delivered.resolve(response);
              return;
            }
            const released = Promise.withResolvers<void>();
            response.data = holdUntilDone(response.data, signal, released.resolve);
            delivered.resolve(response);
            await released.promise;
          }
          catch (error) {
            if (isFaxiosError(error) && error.response) applyCooldown(error.response);
            throw error;
          }
        });
      }
      catch (error) {
        throw throttleRejected(error, ctx.config);
      }

      const { cancel, result } = handle;
      let unlinkCaller: Unlink = () => {};
      // Handle the result before touching the caller's signal, so nothing can leave it unhandled.
      void result
        .catch((error: unknown) => {
          // A FaxiosError came from the request (on faxios 0.3, also a timeout's ETIMEDOUT). Otherwise
          // the caller's abort cancelled the item, or the queue aborted (its AbortError) or failed.
          const { state } = queue.getState();
          if (isFaxiosError(error)) delivered.reject(error);
          else if (caller?.aborted) delivered.reject(canceledBy(caller, ctx.config));
          else if (state === "aborted") delivered.reject(new CanceledError(null, ctx.config));
          else if (state === "failed") delivered.reject(throttleRejected(error, ctx.config));
          else delivered.reject(error);
        })
        .finally(() => unlinkCaller());
      // faxios settles the caller's promise on abort itself; this takes the item out of the queue, and
      // aborts its signal with the caller's reason, so a delivered stream errors with it (on faxios 0.3,
      // a timeout's ETIMEDOUT).
      if (caller) unlinkCaller = onAbortOf(caller, () => cancel("reason" in caller ? caller.reason : undefined));
      return delivered.promise;
    },
  });
}
