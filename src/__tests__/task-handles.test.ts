import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createThrottledQueue } from "../dynamic-throttled-queue.ts";
import type { TaskHandle } from "../dynamic-throttled-queue.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("submit()", () => {
  it("fulfills with the callback's value, treating false as a value rather than a failure", async () => {
    const queue = createThrottledQueue({ min_rpi: 1, interval: 1000, retry: 2 });
    let starts = 0;

    const task = queue.submit(() => { starts++; return false; });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(task.result).resolves.toBe(false);
    expect(starts).toBe(1);
    expect(queue.getState()).toMatchObject({ started: 1, succeeded: 1, failed: 0, retried: 0 });
  });

  it("fulfills with an async callback's resolved value", async () => {
    const queue = createThrottledQueue({ min_rpi: 1, interval: 1000 });

    const task = queue.submit(async () => "value");
    await vi.advanceTimersByTimeAsync(1000);

    await expect(task.result).resolves.toBe("value");
  });

  it("rejects with the final attempt's error only after retries are exhausted, exposing each attempt", async () => {
    const queue = createThrottledQueue({ min_rpi: 1, interval: 1000, retry: 2 });
    const attempts: Array<number> = [];
    let settled = false;

    const task = queue.submit(({ attempt }) => {
      attempts.push(attempt);
      throw new Error(`attempt ${attempt}`);
    });
    const outcome = task.result.catch((error: unknown) => error).finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(2000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(outcome).resolves.toMatchObject({ message: "attempt 3" });
    expect(attempts).toEqual([ 1, 2, 3 ]);
    expect(queue.getState()).toMatchObject({ started: 3, failed: 3, retried: 2 });
  });

  it("fulfills once when a later attempt succeeds after a rejection", async () => {
    const queue = createThrottledQueue({ min_rpi: 1, interval: 1000, retry: 1 });

    const task = queue.submit(async ({ attempt }) => {
      if (attempt === 1) throw new Error("transient");
      return "recovered";
    });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(task.result).resolves.toBe("recovered");
    expect(queue.getState()).toMatchObject({ started: 2, failed: 1, succeeded: 1, retried: 1 });
  });

  it("passes the attempt number to fire-and-forget callbacks", () => {
    const queue = createThrottledQueue({ min_rpi: 1, interval: 1000, retry: 1 });
    const attempts: Array<number> = [];

    queue(({ attempt }) => { attempts.push(attempt); return false; });
    vi.advanceTimersByTime(10_000);

    expect(attempts).toEqual([ 1, 2 ]);
  });
});

