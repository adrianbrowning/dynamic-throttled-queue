import faxios, { CanceledError, isCancel, VERSION } from "@gcmdev/faxios";
import { retry } from "@gcmdev/faxios/plugins/retry";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, onTestFinished, vi } from "vitest";
import { createThrottledQueue, linear } from "../dynamic-throttled-queue.ts";
import type { ThrottleHandle } from "../dynamic-throttled-queue.ts";
import { dynamicThrottle, ERR_THROTTLE_REJECTED, isRateLimited } from "../faxios.ts";
import type { DynamicThrottleOptions } from "../faxios.ts";

type Call = { url: string; at: number; signal: AbortSignal; respond: (response: Response) => void; };

/** A fake fetch whose responses the test supplies; `auto` answers a call at once unless it returns `undefined`. */
function fakeFetch(auto?: (url: string) => Response | undefined) {
  const calls: Array<Call> = [];
  const begin = performance.now();
  const fetch = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const signal = init?.signal ?? request.signal;
    const { promise, resolve, reject } = Promise.withResolvers<Response>();
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    calls.push({ url: request.url, at: performance.now() - begin, signal, respond: resolve });
    const response = auto?.(request.url);
    if (response) resolve(response);
    return promise;
  });
  return { fetch, calls };
}

function client(fetch: ReturnType<typeof fakeFetch>["fetch"], options: DynamicThrottleOptions) {
  return faxios.create({ baseURL: "https://api.test", env: { fetch } }).use(dynamicThrottle(options));
}

const ok = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
const status = (code: number, headers: Record<string, string> = {}) => new Response("{}", { status: code, headers });
/** The peer range covers faxios 0.2 and 0.3; a few tests pin behaviour that differs between them. */
const faxios02 = VERSION.startsWith("0.2.");

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

async function until(check: () => boolean, waitingFor = "condition") {
  for (let i = 0; i < 200 && !check(); i++) await tick(5);
  expect(check(), `timed out waiting for ${waitingFor}`).toBe(true);
}

/** A queue the test owns; it is aborted when the test ends, so its timers stop. */
function ownQueue(options: Parameters<typeof createThrottledQueue>[0]) {
  const queue = createThrottledQueue(options);
  onTestFinished(() => queue.abort());
  return queue;
}

