import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseRetryAfter } from "../retry-after.ts";

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
    [ "Wed, 32 Oct 2015 07:28:00 GMT", undefined ],
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
