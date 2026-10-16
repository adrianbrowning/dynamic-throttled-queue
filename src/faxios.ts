import { CanceledError, FaxiosError, isFaxiosError } from "@gcmdev/faxios";
import type { FaxiosPlugin, FaxiosRequestConfig, FaxiosResponse, InternalFaxiosRequestConfig } from "@gcmdev/faxios";
import { definePlugin } from "@gcmdev/faxios/plugins";
import { createThrottledQueue } from "./dynamic-throttled-queue.ts";
import type { FailureOutcome, ThrottleHandle, ThrottleOptions } from "./dynamic-throttled-queue.ts";

/**
 * The `FaxiosError` code of a request the queue refused to admit: the queue was aborted or has
 * failed, or `maxQueueSize` was reached.
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

const delaySeconds = /^\d+$/;
// The three HTTP-date forms RFC 9110 §5.6.7 says recipients must accept: IMF-fixdate
// (`Wed, 21 Oct 2015 07:28:00 GMT`), RFC 850 (`Wednesday, 21-Oct-15 07:28:00 GMT`) and asctime
// (`Wed Oct 21 07:28:00 2015`). Date.parse alone takes far more, such as `1.5` or `10/21/2015`.
const day = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const longDay = "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)";
const month = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const time = String.raw`\d{2}:\d{2}:\d{2}`;
const httpDate = new RegExp(
  String.raw`^(?:${day}, \d{2} ${month} \d{4} ${time} GMT`
  + String.raw`|${longDay}, \d{2}-${month}-\d{2} ${time} GMT`
  + String.raw`|${day} ${month} [ \d]\d ${time} \d{4})$`
);

/** Milliseconds to wait from a `Retry-After` value, or `undefined` when it is missing or malformed. A past date is 0. */
export function parseRetryAfter(value: unknown, now = Date.now()): number | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  // Huge values stay finite here; the queue clamps them to its maxCooldown.
  if (delaySeconds.test(trimmed)) return Math.min(Number(trimmed) * 1000, Number.MAX_SAFE_INTEGER);
  if (!httpDate.test(trimmed)) return undefined;
  // asctime has no zone; RFC 9110 says it is UTC, but Date.parse would read it as local time.
  const date = Date.parse(trimmed.endsWith(" GMT") ? trimmed : `${trimmed} GMT`);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

type Unlink = () => void;
type CallerSignal = NonNullable<FaxiosRequestConfig["signal"]>;

/** Calls `onAbort` when `signal` aborts. faxios accepts signal-like objects, which may have no listener methods. */
function onAbortOf(signal: CallerSignal, onAbort: () => void): Unlink {
  const { addEventListener: add, removeEventListener: remove } = signal;
  if (typeof add !== "function") return () => {};
  add.call(signal, "abort", onAbort, { once: true });
  return () => remove?.call(signal, "abort", onAbort);
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

/** A signal that aborts when either input does; `unlink` removes any listeners the fallback added. */
function linkSignals(caller: CallerSignal | undefined, item: AbortSignal): { signal: AbortSignal; unlink: Unlink; } {
  if (!caller) return { signal: item, unlink: () => {} };
  // AbortSignal.any only takes real AbortSignals.
  if (typeof AbortSignal.any === "function" && caller instanceof AbortSignal) {
    return { signal: AbortSignal.any([ caller, item ]), unlink: () => {} };
  }
  const controller = new AbortController();
  const fromCaller = () => controller.abort("reason" in caller ? caller.reason : undefined);
  const fromItem = () => controller.abort(item.reason);
  if (caller.aborted) fromCaller();
  else if (item.aborted) fromItem();
  const unlinkCaller = onAbortOf(caller, fromCaller);
  item.addEventListener("abort", fromItem, { once: true });
  return {
    signal: controller.signal,
    unlink: () => {
      unlinkCaller();
      item.removeEventListener("abort", fromItem);
    },
  };
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
  });
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
    ? createThrottledQueue({ rateOutcomeClassifier: isRateLimited, maxCooldown: defaultMaxCooldown, ...options, retry: 0 })
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
    name: "dynamic-throttle",
    middleware: async (ctx, next) => {
      const caller = ctx.config.signal;
      // Async middleware before this one can call next() after the caller aborted; queue nothing then.
      if (caller?.aborted) throw canceledBy(caller, ctx.config);
      const delivered = Promise.withResolvers<FaxiosResponse>();

      let handle;
      try {
        handle = queue.submit(async ({ signal: itemSignal }) => {
          const link = linkSignals(caller, itemSignal);
          try {
            // A fresh context: retry reuses ctx for its next attempt and must not see this signal.
            const response = await next({ ...ctx, config: { ...ctx.config, signal: link.signal } });
            applyCooldown(response);
            if (typeof ReadableStream === "undefined" || !(response.data instanceof ReadableStream)) {
              delivered.resolve(response);
              return;
            }
            const released = Promise.withResolvers<void>();
            response.data = holdUntilDone(response.data, link.signal, released.resolve);
            delivered.resolve(response);
            await released.promise;
          }
          catch (error) {
            if (isFaxiosError(error) && error.response) applyCooldown(error.response);
            throw error;
          }
          finally {
            link.unlink();
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
          // A FaxiosError came from the request. Otherwise the queue aborted (its AbortError) or failed.
          const { state } = queue.getState();
          if (isFaxiosError(error)) delivered.reject(error);
          else if (state === "aborted") delivered.reject(new CanceledError(null, ctx.config));
          else if (state === "failed") delivered.reject(throttleRejected(error, ctx.config));
          else delivered.reject(error);
        })
        .finally(() => unlinkCaller());
      // faxios settles the caller's promise on abort itself; this only takes the item out of the queue.
      if (caller) unlinkCaller = onAbortOf(caller, () => cancel(new CanceledError(null, ctx.config)));
      return delivered.promise;
    },
  });
}
