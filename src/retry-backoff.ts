import type { RetryBackoff } from "./dynamic-throttled-queue.ts";

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

export function calculateRetryDelay(policy: RetryBackoff, retryIndex: number): number {
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
