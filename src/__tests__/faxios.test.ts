import faxios, { isCancel } from "@gcmdev/faxios";
import type { FaxiosError } from "@gcmdev/faxios";
import { retry } from "@gcmdev/faxios/plugins/retry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThrottledQueue, linear } from "../dynamic-throttled-queue.ts";
import { dynamicThrottle, ERR_THROTTLE_REJECTED, isRateLimited, parseRetryAfter } from "../faxios.ts";
import type { DynamicThrottleOptions } from "../faxios.ts";

type Call = { url: string; at: number; signal: AbortSignal; respond: (response: Response) => void; };

/** A fake fetch whose responses the test supplies; `auto` answers every call immediately. */
function fakeFetch(auto?: () => Response) {
  const calls: Array<Call> = [];
  const begin = performance.now();
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
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
  it.each([
    [ "120", 120_000 ],
    [ " 2 ", 2000 ],
    [ "Wed, 21 Oct 2015 07:28:05 GMT", 5000 ],
    [ "Wed, 21 Oct 2015 07:27:00 GMT", 0 ],
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
    it.each<[string, (s: Setup) => void]>([
      [ "end", ({ data, source }) => { void drain(data); source.close(); } ],
      [ "read error", ({ data, source }) => { void drain(data).catch(() => {}); source.error(new Error("boom")); } ],
      [ "consumer cancel", ({ data }) => { void data.cancel(); } ],
      [ "caller abort", ({ controller }) => controller.abort() ],
    ])("released on %s, once", async (_name, finish) => {
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
      finish({ data, source, controller, queue });
      // B gets the freed slot; a second release would let a third request start alongside it.
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
    fetch.mockImplementation(async (input: string | URL | Request) => {
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
    async function cooldownAfter(response: () => Response, options: Partial<DynamicThrottleOptions> = {}, config = {}) {
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

    it("applies a cooldown to a resolved 429 when validateStatus is widened", async () => {
      expect(await cooldownAfter(() => status(429, { "retry-after": "2" }), {}, { validateStatus: () => true })).toBeGreaterThan(1900);
    });
  });

  describe("cancellation and errors", () => {
    it("caller abort while queued: ERR_CANCELED, native fetch never runs", async () => {
      const { fetch, calls } = fakeFetch();
      const api = client(fetch, { min_rpi: 100, interval: 1000, concurrency: 1 });
      void api.get("/a").catch(() => {});
      const controller = new AbortController();
      const b = api.get("/b", { signal: controller.signal });
      await until(() => calls.length === 1);
      controller.abort();
      await expect(b).rejects.toMatchObject({ code: "ERR_CANCELED" });
      calls[0]!.respond(ok());
      await tick(30);
      expect(calls).toHaveLength(1);
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
        const a = api.get("/a");
        const b = api.get("/b");
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

    it("does not mutate the caller's config", async () => {
      const { fetch } = fakeFetch(ok);
      const controller = new AbortController();
      const config = { signal: controller.signal };
      await client(fetch, { min_rpi: 100, interval: 1000 }).get("/a", config);
      expect(config).toEqual({ signal: controller.signal });
    });
  });
});
