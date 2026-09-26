import { describe, expect, it } from "vitest";
import { aimd, linear } from "../dynamic-throttled-queue.ts";

describe("rate strategies", () => {
  it("exports AIMD with a one-step increase and half-rate decrease by default", () => {
    const strategy = aimd();
    const common = {
      minRate: 1,
      maxRate: 10,
      errorThreshold: 2,
      hasPendingWork: true,
      wasBackedOff: false,
    };

    expect(strategy({ ...common, currentRate: 4, errorCount: 0 })).toEqual({ nextRate: 5, shouldBackOff: false });
    expect(strategy({ ...common, currentRate: 5, errorCount: 2 })).toEqual({ nextRate: 2, shouldBackOff: true });
  });

  it("uses its configured additive increase and multiplicative decrease", () => {
    const strategy = aimd({ increaseBy: 3, decreaseFactor: 0.6 });
    const common = {
      minRate: 1,
      maxRate: 10,
      errorThreshold: 1,
      hasPendingWork: true,
      wasBackedOff: false,
    };

    expect(strategy({ ...common, currentRate: 4, errorCount: 0 })).toEqual({ nextRate: 7, shouldBackOff: false });
    expect(strategy({ ...common, currentRate: 7, errorCount: 1 })).toEqual({ nextRate: 4, shouldBackOff: true });
  });

  it.each([
    { options: { increaseBy: 0 }, parameter: "increaseBy" },
    { options: { increaseBy: 1.5 }, parameter: "increaseBy" },
    { options: { increaseBy: Infinity }, parameter: "increaseBy" },
    { options: { decreaseFactor: 0 }, parameter: "decreaseFactor" },
    { options: { decreaseFactor: 1 }, parameter: "decreaseFactor" },
    { options: { decreaseFactor: NaN }, parameter: "decreaseFactor" },
  ])("rejects an invalid $parameter", ({ options, parameter }) => {
    expect(() => aimd(options)).toThrow(parameter);
  });

  it.each([
    { errorCount: 1, hasPendingWork: true, wasBackedOff: false },
    { errorCount: 0, hasPendingWork: false, wasBackedOff: false },
    { errorCount: 0, hasPendingWork: true, wasBackedOff: true },
  ])("holds steady when an adjustment trigger is not met", observation => {
    expect(aimd()({
      currentRate: 5,
      minRate: 1,
      maxRate: 10,
      errorThreshold: 2,
      ...observation,
    })).toEqual({ nextRate: 5, shouldBackOff: false });
  });

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
});