/** Settles `promise` at once, so a rejection the test awaits later is never reported as unhandled. */
async function settled<T>(promise: Promise<T>): Promise<{ error: unknown; } | { value: T; }> {
  return promise.then(value => ({ value }), (error: unknown) => ({ error }));
}

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

  const rejectsWith = (code: number) => ({ error: { response: { status: code } } });
  const resolvesOk = { value: { status: 200 } };
  it.each<[string, number, Parameters<typeof retry>[0], number, object]>([
    [ "does not retry a 401", 401, {}, 1, rejectsWith(401) ],
    [ "does not retry a 403", 403, {}, 1, rejectsWith(403) ],
    [ "retries a 401 listed in statuses, each attempt in its own slot", 401, { statuses: [ 401 ] }, 2, resolvesOk ],
    [ "retries a 500, each attempt in its own slot", 500, {}, 2, resolvesOk ],
    [ "retries a 502, each attempt in its own slot", 502, {}, 2, resolvesOk ],
    [ "retries a 503, each attempt in its own slot", 503, {}, 2, resolvesOk ],
    [ "retries a 504, each attempt in its own slot", 504, {}, 2, resolvesOk ],
  ])("with retry installed first, faxios %s", async (_name, code, options, expectedCalls, outcome) => {
    let n = 0;
    const { fetch, calls } = fakeFetch(() => (n++ === 0 ? status(code) : ok()));
    const queue = ownQueue({ min_rpi: 100, interval: 1000, retry: 0, rateOutcomeClassifier: isRateLimited });
    const api = faxios.create({ baseURL: "https://api.test", env: { fetch } })
      .use(retry({ respectRetryAfter: false, attempts: 2, delay: 1, ...options }))
      .use(dynamicThrottle({ queue }));
    expect(await settled(api.get("/a"))).toMatchObject(outcome);
    expect(calls).toHaveLength(expectedCalls);
    // Only faxios's retry repeats the request: every attempt is one queue item, and none is retried in the queue.
    expect(queue.getState()).toMatchObject({ started: expectedCalls, retried: 0, cooldowns: 0 });
  });

  /** Answers the requests a test held, in order, so the queue drains and its timers stop. */
  async function answerHeld(calls: Array<Call>, from: number, total: number) {
    for (let i = from; i < total; i++) {
      await until(() => calls.length > i, `request ${i + 1}`);
      calls[i]!.respond(ok());
    }
  }

  it.each([
    [ 429, true ],
    [ 401, false ],
    [ 403, false ],
    [ 400, false ],
    [ 500, false ],
    [ 502, false ],
    [ 503, false ],
    [ 504, false ],
  ])("status %i reduces capacity: %s", async (code, reduces) => {
    // /a answers with `code`; the rest wait, so work stays queued and the queue decides each interval.
    const { fetch, calls } = fakeFetch(url => (url.endsWith("/a") ? status(code) : undefined));
    const rateStrategy = vi.fn(linear);
    const api = client(fetch, { min_rpi: 1, max_rpi: 10, interval: 50, concurrency: 2, rateStrategy });
    const [ a, ...rest ] = [ "/a", "/b", "/c", "/d" ].map(async path => settled(api.get(path)));
    expect(await a).toMatchObject({ error: { response: { status: code } } });
    await until(() => rateStrategy.mock.calls.length > 0, "a rate decision");
    expect(rateStrategy.mock.calls.some(([ observation ]) => observation.errorCount > 0)).toBe(reduces);
    await answerHeld(calls, 1, 4);
    await Promise.all(rest);
  });

  it("does not reduce capacity on cancellation (end to end; the queue ignores cancellations too)", async () => {
    const { fetch, calls } = fakeFetch();
    const rateStrategy = vi.fn(linear);
    const api = client(fetch, { min_rpi: 1, max_rpi: 10, interval: 50, concurrency: 2, rateStrategy });
    const controller = new AbortController();
    const a = settled(api.get("/a", { signal: controller.signal }));
    const rest = [ "/b", "/c", "/d" ].map(async path => settled(api.get(path)));
    await until(() => calls.length === 2, "two requests in flight");
    controller.abort();
    const outcome = await a;
    expect("error" in outcome && isCancel(outcome.error)).toBe(true);
    await until(() => rateStrategy.mock.calls.length > 0, "a rate decision");
    expect(rateStrategy.mock.calls.every(([ observation ]) => observation.errorCount === 0)).toBe(true);
    await answerHeld(calls, 1, 4);
    await Promise.all(rest);
  });

  it("isRateLimited counts only a FaxiosError with a 429 response", () => {
    expect(isRateLimited({ kind: "rejected", error: new CanceledError() })).toBe(false);
    expect(isRateLimited({ kind: "thrown", error: new Error("429") })).toBe(false);
    expect(isRateLimited({ kind: "returned-false" })).toBe(false);
  });

  it("keeps the 429-only classifier when rateOutcomeClassifier is passed as undefined", async () => {
    const { fetch, calls } = fakeFetch(url => (url.endsWith("/a") ? status(401) : undefined));
    const rateStrategy = vi.fn(linear);
    const api = client(fetch, { min_rpi: 1, max_rpi: 10, interval: 50, concurrency: 2, rateStrategy, rateOutcomeClassifier: undefined });
    const [ a, ...rest ] = [ "/a", "/b", "/c", "/d" ].map(async path => settled(api.get(path)));
    await a;
    await until(() => rateStrategy.mock.calls.length > 0, "a rate decision");
    expect(rateStrategy.mock.calls.every(([ observation ]) => observation.errorCount === 0)).toBe(true);
    await answerHeld(calls, 1, 4);
    await Promise.all(rest);
  });

  it("never retries in a queue it creates, even when a JavaScript caller passes retry", async () => {
    const { fetch, calls } = fakeFetch(() => status(500));
    // @ts-expect-error -- retries belong to faxios's retry plugin
    const api = client(fetch, { min_rpi: 100, interval: 1000, retry: 3 });
    await expect(api.get("/a")).rejects.toMatchObject({ response: { status: 500 } });
    await tick(30);
    expect(calls).toHaveLength(1);
  });

  describe("cooldowns", () => {
    async function cooldownAfter(response: () => Response, options: Pick<DynamicThrottleOptions, "cooldownFrom" | "retryAfterOn503"> = {}, config = {}) {
      const { fetch } = fakeFetch(response);
      const queue = ownQueue({ min_rpi: 100, interval: 1000, retry: 0 });
      const api = client(fetch, { queue, ...options });
      await api.get("/a", config).catch(() => {});
      return queue.getState().cooldownRemaining;
    }

    it.each<[string, () => Response, Pick<DynamicThrottleOptions, "retryAfterOn503">, number]>([
      [ "a 429 with delay-seconds", () => status(429, { "retry-after": "2" }), {}, 1900 ],
      [ "a 429 with an HTTP-date", () => status(429, { "retry-after": new Date(Date.now() + 5000).toUTCString() }), {}, 3500 ],
      [ "a 503 when retryAfterOn503 is set", () => status(503, { "retry-after": "2" }), { retryAfterOn503: true }, 1900 ],
    ])("sets a cooldown for %s", async (_name, response, options, atLeast) => {
      expect(await cooldownAfter(response, options)).toBeGreaterThan(atLeast);
    });

    it.each<[string, () => Response, Pick<DynamicThrottleOptions, "retryAfterOn503">]>([
      [ "a past date", () => status(429, { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" }), {}],
      [ "a malformed value", () => status(429, { "retry-after": "soon" }), {}],
      [ "a 503 by default", () => status(503, { "retry-after": "2" }), {}],
      [ "a 500, even with retryAfterOn503", () => status(500, { "retry-after": "2" }), { retryAfterOn503: true }],
    ])("sets no cooldown for %s", async (_name, response, options) => {
      expect(await cooldownAfter(response, options)).toBe(0);
    });

    it("clamps an oversized value to maxCooldown", async () => {
      const { fetch } = fakeFetch(() => status(429, { "retry-after": "999999" }));
      const queue = ownQueue({ min_rpi: 100, interval: 1000, retry: 0, maxCooldown: 3000 });
      await client(fetch, { queue }).get("/a")
        .catch(() => {});
      expect(queue.getState().cooldownRemaining).toBeLessThanOrEqual(3000);
      expect(queue.getState().cooldownRemaining).toBeGreaterThan(2500);
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
      const queue = ownQueue({ min_rpi: 100, interval: 1000, concurrency: 1, retry: 0 });
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
      const queue = ownQueue({ min_rpi: 100, interval: 1000, retry: 0, maxQueueSize: 1 });
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

      // faxios 0.3's types require listener methods, so this input only type-checks as a cast.
      const listenerless = { aborted: false, onabort: null } as unknown as AbortSignal;

      it.runIf(faxios02)("faxios 0.2, without listener methods: the request still runs, with no unhandled rejection", async () => {
        const { fetch } = fakeFetch(ok);
        const api = client(fetch, { min_rpi: 100, interval: 1000 });
        await expect(api.get("/a", { signal: listenerless })).resolves.toMatchObject({ status: 200 });
        await tick(10);
        expect(unhandled).not.toHaveBeenCalled();
      });

      it.runIf(!faxios02)("faxios 0.3, without listener methods: faxios rejects the signal, with no unhandled rejection", async () => {
        const { fetch, calls } = fakeFetch(ok);
        const api = client(fetch, { min_rpi: 100, interval: 1000 });
        await expect(api.get("/a", { signal: listenerless })).rejects.toMatchObject({ code: "ERR_BAD_OPTION_VALUE" });
        await tick(10);
        expect(calls).toHaveLength(0);
        expect(unhandled).not.toHaveBeenCalled();
      });

      it.runIf(faxios02)("faxios 0.2, addEventListener only: an abort still takes a queued request out of the queue", async () => {
        const { fetch, calls } = fakeFetch();
        const queue = ownQueue({ min_rpi: 100, interval: 1000, concurrency: 1, retry: 0 });
        const api = client(fetch, { queue });
        void api.get("/a").catch(() => {});
        await until(() => calls.length === 1);
        const listeners: Array<unknown> = [];
        // faxios 0.3's types require removeEventListener too, so this input only type-checks as a cast.
        const signal = { aborted: false, addEventListener: (_type: unknown, listener: unknown) => { listeners.push(listener); } } as unknown as AbortSignal;
        const b = settled(api.get("/b", { signal }));
        await tick(10);
        Object.assign(signal, { aborted: true });
        for (const listener of listeners) if (typeof listener === "function") listener();
        expect(await b).toMatchObject({ error: { code: "ERR_CANCELED" } });
        expect(queue.getState().pending).toBe(0);
        calls[0]!.respond(ok());
        await tick(30);
        expect(calls).toHaveLength(1);
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

    describe("caller and queue aborts", () => {
      it("caller abort in flight: ERR_CANCELED, native fetch aborted", async () => {
        const { fetch, calls } = fakeFetch();
        const api = client(fetch, { min_rpi: 100, interval: 1000 });
        const controller = new AbortController();
        const a = settled(api.get("/a", { signal: controller.signal }));
        await until(() => calls.length === 1, "A to start");
        controller.abort();
        expect(await a).toMatchObject({ error: { code: "ERR_CANCELED" } });
        expect(calls[0]!.signal.aborted).toBe(true);
      });

      it("timeout in flight: ETIMEDOUT, native fetch aborted, slot freed", async () => {
        const { fetch, calls } = fakeFetch();
        const queue = ownQueue({ min_rpi: 100, interval: 1000, concurrency: 1, retry: 0 });
        const api = client(fetch, { queue });
        const a = settled(api.get("/a", { timeout: 50 }));
        await until(() => calls.length === 1, "A to start");
        expect(await a).toMatchObject({ error: { code: "ETIMEDOUT" } });
        expect(calls[0]!.signal.aborted).toBe(true);
        await until(() => queue.getState().active === 0, "the slot to be freed");
      });

      it("timeout while a delivered stream is read: the read rejects with ETIMEDOUT, native fetch aborted, slot freed", async () => {
        const { fetch, calls } = fakeFetch();
        const queue = ownQueue({ min_rpi: 100, interval: 1000, concurrency: 1, retry: 0 });
        const api = client(fetch, { queue });
        const a = api.get<ReadableStream>("/a", { responseType: "stream", timeout: 80 });
        await until(() => calls.length === 1, "A to start");
        const { signal } = calls[0]!;
        // Like a real fetch body: it errors when the request's signal aborts.
        calls[0]!.respond(new Response(new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array([ 1 ]));
            signal.addEventListener("abort", () => c.error(signal.reason), { once: true });
          },
        })));
        const reader = (await a).data.getReader();
        await reader.read();
        expect(await settled(reader.read())).toMatchObject({ error: { code: "ETIMEDOUT" } });
        expect(signal.aborted).toBe(true);
        await until(() => queue.getState().active === 0, "the slot to be freed");
      });

      it("queue.abort() while pending or in flight: ERR_CANCELED, native fetch aborted", async () => {
        const { fetch, calls } = fakeFetch();
        const queue = ownQueue({ min_rpi: 100, interval: 1000, concurrency: 1, retry: 0 });
        const api = client(fetch, { queue });
        // A live caller signal too: the queue's abort, not the caller's, must reach fetch.
        const caller = new AbortController();
        const a = settled(api.get("/a", { signal: caller.signal }));
        const b = settled(api.get("/b", { signal: caller.signal }));
        await until(() => calls.length === 1, "A to start");
        queue.abort();
        for (const outcome of [ await a, await b ]) {
          expect(outcome).toMatchObject({ error: { code: "ERR_CANCELED" } });
          expect("error" in outcome && isCancel(outcome.error)).toBe(true);
        }
        expect(calls[0]!.signal.aborted).toBe(true);
        expect(calls).toHaveLength(1);
      });

      it("a queue abort between next() and the stream wrapper: ERR_CANCELED, and the slot is still freed", async () => {
        const { fetch, calls } = fakeFetch(() => new Response(new ReadableStream<Uint8Array>()));
        const queue = ownQueue({ min_rpi: 100, interval: 1000, concurrency: 1, retry: 0 });
        const api = faxios.create({ baseURL: "https://api.test", env: { fetch } })
          .use(dynamicThrottle({ queue }))
          .use(async (ctx, next) => {
            const response = await next(ctx);
            queue.abort();
            return response;
          });
        expect(await settled(api.get("/a", { responseType: "stream" }))).toMatchObject({ error: { code: "ERR_CANCELED" } });
        // The active item settles only once the wrapper sees the already-aborted signal and releases it.
        await until(() => queue.getState().active === 0, "the slot to be freed");
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

    it("maps admission failure to ERR_THROTTLE_REJECTED, keeping the queue's reason", async () => {
      const { fetch } = fakeFetch(ok);
      const aborted = ownQueue({ min_rpi: 1, interval: 1000, retry: 0 });
      aborted.abort();
      await expect(client(fetch, { queue: aborted }).get("/a")).rejects.toMatchObject({ code: ERR_THROTTLE_REJECTED, message: expect.stringMatching(/aborted/) });
      const full = ownQueue({ min_rpi: 1, interval: 1000, retry: 0, maxQueueSize: 0 });
      await expect(client(fetch, { queue: full }).get("/a")).rejects.toMatchObject({ code: ERR_THROTTLE_REJECTED, message: expect.stringMatching(/maxQueueSize/) });
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

    describe("timeout of a request that waits in the queue", () => {
      /** B (with `timeout: 50`) waits 80 ms behind A, which holds the only slot. */
      async function queuedBehindA() {
        const { fetch, calls } = fakeFetch();
        const queue = ownQueue({ min_rpi: 100, interval: 1000, concurrency: 1, retry: 0 });
        const api = client(fetch, { queue });
        const a = api.get("/a");
        await until(() => calls.length === 1, "A to start");
        // Settled at once: on faxios 0.3, B rejects before the test reads it.
        const b = settled(api.get("/b", { timeout: 50 }));
        await tick(80);
        calls[0]!.respond(ok());
        await a;
        return { b, calls, queue };
      }

      it.runIf(!faxios02)("faxios 0.3: queue time counts, so B times out, leaves the queue and is never sent", async () => {
        const { b, calls, queue } = await queuedBehindA();
        expect(await b).toMatchObject({ error: { code: "ETIMEDOUT" } });
        await tick(30);
        expect(calls).toHaveLength(1);
        expect(queue.getState().pending).toBe(0);
      });

      it.runIf(faxios02)("faxios 0.2: queue time does not count, so B is sent after A and succeeds", async () => {
        const { b, calls } = await queuedBehindA();
        await until(() => calls.length === 2, "B to start");
        calls[1]!.respond(ok());
        expect(await b).toMatchObject({ value: { status: 200 } });
      });
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

    it.each<[string, Pick<DynamicThrottleOptions, "maxCooldown">]>([
      [ "by default", {}],
      [ "when maxCooldown is passed as undefined", { maxCooldown: undefined }],
    ])("caps a Retry-After cooldown at 5 minutes on a queue it creates, %s", async (_name, options) => {
      let n = 0;
      const { fetch, calls } = fakeFetch(() => (n++ === 0 ? status(429, { "retry-after": "86400" }) : ok()));
      const api = client(fetch, { min_rpi: 100, interval: 1000, ...options });
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
