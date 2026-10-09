import { isCancel } from "@gcmdev/faxios";
import { describe, expect, it, vi } from "vitest";
import { ERR_THROTTLE_REJECTED } from "../../../src/faxios.ts";
import { createApi, createApiThrottleBeforeRetry, createApiWithQueueRetries } from "./solution.ts";

type Factory = typeof createApi;
type Call = { path: string; at: number; respond: (response: Response) => void; };

/** A fake fetch that answers each path from a script of statuses; `hold` paths wait for the test. */
function fakeFetch(script: Record<string, Array<number | [number, Record<string, string>]>>, hold: Array<string> = []) {
  const calls: Array<Call> = [];
  const begin = performance.now();
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const signal = init?.signal ?? request.signal;
    const path = new URL(request.url).pathname;
    const { promise, resolve, reject } = Promise.withResolvers<Response>();
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    calls.push({ path, at: performance.now() - begin, respond: resolve });
    const next = script[path]?.shift() ?? 200;
    const [ status, headers ] = Array.isArray(next) ? next : [ next, {} ];
    if (!hold.includes(path)) resolve(new Response("{}", { status, headers: { "content-type": "application/json", ...headers } }));
    return promise;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

// Real timers on purpose: faxios's fetch adapter runs end to end, and the queue paces with
// performance.now(), which fake timers would not drive the same way as the plugin's own tests.
async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
  expect(check()).toBe(true);
}

async function assertTaskBehavior(factory: Factory) {
  // A request waiting to retry does not hold the only slot.
  const backoff = fakeFetch({ "/a": [ 500 ] }, [ "/b" ]);
  const { api: backoffApi } = factory(backoff.fetch);
  const a = backoffApi.get("/a");
  const b = backoffApi.get("/b");
  await until(() => backoff.calls.length >= 2);
  expect(backoff.calls.map(call => call.path).slice(0, 2)).toEqual([ "/a", "/b" ]);
  backoff.calls[1]!.respond(new Response("{}", { status: 200 }));
  await expect(Promise.all([ a, b ])).resolves.toHaveLength(2);

  // Persistent 5xx: exactly 1 + 2 retries.
  const failing = fakeFetch({ "/x": [ 503, 503, 503 ] });
  await expect(factory(failing.fetch).api.get("/x")).rejects.toMatchObject({ response: { status: 503 } });
  expect(failing.calls).toHaveLength(3);

  // Retry-After is honoured.
  const limited = fakeFetch({ "/r": [ [ 429, { "retry-after": "1" } ] ] });
  await expect(factory(limited.fetch).api.get("/r")).resolves.toMatchObject({ status: 200 });
  expect(limited.calls).toHaveLength(2);
  expect(limited.calls[1]!.at - limited.calls[0]!.at).toBeGreaterThanOrEqual(900);

  // Other 4xx: no retry.
  const denied = fakeFetch({ "/d": [ 401 ] });
  await expect(factory(denied.fetch).api.get("/d")).rejects.toMatchObject({ response: { status: 401 } });
  expect(denied.calls).toHaveLength(1);

  // Shutdown: in-flight aborts, queued never sent, later requests rejected.
  const slow = fakeFetch({}, [ "/s", "/q" ]);
  const { api, shutdown } = factory(slow.fetch);
  const inFlight = api.get("/s").catch((error: unknown) => error);
  const queued = api.get("/q").catch((error: unknown) => error);
  await until(() => slow.calls.length === 1);
  shutdown();
  expect(isCancel(await inFlight)).toBe(true);
  expect(isCancel(await queued)).toBe(true);
  await expect(api.get("/later")).rejects.toMatchObject({ code: ERR_THROTTLE_REJECTED });
  expect(slow.calls.map(call => call.path)).toEqual([ "/s" ]);
}

describe("configure-throttled-queue faxios task check", () => {
  it("accepts the reference solution", async () => {
    await assertTaskBehavior(createApi);
  });

  it("rejects a throttle installed before retry", async () => {
    await expect(assertTaskBehavior(createApiThrottleBeforeRetry)).rejects.toThrow(/\[ '\/a', '\/a' \] to deeply equal/);
  });

  it("rejects a shared queue that also retries", async () => {
    // The queue retries the 503s itself, so the 5xx request succeeds instead of failing after 3 tries.
    await expect(assertTaskBehavior(createApiWithQueueRetries)).rejects.toThrow(/resolved .* instead of rejecting/);
  });
});
