import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduler } from "../scheduler.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduler", () => {
  it("uses supplied rate decisions while retaining evenly spaced callback scheduling", () => {
    const recordCompletion = vi.fn();
    const scheduler = createScheduler({ min_rpi: 1, interval: 1000 }, {
      rate: 2,
      clearObservation: vi.fn(),
      recordCompletion,
      observe: () => ({ rate: 2, shouldBackOff: false }),
    });
    let started = 0;

    scheduler(() => { started++; });
    scheduler(() => { started++; });

    vi.advanceTimersByTime(500);
    expect(started).toBe(1);
    vi.advanceTimersByTime(500);
    expect(started).toBe(2);
    expect(recordCompletion).toHaveBeenCalledTimes(2);
  });
});
