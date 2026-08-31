type RateControllerOptions = {
  min_rpi: number;
  max_rpi: number;
  errors_per_interval: number;
  back_off: boolean;
};

type Observation = {
  hasPendingWork: boolean;
  wasSkipped: boolean;
};

export type RateDecision = {
  rate: number;
  shouldBackOff: boolean;
};

export type RateStrategy = (input: RateControllerOptions & Observation & {
  rate: number;
  errorCount: number;
}) => RateDecision;

export type RateController = {
  readonly rate: number;
  recordCompletion: (result: boolean | void) => void;
  observe: (observation: Observation) => RateDecision;
};

const linearRateStrategy: RateStrategy = ({
  min_rpi,
  max_rpi,
  errors_per_interval,
  back_off,
  rate,
  errorCount,
  hasPendingWork,
  wasSkipped,
}) => {
  if (errorCount >= errors_per_interval) {
    return {
      rate: Math.max(min_rpi, rate - 1),
      shouldBackOff: back_off && !wasSkipped,
    };
  }

  if (!wasSkipped && errorCount === 0 && hasPendingWork) {
    return { rate: Math.min(max_rpi, rate + 1), shouldBackOff: false };
  }

  return { rate, shouldBackOff: false };
};

export function createRateController(options: RateControllerOptions, strategy = linearRateStrategy): RateController {
  let rate = Math.ceil((options.max_rpi + options.min_rpi) / 2);
  let errorCount = 0;

  return {
    get rate() {
      return rate;
    },
    recordCompletion(result: boolean | void) {
      if (result === false) errorCount++;
    },
    observe(observation: Observation) {
      const decision = strategy({ ...options, ...observation, rate, errorCount });
      rate = Math.min(options.max_rpi, Math.max(options.min_rpi, decision.rate));
      errorCount = 0;
      return { ...decision, rate };
    },
  };
}
