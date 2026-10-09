import faxios from "@gcmdev/faxios";
import { retry } from "@gcmdev/faxios/plugins/retry";
import { createThrottledQueue } from "../../../src/dynamic-throttled-queue.ts";
import { dynamicThrottle, isRateLimited } from "../../../src/faxios.ts";

type Mistakes = { throttleBeforeRetry?: boolean; queueRetries?: boolean; };

function build(fetch: typeof globalThis.fetch, mistakes: Mistakes = {}) {
  const queue = createThrottledQueue({
    min_rpi: 1,
    max_rpi: 10,
    interval: 1000,
    concurrency: 1,
    retry: mistakes.queueRetries ? 2 : 0,
    rateOutcomeClassifier: isRateLimited,
  });
  const client = faxios.create({ baseURL: "https://api.example.com", env: { fetch } });
  const throttle = dynamicThrottle({ queue });
  const retries = retry({ attempts: 3, respectRetryAfter: false });
  const api = mistakes.throttleBeforeRetry ? client.use(throttle).use(retries) : client.use(retries).use(throttle);
  return { api, shutdown: () => queue.abort() };
}

/** Reference solution following the configure-throttled-queue faxios reference. */
export const createApi = (fetch: typeof globalThis.fetch) => build(fetch);

/** Mistake: the throttle is installed before `retry`, so the retry backoff holds the slot. */
export const createApiThrottleBeforeRetry = (fetch: typeof globalThis.fetch) => build(fetch, { throttleBeforeRetry: true });

/** Mistake: a shared queue that also retries, so each faxios attempt is retried again. */
export const createApiWithQueueRetries = (fetch: typeof globalThis.fetch) => build(fetch, { queueRetries: true });
