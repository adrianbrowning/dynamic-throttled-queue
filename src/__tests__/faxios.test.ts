import faxios, { isCancel } from "@gcmdev/faxios";
import type { FaxiosError } from "@gcmdev/faxios";
import { retry } from "@gcmdev/faxios/plugins/retry";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createThrottledQueue, linear } from "../dynamic-throttled-queue.ts";
import type { ThrottleHandle } from "../dynamic-throttled-queue.ts";
import { dynamicThrottle, ERR_THROTTLE_REJECTED, isRateLimited, parseRetryAfter } from "../faxios.ts";
import type { DynamicThrottleOptions } from "../faxios.ts";

type Call = { url: string; at: number; signal: AbortSignal; respond: (response: Response) => void; };

/** A fake fetch whose responses the test supplies; `auto` answers every call immediately. */
function fakeFetch(auto?: () => Response) {
  const calls: Array<Call> = [];
  const begin = performance.now();
  const fetch = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const signal = init?.signal ?? request.signal;
    const { promise, resolve, reject } = Promise.withResolvers<Response>();
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    calls.push({ url: request.url, at: performance.now() - begin, signal, respond: resolve });
    if (auto) resolve(auto());
    return promise;
  });
  return { fetch, calls };
}

function client(fetch: ReturnType<typeof fakeFetch>["fetch"], options: DynamicThrottleOptions) {
  return faxios.create({ baseURL: "https://api.test", env: { fetch } }).use(dynamicThrottle(options));
}

const ok = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
const status = (code: number, headers: Record<string, string> = {}) => new Response("{}", { status: code, headers });

/** A body that streams `chunks` one per `gap` ms. */
function slowBody(chunks: number, gap: number) {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      await tick(gap);
      if (sent++ === chunks) c.close();
      else c.enqueue(new TextEncoder().encode("x"));
    },
  });
}

// Real timers on purpose: these run faxios's fetch adapter and web streams end to end, and the
// queue paces with performance.now(); short real waits keep that path unfaked.
async function tick(ms = 0) {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await tick(5);
  expect(check()).toBe(true);
}

