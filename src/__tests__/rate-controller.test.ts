import { describe, expect, it } from "vitest";
import { createRateController } from "../rate-controller.ts";

describe("rate controller", () => {
  it("starts at the midpoint and lowers the rate with a backoff request when its failure threshold is reached", () => {
    const controller = createRateController({
      min_rpi: 1,
      max_rpi: 5,
      errors_per_interval: 2,
      back_off: true,
    });

    expect(controller.rate).toBe(3);

    controller.recordCompletion(false);
    controller.recordCompletion(false);

    expect(controller.observe({ hasPendingWork: true, wasSkipped: false })).toEqual({
      rate: 2,
      shouldBackOff: true,
    });
  });
});
