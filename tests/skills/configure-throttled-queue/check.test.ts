import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiQueue, createApiQueueWithoutConcurrency } from "./solution.ts";
import type { Request, Response } from "./solution.ts";

type Factory = typeof createApiQueue;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A server that answers after `latency` ms and records concurrency and aborts. */
function fakeServer(statuses: Array<number>, latency = 5000) {
  const stats = { calls: 0, inFlight: 0, maxInFlight: 0, aborted: 0, startTimes: [] as Array<number> };
  const request: Request = signal => new Promise<Response>((resolve, reject) => {
    const status = statuses[stats.calls++] ?? 200;
    stats.startTimes.push(Date.now());
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    const onAbort = () => {
      clearTimeout(timer);
      stats.inFlight--;
      stats.aborted++;
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      stats.inFlight--;
      resolve({ status, body: { status } });
    }, latency);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return { request, stats };
}

async function assertTaskBehavior(factory: Factory) {
  const burst = fakeServer([], 10);
  const burstApi = factory(burst.request);
  const burstResults = Array.from({ length: 30 }, () => burstApi.get());
  await vi.advanceTimersByTimeAsync(60_000);
  await expect(Promise.all(burstResults)).resolves.toHaveLength(30);
  for (const start of burst.stats.startTimes) {
    expect(burst.stats.startTimes.filter(time => time >= start && time < start + 1000).length).toBeLessThanOrEqual(10);
  }

  const inFlight = fakeServer([], 5000);
  const api = factory(inFlight.request);
  const results = Array.from({ length: 6 }, () => api.get());
  await vi.advanceTimersByTimeAsync(60_000);
  await expect(Promise.all(results)).resolves.toHaveLength(6);
  expect(inFlight.stats.inFlight).toBe(0);
  expect(inFlight.stats.maxInFlight).toBeLessThanOrEqual(2);

  const retrying = fakeServer([ 503, 429, 200 ], 10);
  const retried = factory(retrying.request).get();
  await vi.advanceTimersByTimeAsync(10_000);
  await expect(retried).resolves.toEqual({ status: 200 });
  expect(retrying.stats.calls).toBe(3);

  const permanent = fakeServer([ 404 ], 10);
  const rejected = factory(permanent.request).get();
  const outcome = rejected.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await outcome).toBeInstanceOf(Error);
  expect(permanent.stats.calls).toBe(1);

  const slow = fakeServer([], 60_000);
  const shutdownApi = factory(slow.request);
  const pending = shutdownApi.get().catch(() => "aborted");
  await vi.advanceTimersByTimeAsync(1000);
  shutdownApi.shutdown();
  await expect(pending).resolves.toBe("aborted");
  expect(slow.stats.aborted).toBe(1);
}

describe("configure-throttled-queue task check", () => {
  it("accepts the reference solution", async () => {
    await assertTaskBehavior(createApiQueue);
  });

  it("rejects a solution that relies on the start rate to bound in-flight work", async () => {
    await expect(assertTaskBehavior(createApiQueueWithoutConcurrency)).rejects.toThrow(/to be less than or equal to 2/);
  });
});