describe("parseRetryAfter", () => {
  const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
  // asctime has no zone and must read as UTC; outside UTC a local-time parse would be off by hours.
  beforeAll(() => vi.stubEnv("TZ", "America/New_York"));
  afterAll(() => vi.unstubAllEnvs());
  it.each([
    [ "120", 120_000 ],
    [ " 2 ", 2000 ],
    [ "Wed, 21 Oct 2015 07:28:05 GMT", 5000 ],
    [ "Wed, 21 Oct 2015 07:27:00 GMT", 0 ],
    [ "Wednesday, 21-Oct-15 07:28:05 GMT", 5000 ],
    [ "Wed Oct 21 07:28:05 2015", 5000 ],
    [ "Thu Oct  1 07:28:00 2015", 0 ],
    [ "Wed Oct 21 07:28:05 2015 GMT", undefined ],
    [ "10/21/2015", undefined ],
    [ "soon", undefined ],
    [ "-5", undefined ],
    [ "1.5", undefined ],
    [ "", undefined ],
    [ undefined, undefined ],
  ])("%j → %j", (value, expected) => {
    expect(parseRetryAfter(value, now)).toBe(expected);
  });

  it("keeps a huge delay finite, for the queue to clamp", () => {
    expect(parseRetryAfter("9".repeat(400))).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("dynamicThrottle", () => {
  it("starts requests in FIFO order at the configured rate", async () => {
    const { fetch, calls } = fakeFetch(ok);
    const api = client(fetch, { min_rpi: 1, interval: 50 });
    await Promise.all([ api.get("/a"), api.get("/b"), api.get("/c") ]);
    expect(calls.map(c => new URL(c.url).pathname)).toEqual([ "/a", "/b", "/c" ]);
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(40);
    expect(calls[2]!.at - calls[1]!.at).toBeGreaterThanOrEqual(40);
  });

  it("holds the concurrency slot until the body has been read", async () => {
    const { fetch, calls } = fakeFetch();
    const api = client(fetch, { min_rpi: 100, interval: 1000, concurrency: 1 });
    const a = api.get("/a");
    const b = api.get("/b");
    await until(() => calls.length === 1);
    calls[0]!.respond(new Response(slowBody(5, 20)));
    let aDone = false;
    void a.then(() => (aDone = true));
    await tick(50);
    expect(calls).toHaveLength(1);
    await until(() => calls.length === 2);
    expect(aDone).toBe(true);
    calls[1]!.respond(ok());
    await expect(b).resolves.toMatchObject({ status: 200 });
  });

  describe("a stream response holds the slot until the stream finishes", () => {
    type Setup = { data: ReadableStream; source: ReadableStreamDefaultController<Uint8Array>; controller: AbortController; queue: ReturnType<typeof createThrottledQueue>; };
    const drain = async (data: ReadableStream) => {
      const reader = data.getReader();
      while (!(await reader.read()).done);
    };
    it.each<[string, (s: Setup) => Promise<void> | void]>([
      [ "end", ({ data, source }) => { void drain(data); source.close(); } ],
      [ "read error", ({ data, source }) => { void drain(data).catch(() => {}); source.error(new Error("boom")); } ],
      // A buffered chunk means no read is waiting, so only the wrapper's cancel() can release the slot.
      [ "consumer cancel", async ({ data, source }) => { source.enqueue(new Uint8Array([ 1 ])); await tick(10); void data.cancel(); } ],
      [ "caller abort", ({ controller }) => controller.abort() ],
    ])("released on %s", async (_name, finish) => {
      const { fetch, calls } = fakeFetch();
      const queue = createThrottledQueue({ min_rpi: 100, interval: 1000, concurrency: 1, retry: 0 });
      const api = client(fetch, { queue });
      const controller = new AbortController();
      let source!: ReadableStreamDefaultController<Uint8Array>;
      const a = api.get<ReadableStream>("/a", { responseType: "stream", signal: controller.signal });
      await until(() => calls.length === 1);
      calls[0]!.respond(new Response(new ReadableStream<Uint8Array>({ start(c) { source = c; } })));
      const { data } = await a;
      void api.get("/b").catch(() => {});
      await tick(20);
      expect(calls).toHaveLength(1);
      await finish({ data, source, controller, queue });
      // B gets the freed slot, and C still waits behind it.
      await until(() => calls.length === 2);
      void api.get("/c").catch(() => {});
      await tick(20);
      expect(calls).toHaveLength(2);
      expect(queue.getState().active).toBe(1);
    });

    it("released on queue abort, which errors the stream", async () => {
      const { fetch, calls } = fakeFetch();
      const queue = createThrottledQueue({ min_rpi: 100, interval: 1000, concurrency: 1, retry: 0 });
      const api = client(fetch, { queue });
      const a = api.get<ReadableStream>("/a", { responseType: "stream" });
      await until(() => calls.length === 1);
      calls[0]!.respond(new Response(new ReadableStream<Uint8Array>()));
      const { data } = await a;
      expect(queue.getState().active).toBe(1);
      const reading = data.getReader().read();
      queue.abort();
      await expect(reading).rejects.toMatchObject({ name: "AbortError" });
      await until(() => queue.getState().active === 0);
    });
  });

  it("gives each retry attempt its own slot and waits out Retry-After once, in the queue", async () => {
    let n = 0;
    const { fetch, calls } = fakeFetch(() => (n++ === 0 ? status(429, { "retry-after": "1" }) : ok()));
    const onRetry = vi.fn();
    const queue = createThrottledQueue({ min_rpi: 100, interval: 1000, retry: 0, rateOutcomeClassifier: isRateLimited });
    const api = faxios.create({ baseURL: "https://api.test", env: { fetch } })
      .use(retry({ respectRetryAfter: false, attempts: 2, delay: 1, onRetry }))
      .use(dynamicThrottle({ queue }));
    await expect(api.get("/a")).resolves.toMatchObject({ status: 200 });
    expect(calls).toHaveLength(2);
    expect(queue.getState().started).toBe(2);
    expect(queue.getState().cooldowns).toBe(1);
    expect(onRetry.mock.calls[0]![2]).toBeLessThan(100);
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(950);
  });

  it.each([
    [ 429, true ],
    [ 401, false ],
    [ 403, false ],
    [ 400, false ],
  ])("status %i reduces capacity: %s", async (code, reduces) => {
    // /a answers with `code`; the rest never answer, so /d stays queued and the queue keeps deciding each interval.
    const { fetch } = fakeFetch();
    fetch.mockImplementation(async (input: Request | string | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/a")) return status(code);
      return Promise.withResolvers<Response>().promise;
    });
    const rateStrategy = vi.fn(linear);
    const api = client(fetch, { min_rpi: 1, max_rpi: 10, interval: 50, concurrency: 2, rateStrategy });
    const a = api.get("/a");
    void api.get("/b");
    void api.get("/c");
    void api.get("/d");
    await expect(a).rejects.toMatchObject({ response: { status: code } });
    await until(() => rateStrategy.mock.calls.length > 0);
    expect(rateStrategy.mock.calls.some(([ observation ]) => observation.errorCount > 0)).toBe(reduces);
  });

  it("does not reduce capacity on cancellation", async () => {
    const { fetch, calls } = fakeFetch();
    const rateStrategy = vi.fn(linear);
    const api = client(fetch, { min_rpi: 1, max_rpi: 10, interval: 50, concurrency: 2, rateStrategy });
    const controller = new AbortController();
    const a = api.get("/a", { signal: controller.signal });
    for (const path of [ "/b", "/c", "/d" ]) void api.get(path);
    await until(() => calls.length === 2);
    controller.abort();
    await expect(a).rejects.toSatisfy(isCancel);
    await until(() => rateStrategy.mock.calls.length > 0);
    expect(rateStrategy.mock.calls.every(([ observation ]) => observation.errorCount === 0)).toBe(true);
  });

  describe("cooldowns", () => {
    async function cooldownAfter(response: () => Response, options: Pick<DynamicThrottleOptions, "cooldownFrom" | "retryAfterOn503"> = {}, config = {}) {
      const { fetch } = fakeFetch(response);
      const queue = createThrottledQueue({ min_rpi: 100, interval: 1000, retry: 0 });
      const api = client(fetch, { queue, ...options });
      await api.get("/a", config).catch(() => {});
      return queue.getState().cooldownRemaining;
    }

    it("applies delay-seconds and HTTP-date on 429", async () => {
      expect(await cooldownAfter(() => status(429, { "retry-after": "2" }))).toBeGreaterThan(1900);
      const date = new Date(Date.now() + 5000).toUTCString();
      expect(await cooldownAfter(() => status(429, { "retry-after": date }))).toBeGreaterThan(3500);
    });

    it("ignores past dates and malformed values", async () => {
      expect(await cooldownAfter(() => status(429, { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" }))).toBe(0);
      expect(await cooldownAfter(() => status(429, { "retry-after": "soon" }))).toBe(0);
    });

    it("clamps an oversized value to maxCooldown", async () => {
      const { fetch } = fakeFetch(() => status(429, { "retry-after": "999999" }));
      const queue = createThrottledQueue({ min_rpi: 100, interval: 1000, retry: 0, maxCooldown: 3000 });
      await client(fetch, { queue }).get("/a")
        .catch(() => {});
      expect(queue.getState().cooldownRemaining).toBeLessThanOrEqual(3000);
      expect(queue.getState().cooldownRemaining).toBeGreaterThan(2500);
    });

    it("honours 503 only when enabled, and never other 5xx", async () => {
      const unavailable = () => status(503, { "retry-after": "2" });
      expect(await cooldownAfter(unavailable)).toBe(0);
      expect(await cooldownAfter(unavailable, { retryAfterOn503: true })).toBeGreaterThan(1900);
      expect(await cooldownAfter(() => status(500, { "retry-after": "2" }), { retryAfterOn503: true })).toBe(0);
    });

    it("uses cooldownFrom for vendor headers", async () => {
      const cooldownFrom = vi.fn((response: { headers: { get: (n: string) => unknown; }; }) => Number(response.headers.get("x-ratelimit-reset")) * 1000);
      expect(await cooldownAfter(() => status(200, { "x-ratelimit-reset": "3" }), { cooldownFrom })).toBeGreaterThan(2900);
    });

    it.each<[string, () => Response, () => number | undefined, number]>([
      [ "a number wins over Retry-After", () => status(429, { "retry-after": "1" }), () => 3000, 2900 ],
      [ "undefined falls back to Retry-After", () => status(429, { "retry-after": "2" }), () => undefined, 1900 ],
      [ "NaN falls back to Retry-After", () => status(429, { "retry-after": "2" }), () => NaN, 1900 ],
      [ "a negative number falls back to Retry-After", () => status(429, { "retry-after": "2" }), () => -1, 1900 ],
      [ "Infinity falls back to Retry-After", () => status(429, { "retry-after": "2" }), () => Infinity, 1900 ],
      [ "a throw falls back to Retry-After", () => status(429, { "retry-after": "2" }), () => { throw new Error("bad header"); }, 1900 ],
      [ "it also reads a rejected non-429 response", () => status(500), () => 3000, 2900 ],
    ])("cooldownFrom: %s", async (_name, response, cooldownFrom, atLeast) => {
      expect(await cooldownAfter(response, { cooldownFrom })).toBeGreaterThan(atLeast);
    });

    it("keeps a successful response and the original error when cooldownFrom is invalid or throws", async () => {
      const { fetch } = fakeFetch(() => status(200));
      for (const cooldownFrom of [ () => NaN, () => { throw new Error("bad header"); } ]) {
        await expect(client(fetch, { min_rpi: 100, interval: 1000, cooldownFrom }).get("/a")).resolves.toMatchObject({ status: 200 });
      }
      const limited = fakeFetch(() => status(429));
      const throwing = () => { throw new Error("bad header"); };
      await expect(client(limited.fetch, { min_rpi: 100, interval: 1000, cooldownFrom: throwing }).get("/a"))
        .rejects.toMatchObject({ isFaxiosError: true, response: { status: 429 } });
    });

    it("applies a cooldown to a resolved 429 when validateStatus is widened", async () => {
      expect(await cooldownAfter(() => status(429, { "retry-after": "2" }), {}, { validateStatus: () => true })).toBeGreaterThan(1900);
    });
  });

  describe("cancellation and errors", () => {
    it("caller abort while queued: ERR_CANCELED, the item leaves the queue and never starts", async () => {
      const { fetch, calls } = fakeFetch();
      const queue = createThrottledQueue({ min_rpi: 100, interval: 1000, concurrency: 1, retry: 0 });
      const api = client(fetch, { queue });
      void api.get("/a").catch(() => {});
      const controller = new AbortController();
      const b = api.get("/b", { signal: controller.signal });
      await until(() => calls.length === 1);
      controller.abort();
      await expect(b).rejects.toMatchObject({ code: "ERR_CANCELED" });
      expect(queue.getState().pending).toBe(0);
      calls[0]!.respond(ok());
      await tick(30);
      expect(calls).toHaveLength(1);
      expect(queue.getState().started).toBe(1);
    });

    it("queues nothing when the caller aborted during earlier async middleware", async () => {
      const { fetch, calls } = fakeFetch(ok);
      const queue = createThrottledQueue({ min_rpi: 100, interval: 1000, retry: 0, maxQueueSize: 1 });
      const api = faxios.create({ baseURL: "https://api.test", env: { fetch } })
        .use(async (ctx, next) => {
          await tick(20);
          return next(ctx);
        })
        .use(dynamicThrottle({ queue }));
      const controller = new AbortController();
      const a = api.get("/a", { signal: controller.signal });
      controller.abort();
      await expect(a).rejects.toMatchObject({ code: "ERR_CANCELED" });
      await tick(30);
      expect(queue.getState()).toMatchObject({ pending: 0, started: 0 });
      await expect(api.get("/b")).resolves.toMatchObject({ status: 200 });
      expect(calls).toHaveLength(1);
    });

    describe("a signal-like caller signal", () => {
      const unhandled = vi.fn();
      beforeEach(() => {
        unhandled.mockClear();
        process.on("unhandledRejection", unhandled);
      });
      afterEach(() => {
        process.off("unhandledRejection", unhandled);
      });

      it("without listener methods: the request still runs, with no unhandled rejection", async () => {
        const { fetch } = fakeFetch(ok);
        const api = client(fetch, { min_rpi: 100, interval: 1000 });
        await expect(api.get("/a", { signal: { aborted: false, onabort: null } })).resolves.toMatchObject({ status: 200 });
        await tick(10);
        expect(unhandled).not.toHaveBeenCalled();
      });

      it("with listener methods: an abort cancels the request and aborts native fetch", async () => {
        const { fetch, calls } = fakeFetch();
        const listeners = new Set<unknown>();
        const signal = {
          aborted: false,
          addEventListener: (_type: unknown, listener: unknown) => { listeners.add(listener); },
          removeEventListener: (_type: unknown, listener: unknown) => { listeners.delete(listener); },
        };
        const a = client(fetch, { min_rpi: 100, interval: 1000 }).get("/a", { signal });
        await until(() => calls.length === 1);
        signal.aborted = true;
        for (const listener of listeners) if (typeof listener === "function") listener();
        await expect(a).rejects.toMatchObject({ code: "ERR_CANCELED" });
        expect(calls[0]!.signal.aborted).toBe(true);
        await tick(10);
        expect(listeners.size).toBe(0);
        expect(unhandled).not.toHaveBeenCalled();
      });
    });

    describe.each([ "AbortSignal.any", "manual fallback" ])("signal composition via %s", mode => {
      const native = AbortSignal.any;
      beforeEach(() => {
        if (mode !== "AbortSignal.any") Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true, writable: true });
      });
      afterEach(() => {
        Object.defineProperty(AbortSignal, "any", { value: native, configurable: true, writable: true });
      });

      it("caller abort in flight: ERR_CANCELED, native fetch aborted", async () => {
        const { fetch, calls } = fakeFetch();
        const api = client(fetch, { min_rpi: 100, interval: 1000 });
        const controller = new AbortController();
        const a = api.get("/a", { signal: controller.signal });
        await until(() => calls.length === 1);
        controller.abort();
        await expect(a).rejects.toMatchObject({ code: "ERR_CANCELED" });
        expect(calls[0]!.signal.aborted).toBe(true);
      });

      it("queue.abort() while pending or in flight: ERR_CANCELED, native fetch aborted", async () => {
        const { fetch, calls } = fakeFetch();
        const queue = createThrottledQueue({ min_rpi: 100, interval: 1000, concurrency: 1, retry: 0 });
        const api = client(fetch, { queue });
        // A live caller signal, so the item's abort must reach fetch through the composed signal.
        const caller = new AbortController();
        const a = api.get("/a", { signal: caller.signal });
        const b = api.get("/b", { signal: caller.signal });
        await until(() => calls.length === 1);
        queue.abort();
        for (const request of [ a, b ]) {
          const error = await request.catch((e: unknown) => e);
          expect(error).toMatchObject({ code: "ERR_CANCELED" });
          expect(isCancel(error)).toBe(true);
        }
        expect(calls[0]!.signal.aborted).toBe(true);
        expect(calls).toHaveLength(1);
      });

      it("removes its listeners from the caller's signal once the request settles", async () => {
        const { fetch } = fakeFetch(ok);
        const controller = new AbortController();
        const add = vi.spyOn(controller.signal, "addEventListener");
        const remove = vi.spyOn(controller.signal, "removeEventListener");
        await client(fetch, { min_rpi: 100, interval: 1000 }).get("/a", { signal: controller.signal });
        await tick();
        const added = add.mock.calls.map(c => c[1]);
        const removed = new Set(remove.mock.calls.map(c => c[1]));
        expect(added.filter(listener => !removed.has(listener))).toEqual([]);
      });
    });

    it("maps admission failure to ERR_THROTTLE_REJECTED", async () => {
      const { fetch } = fakeFetch(ok);
      const queue = createThrottledQueue({ min_rpi: 1, interval: 1000, retry: 0 });
      queue.abort();
      await expect(client(fetch, { queue }).get("/a")).rejects.toMatchObject({ code: ERR_THROTTLE_REJECTED });
      const full = createThrottledQueue({ min_rpi: 1, interval: 1000, retry: 0, maxQueueSize: 0 });
      const error = await client(fetch, { queue: full }).get("/a")
        .catch((e: unknown) => e as FaxiosError);
      expect(error).toMatchObject({ code: ERR_THROTTLE_REJECTED });
    });

    it("gives the next retry attempt the caller's own signal, not the queue's", async () => {
      const { fetch } = fakeFetch(ok);
      const controller = new AbortController();
      let seen: unknown;
      const api = faxios.create({ baseURL: "https://api.test", env: { fetch } })
        .use(async (ctx, next) => {
          const response = await next(ctx);
          seen = ctx.config.signal;
          return response;
        })
        .use(dynamicThrottle({ min_rpi: 100, interval: 1000 }));
      await api.get("/a", { signal: controller.signal });
      expect(seen).toBe(controller.signal);
    });
  });

  describe("with fake timers", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: [ "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "Date", "performance" ] });
      // Pacing measures from Date.now(); a clock at 0 would hold the first start for one spacing.
      vi.setSystemTime(Date.UTC(2026, 0, 1));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("caps a Retry-After cooldown at 5 minutes on a queue it creates", async () => {
      let n = 0;
      const { fetch, calls } = fakeFetch(() => (n++ === 0 ? status(429, { "retry-after": "86400" }) : ok()));
      const api = client(fetch, { min_rpi: 100, interval: 1000 });
      const a = api.get("/a").catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10);
      expect(await a).toMatchObject({ response: { status: 429 } });
      const b = api.get("/b");
      await vi.advanceTimersByTimeAsync(299_000);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2000);
      expect(calls).toHaveLength(2);
      await expect(b).resolves.toMatchObject({ status: 200 });
    });

    it("rejects the requests of a failed queue with ERR_THROTTLE_REJECTED, caused by the strategy error", async () => {
      const failure = new Error("strategy broke");
      const { fetch, calls } = fakeFetch();
      const queue = createThrottledQueue({ min_rpi: 100, interval: 1000, retry: 0, concurrency: 1, rateStrategy: () => { throw failure; } });
      const api = client(fetch, { queue });
      const inFlight = api.get("/a").catch((e: unknown) => e);
      const queued = api.get("/b").catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10);
      expect(calls).toHaveLength(1);
      // The queue rethrows the strategy error from its timer, as documented for a failed queue.
      expect(() => vi.advanceTimersByTime(1000)).toThrow(failure);
      for (const error of [ await inFlight, await queued ]) {
        expect(error).toMatchObject({ code: ERR_THROTTLE_REJECTED, message: "strategy broke", cause: failure });
      }
      await expect(api.get("/c")).rejects.toMatchObject({ code: ERR_THROTTLE_REJECTED, cause: failure });
    });
  });
});

// Type tests: `pnpm lint` (tsc) checks these calls; the arrows never run.
// A shared queue can't be combined with queue options, and the queue never retries.
declare const sharedQueue: ThrottleHandle;
expectTypeOf(() => dynamicThrottle({ queue: sharedQueue })).toBeFunction();
expectTypeOf(() => dynamicThrottle({ queue: sharedQueue, retryAfterOn503: true })).toBeFunction();
expectTypeOf(() => dynamicThrottle({ min_rpi: 5, interval: 1000, concurrency: 2 })).toBeFunction();
// @ts-expect-error -- queue options can't be combined with a shared queue
expectTypeOf(() => dynamicThrottle({ queue: sharedQueue, min_rpi: 5 })).toBeFunction();
// @ts-expect-error -- a shared queue's classifier is set when it is created
expectTypeOf(() => dynamicThrottle({ queue: sharedQueue, rateOutcomeClassifier: isRateLimited })).toBeFunction();
// @ts-expect-error -- retries belong to faxios's retry plugin
expectTypeOf(() => dynamicThrottle({ min_rpi: 5, interval: 1000, retry: 3 })).toBeFunction();
