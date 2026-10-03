import type { RateFailureOutcome } from "./adaptive-rate.ts";

export type RetryBackoff = {
  strategy: "fixed" | "linear" | "exponential";
  baseDelay: number;
  maxDelay?: number;
  jitter?: number;
  random?: () => number;
};

export type RetryClassifier = (outcome: RateFailureOutcome, attempt: number) => boolean;

export type RetryPolicyOptions = {
  retry?: number;
  retryBackoff?: RetryBackoff;
  retryClassifier?: RetryClassifier;
};

/** How a failed attempt continues: `{}` retries now, `{ delay }` retries after `delay` ms. */
type RetryDecision = Readonly<{ delay?: number; }>;

export type RetryPolicy = {
  /** Decides whether failed attempt `attempt` (one-based) gets another attempt. `undefined` drops it. */
  decide: (outcome: RateFailureOutcome, attempt: number) => RetryDecision | undefined;
};

const strategies: Readonly<Record<RetryBackoff["strategy"], true>> = { fixed: true, linear: true, exponential: true };
const retryNow: RetryDecision = Object.freeze({});

function validate(retry: number, retryBackoff: RetryBackoff | undefined) {
  if (!Number.isInteger(retry) || retry < 0) {
    throw new Error("retry must be a non-negative integer");
  }
  if (retryBackoff === undefined) return;
  if (!Object.hasOwn(strategies, retryBackoff.strategy)) {
    throw new Error("retryBackoff.strategy must be fixed, linear, or exponential");
  }
  if (!Number.isFinite(retryBackoff.baseDelay) || retryBackoff.baseDelay < 0) {
    throw new Error("retryBackoff.baseDelay must be a finite non-negative number");
  }
  if (retryBackoff.maxDelay !== undefined && (!Number.isFinite(retryBackoff.maxDelay) || retryBackoff.maxDelay < 0)) {
    throw new Error("retryBackoff.maxDelay must be a finite non-negative number");
  }
  if (retryBackoff.jitter !== undefined && (!Number.isFinite(retryBackoff.jitter) || retryBackoff.jitter < 0 || retryBackoff.jitter > 1)) {
    throw new Error("retryBackoff.jitter must be a finite number from 0 through 1");
  }
}

function readRandom(random: (() => number) | undefined): number | undefined {
  try {
    // eslint-disable-next-line sonarjs/pseudo-random -- Default jitter requires a random source.
    const value = random?.() ?? Math.random();
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
  }
  catch {
    return undefined;
  }
}

function calculateRetryDelay(policy: RetryBackoff, retryIndex: number): number {
  let delay: number;
  switch (policy.strategy) {
    case "linear": delay = policy.baseDelay * retryIndex; break;
    case "exponential": delay = policy.baseDelay * 2 ** (retryIndex - 1); break;
    default: delay = policy.baseDelay;
  }
  const cappedDelay = policy.maxDelay === undefined ? delay : Math.min(delay, policy.maxDelay);
  if (policy.jitter === undefined) return cappedDelay;
  const random = readRandom(policy.random);
  if (random === undefined) return cappedDelay;
  const jitteredDelay = cappedDelay * (1 + (random * 2 - 1) * policy.jitter);
  return policy.maxDelay === undefined ? jitteredDelay : Math.min(jitteredDelay, policy.maxDelay);
}

/** Validates the retry options, then decides each failed attempt: drop, retry now, or retry after a delay. */
export function createRetryPolicy({ retry = 0, retryBackoff, retryClassifier }: RetryPolicyOptions): RetryPolicy {
  validate(retry, retryBackoff);

  function isRetryable(outcome: RateFailureOutcome, attempt: number) {
    if (!retryClassifier) return true;
    try {
      return retryClassifier(outcome, attempt) === true;
    }
    catch {
      return true;
    }
  }

  return {
    decide(outcome, attempt) {
      if (attempt > retry || !isRetryable(outcome, attempt)) return undefined;
      return retryBackoff === undefined ? retryNow : { delay: calculateRetryDelay(retryBackoff, attempt) };
    },
  };
}