describe("cancel()", () => {
  it("removes a pending item without starting it or consuming its start slot", async () => {
    const queue = createThrottledQueue({ min_rpi: 1, interval: 1000, maxQueueSize: 2 });
    const started: Array<string> = [];

    queue.submit(() => { started.push("first"); });
    const second = queue.submit(() => { started.push("second"); });
    second.cancel();

    await expect(second.result).rejects.toMatchObject({ name: "AbortError" });
    expect(queue.getState()).toMatchObject({ pending: 1, canceled: 1 });
    expect(() => queue.submit(() => { started.push("third"); })).not.toThrow();

    await vi.advanceTimersByTimeAsync(2000);
    expect(started).toEqual([ "first", "third" ]);
  });

  it("rejects with the supplied reason and ignores later calls", async () => {
    const queue = createThrottledQueue({ min_rpi: 1, interval: 1000 });
    const reason = new Error("caller gave up");

    const task = queue.submit(() => {});
    task.cancel(reason);
    task.cancel(new Error("ignored"));

    await expect(task.result).rejects.toBe(reason);
    expect(queue.getState().canceled).toBe(1);
  });

  it("drops a delayed retry so it never runs again", async () => {
    const queue = createThrottledQueue({ min_rpi: 1, interval: 1000, retry: 1, retryBackoff: { strategy: "fixed", baseDelay: 5000 } });
    let starts = 0;

    const task = queue.submit(() => { starts++; throw new Error("fail"); });
    await vi.advanceTimersByTimeAsync(1000);
    expect(queue.getState()).toMatchObject({ pending: 1, retried: 1 });

    task.cancel();
    await expect(task.result).rejects.toMatchObject({ name: "AbortError" });
    expect(queue.getState().pending).toBe(0);
    await expect(queue.waitForIdle()).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(starts).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not settle a result that already fulfilled", async () => {
    const queue = createThrottledQueue({ min_rpi: 1, interval: 1000 });

    const task = queue.submit(() => "done");
    await vi.advanceTimersByTimeAsync(1000);
    task.cancel();

    await expect(task.result).resolves.toBe("done");
    expect(queue.getState().canceled).toBe(0);
  });

  it("aborts only the canceled item's signal and rejects before its callback settles", async () => {
    const queue = createThrottledQueue({ min_rpi: 3, interval: 1000, evenly_spaced: false, retry: 2 });
    const signals: Record<string, AbortSignal> = {};
    const release = Promise.withResolvers<void>();
    const run = (name: string) => async ({ signal }: { signal: AbortSignal; }) => {
      signals[name] = signal;
      await release.promise;
      signal.throwIfAborted();
      return name;
    };

    const canceled = queue.submit(run("canceled"));
    const sibling = queue.submit(run("sibling"));
    queue(async ({ signal }) => { signals.legacy = signal; await release.promise; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(queue.getState().active).toBe(3);

    canceled.cancel();
    await expect(canceled.result).rejects.toMatchObject({ name: "AbortError" });
    expect(signals.canceled!.aborted).toBe(true);
    expect(signals.sibling!.aborted).toBe(false);
    expect(signals.legacy!.aborted).toBe(false);
    expect(queue.getState().active).toBe(3);

    let idle = false;
    void queue.waitForIdle().finally(() => { idle = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(idle).toBe(false);

    release.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(sibling.result).resolves.toBe("sibling");
    expect(idle).toBe(true);
    expect(queue.getState()).toMatchObject({ active: 0, started: 3, succeeded: 2, failed: 0, retried: 0, canceled: 1 });
  });

  it("does not count a canceled attempt's failure toward rate decreases", async () => {
    const rates: Array<number> = [];
    const queue = createThrottledQueue({
      min_rpi: 1,
      max_rpi: 3,
      interval: 1000,
      evenly_spaced: false,
      errors_per_interval: 1,
      onRateChange: rate => rates.push(rate),
    });

    const task = queue.submit(async ({ signal }) => {
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    });
    await vi.advanceTimersByTimeAsync(1000);
    task.cancel();
    await expect(task.result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1000);

    expect(rates).not.toContain(1);
    expect(queue.getState()).toMatchObject({ failed: 0, rateDecreases: 0 });
  });
});

describe("queue-wide termination", () => {
  it("abort() rejects pending and active items at once and aborts each item's signal", async () => {
    const queue = createThrottledQueue({ min_rpi: 1, interval: 1000, retry: 1, retryBackoff: { strategy: "fixed", baseDelay: 5000 } });
    let activeSignal!: AbortSignal;
    const finish = Promise.withResolvers<string>();

    const active = queue.submit(async ({ signal }) => { activeSignal = signal; return finish.promise; });
    const delayed = queue.submit(() => { throw new Error("retry me"); });
    const queued = queue.submit(() => "never");
    await vi.advanceTimersByTimeAsync(2000);
    expect(queue.getState()).toMatchObject({ active: 1, pending: 2, retried: 1 });

    const outcomes = Promise.allSettled([ active, delayed, queued ].map(async task => task.result));
    queue.abort();
    expect(activeSignal.aborted).toBe(true);

    finish.resolve("too late");
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await outcomes).map(outcome => outcome.status === "rejected" && (outcome.reason as Error).name)).toEqual([ "AbortError", "AbortError", "AbortError" ]);
    expect(queue.getState()).toMatchObject({ active: 0, pending: 0, started: 2, succeeded: 0, failed: 1 });
    expect(() => queue.submit(() => {})).toThrow("aborted");
  });

  it("terminal failure rejects every unsettled item with the strategy error", async () => {
    const failure = new Error("strategy failed");
    const queue = createThrottledQueue({
      min_rpi: 1,
      max_rpi: 2,
      interval: 1000,
      evenly_spaced: false,
      concurrency: 1,
      rateStrategy: () => { throw failure; },
    });
    let activeSignal!: AbortSignal;
    const finish = Promise.withResolvers<void>();

    const active = queue.submit(async ({ signal }) => { activeSignal = signal; await finish.promise; });
    const queued = queue.submit(() => {});

    expect(() => vi.advanceTimersByTime(1000)).toThrow(failure);
    await expect(active.result).rejects.toBe(failure);
    await expect(queued.result).rejects.toBe(failure);
    expect(activeSignal.aborted).toBe(true);
    expect(() => queue.submit(() => {})).toThrow(failure);
    finish.resolve();
  });
});

describe("retained work and admission", () => {
  it("keeps results pending across pause() and stop(), then settles them once work resumes", async () => {
    const queue = createThrottledQueue({ min_rpi: 1, interval: 1000, evenly_spaced: false });
    let settled = 0;

    queue.pause();
    const paused = queue.submit(() => "paused");
    void paused.result.then(() => settled++);
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(0);

    queue.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(0);

    const restart = queue.submit(() => "restart");
    await vi.advanceTimersByTimeAsync(5000);
    await expect(paused.result).resolves.toBe("paused");
    await expect(restart.result).resolves.toBe("restart");
  });

  it("throws synchronously when every capacity reservation is taken", () => {
    const queue = createThrottledQueue({ min_rpi: 1, interval: 1000, maxQueueSize: 1 });

    queue.submit(() => {});

    expect(() => queue.submit(() => {})).toThrow("maxQueueSize");
    expect(queue.getState().pending).toBe(1);
  });
});

describe("cancellation races", () => {
  it("does not retry when retryClassifier cancels the item while its retry is being decided", async () => {
    let task!: TaskHandle<unknown>;
    const queue = createThrottledQueue({
      min_rpi: 1,
      interval: 1000,
      retry: 3,
      retryClassifier: () => { task.cancel(); return true; },
    });
    let starts = 0;

    task = queue.submit(() => { starts++; throw new Error("fail"); });
    const reason = task.result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await reason).toMatchObject({ name: "AbortError" });
    expect(starts).toBe(1);
    expect(queue.getState()).toMatchObject({ pending: 0, retried: 0, canceled: 1 });
  });

  it("drops a just-placed retry when rateOutcomeClassifier cancels the item", async () => {
    let task!: TaskHandle<unknown>;
    const queue = createThrottledQueue({
      min_rpi: 1,
      interval: 1000,
      retry: 3,
      rateOutcomeClassifier: () => { task.cancel(); return true; },
    });
    let starts = 0;

    task = queue.submit(() => { starts++; throw new Error("fail"); });
    const reason = task.result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await reason).toMatchObject({ name: "AbortError" });
    expect(starts).toBe(1);
    expect(queue.getState()).toMatchObject({ pending: 0, retried: 1, canceled: 1 });
    await expect(queue.waitForIdle()).resolves.toBeUndefined();
  });

  it("settles with the cancellation when the callback cancels its own item", async () => {
    let task!: TaskHandle<unknown>;
    const queue = createThrottledQueue({ min_rpi: 1, interval: 1000, retry: 1 });
    const reason = new Error("self-canceled");

    task = queue.submit(() => { task.cancel(reason); return "ignored"; });
    const rejection = task.result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await rejection).toBe(reason);
    expect(queue.getState()).toMatchObject({ started: 1, succeeded: 0, active: 0, canceled: 1 });
  });

  it("ignores cancel() on an item already rejected by abort()", async () => {
    const queue = createThrottledQueue({ min_rpi: 1, interval: 1000 });

    const task = queue.submit(() => {});
    queue.abort();
    task.cancel(new Error("late"));

    await expect(task.result).rejects.toMatchObject({ name: "AbortError" });
    expect(queue.getState().canceled).toBe(0);
  });
});
