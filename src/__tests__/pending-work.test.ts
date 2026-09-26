import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPendingWork } from "../pending-work.ts";
import type { PendingWork, PendingWorkOptions } from "../pending-work.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function track(options: Partial<PendingWorkOptions> = {}) {
  let retriesQueued = 0;
  const work = createPendingWork<string>(
    { capacity: Infinity, compactThreshold: 512, ...options },
    { retryQueued: () => { retriesQueued++; } }
  );
  return { work, retriesQueued: () => retriesQueued };
}

function takeAll(work: PendingWork<string>) {
  const taken: Array<string> = [];
  for (let item = work.take(); item !== undefined; item = work.take()) taken.push(item);
  return taken;
}

/** Records whether an idle wait has resolved, rejected, or is still pending after microtasks flush. */
function watchIdle(work: PendingWork<string>) {
  const result: { status: "pending" | "resolved" | "rejected"; error?: unknown; } = { status: "pending" };
  void (async () => {
    try {
      await work.whenIdle();
      result.status = "resolved";
    }
    catch (error) {
      result.status = "rejected";
      result.error = error;
    }
  })();
  return result;
}

describe("pending work", () => {
  describe("queue", () => {
    it("hands out accepted items in FIFO order, each once", () => {
      const { work } = track();

      for (const item of [ "a", "b", "c" ]) work.accept(item);

      expect(work.queued).toBe(3);
      expect(takeAll(work)).toEqual([ "a", "b", "c" ]);
      expect(work.take()).toBeUndefined();
      expect(work).toMatchObject({ queued: 0, pending: 0, active: 3 });
    });

    it("keeps FIFO order and counts while compacting under interleaved accepts and takes", () => {
      const { work } = track({ compactThreshold: 0 });
      const taken: Array<string> = [];

      for (let i = 0; i < 20; i++) {
        work.accept(`${i}`);
        work.accept(`${i}b`);
        taken.push(work.take()!);
        expect(work.queued).toBe(i + 1);
      }
      taken.push(...takeAll(work));

      expect(taken).toEqual(Array.from({ length: 20 }, (_, i) => [ `${i}`, `${i}b` ]).flat());
    });

    it("queues an immediate retry behind already queued work and reports it", () => {
      const { work, retriesQueued } = track();
      work.accept("a");
      work.accept("b");
      work.take();

      work.settle({ item: "a again" });

      expect(retriesQueued()).toBe(1);
      expect(takeAll(work)).toEqual([ "b", "a again" ]);
    });
  });

  describe("capacity", () => {
    it("rejects accepts once queued, held and active items fill every reservation", () => {
      const { work } = track({ capacity: 3 });
      work.accept("active");
      work.take();
      work.accept("held");
      work.take();
      work.settle({ item: "held", delay: 1000 });
      work.accept("queued");

      expect(() => work.accept("over")).toThrow("maxQueueSize");
    });

    it("keeps a reservation through retries and releases it on a settlement without one", () => {
      const { work } = track({ capacity: 1 });
      work.accept("a");

      work.take();
      work.settle({ item: "a" });
      expect(() => work.accept("b")).toThrow("maxQueueSize");

      work.take();
      work.settle();
      expect(() => work.accept("b")).not.toThrow();
    });

    it("rejects every accept when capacity is zero", () => {
      const { work } = track({ capacity: 0 });

      expect(() => work.accept("a")).toThrow("maxQueueSize");
    });
  });

  describe("held retries", () => {
    it("counts a held retry as pending, then queues it once its delay elapses", () => {
      const { work, retriesQueued } = track();
      work.accept("a");
      work.take();

      work.settle({ item: "a again", delay: 500 });
      expect(work).toMatchObject({ queued: 0, pending: 1, active: 0 });

      vi.advanceTimersByTime(499);
      expect(work.queued).toBe(0);

      vi.advanceTimersByTime(1);
      expect(retriesQueued()).toBe(1);
      expect(work).toMatchObject({ queued: 1, pending: 1 });
      expect(work.take()).toBe("a again");
    });

    it("keeps a frozen retry's remaining delay and resumes it on thaw", () => {
      const { work } = track();
      work.accept("a");
      work.take();
      work.settle({ item: "a again", delay: 1000 });

      vi.advanceTimersByTime(400);
      work.freeze();
      vi.advanceTimersByTime(5000);
      expect(work.queued).toBe(0);

      work.thaw();
      vi.advanceTimersByTime(599);
      expect(work.queued).toBe(0);
      vi.advanceTimersByTime(1);
      expect(work.queued).toBe(1);
    });

    it("does not start the delay of a retry held while frozen until thaw", () => {
      const { work } = track();
      work.accept("a");
      work.take();
      work.freeze();

      work.settle({ item: "a again", delay: 500 });
      vi.advanceTimersByTime(5000);
      expect(work.queued).toBe(0);

      work.thaw();
      vi.advanceTimersByTime(500);
      expect(work.queued).toBe(1);
    });

    it("drops held retries and their timers on discard", () => {
      const { work, retriesQueued } = track();
      work.accept("a");
      work.take();
      work.settle({ item: "a again", delay: 500 });

      work.discard();
      vi.advanceTimersByTime(5000);

      expect(vi.getTimerCount()).toBe(0);
      expect(retriesQueued()).toBe(0);
      expect(work.pending).toBe(0);
    });
  });

  describe("idle", () => {
    it("resolves immediately when nothing is queued, held or active", async () => {
      const { work } = track();

      await expect(work.whenIdle()).resolves.toBeUndefined();
    });

    it("resolves when the last active item settles without a retry", async () => {
      const { work } = track();
      work.accept("a");
      const idle = watchIdle(work);

      work.take();
      await vi.advanceTimersByTimeAsync(0);
      expect(idle.status).toBe("pending");

      work.settle();
      await vi.advanceTimersByTimeAsync(0);
      expect(idle.status).toBe("resolved");
    });

    it.each([
      { name: "an immediate retry", retry: { item: "a" } },
      { name: "a held retry", retry: { item: "a", delay: 500 } },
    ])("stays pending through $name", async ({ retry }) => {
      const { work } = track();
      work.accept("a");
      work.take();
      const idle = watchIdle(work);

      work.settle(retry);
      vi.advanceTimersByTime(500);
      await vi.advanceTimersByTimeAsync(0);
      expect(idle.status).toBe("pending");

      work.take();
      work.settle();
      await vi.advanceTimersByTimeAsync(0);
      expect(idle.status).toBe("resolved");
    });

    it("stays pending when the settlement observer accepts more work", async () => {
      const { work } = track();
      work.accept("a");
      work.take();
      const idle = watchIdle(work);

      work.settle(undefined, () => work.accept("b"));
      await vi.advanceTimersByTimeAsync(0);

      expect(idle.status).toBe("pending");
    });

    it("rejects instead of resolving when the settlement observer fails the work", async () => {
      const failure = new Error("failed");
      const { work } = track();
      work.accept("a");
      work.take();
      const idle = watchIdle(work);

      work.settle(undefined, () => work.fail(failure));
      await vi.advanceTimersByTimeAsync(0);

      expect(idle).toEqual({ status: "rejected", error: failure });
    });

    it("resolves on discard when nothing is active", async () => {
      const { work } = track();
      work.accept("a");
      work.accept("b");
      const idle = watchIdle(work);

      work.discard();
      await vi.advanceTimersByTimeAsync(0);

      expect(idle.status).toBe("resolved");
    });

    it("waits for active items after discard, then resolves when they settle", async () => {
      const { work } = track();
      work.accept("a");
      work.accept("b");
      work.take();
      const idle = watchIdle(work);

      work.discard();
      await vi.advanceTimersByTimeAsync(0);
      expect(idle.status).toBe("pending");
      expect(work).toMatchObject({ pending: 0, active: 1 });

      work.settle();
      await vi.advanceTimersByTimeAsync(0);
      expect(idle.status).toBe("resolved");
    });

    it("rejects current waiters on fail without waiting for active items", async () => {
      const failure = new Error("failed");
      const { work } = track();
      work.accept("a");
      work.take();
      const idle = watchIdle(work);

      work.fail(failure);
      await vi.advanceTimersByTimeAsync(0);

      expect(idle).toEqual({ status: "rejected", error: failure });
      expect(work).toMatchObject({ pending: 0, active: 1 });
    });
  });
});
