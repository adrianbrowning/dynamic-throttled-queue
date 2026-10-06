import { createThrottledQueue, type FailureOutcome } from "../../../src/dynamic-throttled-queue.ts";

export type Response = { status: number; body: unknown; };
export type Request = (signal: AbortSignal) => Promise<Response>;

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

const isHttpError = (outcome: FailureOutcome): outcome is Extract<FailureOutcome, { error: unknown; }> & { error: HttpError; } =>
  outcome.kind !== "returned-false" && outcome.error instanceof HttpError;
/** Reference solution following the configure-throttled-queue skill. */
export function createApiQueue(request: Request, { concurrency = 2 }: { concurrency?: number; } = {}) {
  const queue = createThrottledQueue({
    min_rpi: 1,
    max_rpi: 10,
    interval: 1000,
    ...(concurrency === Infinity ? {} : { concurrency }),
    retry: 2,
    retryClassifier: outcome => isHttpError(outcome) && (outcome.error.status === 429 || outcome.error.status >= 500),
    rateOutcomeClassifier: outcome => isHttpError(outcome) && outcome.error.status === 429,
  });
  return {
    get: () => queue.submit(async ({ signal }) => {
      const response = await request(signal);
      if (response.status < 200 || response.status >= 300) throw new HttpError(response.status);
      return response.body;
    }).result,
    shutdown: () => queue.abort(),
  };
}

/** The mistake the skill warns about: relying on the start rate to bound in-flight work. */
export const createApiQueueWithoutConcurrency = (request: Request) => createApiQueue(request, { concurrency: Infinity });
