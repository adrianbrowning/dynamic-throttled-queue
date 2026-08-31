import { describe, expect, it } from "vitest";
import { createRateController } from "../rate-controller.ts";
import { linear } from "../dynamic-throttled-queue.ts";

describe("rate controller", () => {
  it("exports the linear strategy with the compatibility decisions", () => {
    const common = {
      minRate: 1,
      maxRate: 5,
      errorThreshold: 2,
      hasPendingWork: true,
      wasBackedOff: false,
    };

    expect(linear({ ...common, currentRate: 3, errorCount: 2 })).toEqual({ nextRate: 2, shouldBackOff: true });
    expect(linear({ ...common, currentRate: 3, errorCount: 0 })).toEqual({ nextRate: 4, shouldBackOff: false });
  });

  it("starts at the midpoint and lowers the rate with a backoff request when its failure threshold is reached", () => {
    const controller = createRateController({
      min_rpi: 1,
      max_rpi: 5,
      errors_per_interval: 2,
    }, linear);

    expect(controller.rate).toBe(3);

    controller.recordCompletion(false);
    controller.recordCompletion(false);

    expect(controller.observe({ hasPendingWork: true, wasBackedOff: false })).toEqual({
      rate: 2,
      shouldBackOff: true,
    });
  });
});
