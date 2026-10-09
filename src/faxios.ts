import { CanceledError, FaxiosError, isFaxiosError } from "@gcmdev/faxios";
import type { FaxiosPlugin, FaxiosResponse } from "@gcmdev/faxios";
import { definePlugin } from "@gcmdev/faxios/plugins";
import { createThrottledQueue } from "./dynamic-throttled-queue.ts";
import type { FailureOutcome, ThrottleHandle, ThrottleOptions } from "./dynamic-throttled-queue.ts";

/** The `FaxiosError` code of a request the queue refused to admit (aborted queue or `maxQueueSize` reached). */
export const ERR_THROTTLE_REJECTED = "ERR_THROTTLE_REJECTED";

/** Queue options for a queue the plugin creates. Retries belong to faxios's `retry` plugin, so the queue never retries. */
export type DynamicThrottleQueueOptions = Omit<ThrottleOptions, "retry" | "retryBackoff" | "retryClassifier">;

export type DynamicThrottleOptions = (DynamicThrottleQueueOptions | { queue: ThrottleHandle; }) & {
  /** Also honour `Retry-After` on 503 responses. Default `false`: only 429 sets a cooldown. */
  retryAfterOn503?: boolean;
  /**
   * Reads a cooldown, in ms, from any response (resolved or carried by a rejection), for vendor
   * headers such as `X-RateLimit-Reset`. A number wins over `Retry-After`; `undefined` falls back to it.
   */
  cooldownFrom?: (response: FaxiosResponse) => number | undefined;
};

/** The default `rateOutcomeClassifier`: only a 429 response reduces capacity. */
export function isRateLimited(outcome: FailureOutcome): boolean {
  return "error" in outcome && isFaxiosError(outcome.error) && outcome.error.response?.status === 429;
}

const delaySeconds = /^\d+$/;
// IMF-fixdate, the HTTP-date form servers must send: `Wed, 21 Oct 2015 07:28:00 GMT`.
const httpDate = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/** Milliseconds to wait from a `Retry-After` value, or `undefined` when it is missing or malformed. A past date is 0. */
export function parseRetryAfter(value: unknown, now = Date.now()): number | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  // Huge values stay finite here; the queue clamps them to its maxCooldown.
  if (delaySeconds.test(trimmed)) return Math.min(Number(trimmed) * 1000, Number.MAX_SAFE_INTEGER);
  if (!httpDate.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

type Unlink = () => void;

/** A signal that aborts when either input does; `unlink` removes any listeners the fallback added. */
function linkSignals(caller: AbortSignal | undefined, item: AbortSignal): { signal: AbortSignal; unlink: Unlink; } {
  if (!caller) return { signal: item, unlink: () => {} };
  // AbortSignal.any only takes real AbortSignals; faxios also accepts signal-like objects.
  if (typeof AbortSignal.any === "function" && caller instanceof AbortSignal) {
    return { signal: AbortSignal.any([ caller, item ]), unlink: () => {} };
  }
  const controller = new AbortController();
  const fromCaller = () => controller.abort(caller.reason);
  const fromItem = () => controller.abort(item.reason);
  if (caller.aborted) fromCaller();
  else if (item.aborted) fromItem();
  caller.addEventListener("abort", fromCaller, { once: true });
  item.addEventListener("abort", fromItem, { once: true });
  return {
    signal: controller.signal,
    unlink: () => {
      caller.removeEventListener("abort", fromCaller);
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
 * (held until the body is read, or until a `stream` body ends), adaptive rate and `Retry-After`
 * cooldowns. Install it after `retry({ respectRetryAfter: false })`, so each attempt takes a slot
 * and only the queue honours `Retry-After`.
 */
export function dynamicThrottle(options: DynamicThrottleOptions): FaxiosPlugin {
  const { retryAfterOn503 = false, cooldownFrom } = options;
  const queue = "queue" in options
    ? options.queue
    : createThrottledQueue({ rateOutcomeClassifier: isRateLimited, ...options, retry: 0 });

  function applyCooldown(response: FaxiosResponse) {
    const custom = cooldownFrom?.(response);
    if (custom !== undefined) {
      if (Number.isFinite(custom) && custom >= 0) queue.cooldownFor(custom);
      return;
    }
    if (response.status !== 429 && (!retryAfterOn503 || response.status !== 503)) return;
    const { headers } = response as { headers?: { get?: (name: string) => unknown; }; };
    const ms = parseRetryAfter(typeof headers?.get === "function" ? headers.get("retry-after") : undefined);
    if (ms !== undefined) queue.cooldownFor(ms);
  }

  return definePlugin({
    name: "dynamic-throttle",
    middleware: async (ctx, next) => {
      // faxios settles the caller's promise on abort itself; the plugin only stops the queued work.
      const caller = ctx.config.signal as AbortSignal | undefined;
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
        throw new FaxiosError(error instanceof Error ? error.message : String(error), ERR_THROTTLE_REJECTED, ctx.config);
      }

      const { cancel, result } = handle;
      const onCallerAbort = () => cancel(new CanceledError(null, ctx.config));
      caller?.addEventListener("abort", onCallerAbort, { once: true });
      void result
        .catch((error: unknown) => {
          // Errors from next() are already faxios errors; anything else is the queue aborting or failing.
          if (isFaxiosError(error)) delivered.reject(error);
          else if (queue.getState().state === "aborted") delivered.reject(new CanceledError(null, ctx.config));
          else delivered.reject(error);
        })
        .finally(() => caller?.removeEventListener("abort", onCallerAbort));
      return delivered.promise;
    },
  });
}
