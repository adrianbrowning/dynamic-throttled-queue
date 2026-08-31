import type { RateStrategy, RateStrategyDecision } from "./dynamic-throttled-queue.ts";

type RateControllerOptions = {
  min_rpi: number;
  max_rpi: number;
  errors_per_interval: number;
};

type Observation = {
  hasPendingWork: boolean;
  wasBackedOff: boolean;
};

export type RateDecision = {
  rate: number;
  shouldBackOff: boolean;
};

export type RateController = {
  readonly rate: number;
  recordCompletion: (isRateReducing: boolean) => void;
  observe: (observation: Observation) => RateDecision;
};

function validateDecision(decision: unknown): RateStrategyDecision {
  if (typeof decision !== "object" || decision === null) {
    throw new TypeError("rate strategy must return a decision object");
  }
  const candidate = decision as RateStrategyDecision;
  if (!Number.isFinite(candidate.nextRate) || !Number.isInteger(candidate.nextRate)) {
    throw new TypeError("rate strategy must return a finite integer nextRate");
  }
  if (typeof candidate.shouldBackOff !== "boolean") {
    throw new TypeError("rate strategy must return a boolean shouldBackOff");
  }
  return candidate;
}

export function createRateController(options: RateControllerOptions, strategy: RateStrategy): RateController {
  let rate = Math.ceil((options.max_rpi + options.min_rpi) / 2);
  let errorCount = 0;

  return {
    get rate() {
      return rate;
    },
    recordCompletion(isRateReducing: boolean) {
      if (isRateReducing) errorCount++;
    },
    observe(observation: Observation) {
      const decision = validateDecision(strategy(Object.freeze({
        currentRate: rate,
        minRate: options.min_rpi,
        maxRate: options.max_rpi,
        errorCount,
        errorThreshold: options.errors_per_interval,
        ...observation,
      })));
      rate = Math.min(options.max_rpi, Math.max(options.min_rpi, decision.nextRate));
      errorCount = 0;
      return { rate, shouldBackOff: decision.shouldBackOff };
    },
  };
}
