// Internal to the faxios plugin; not a package export. It follows faxios's own (private) parser,
// `retryAfterMs` and `HTTP_DATE` in @gcmdev/faxios `src/lib/plugins/retry.ts` (0.2.4 and later).

const delaySeconds = /^\d+$/;
// The three HTTP-date forms RFC 9110 §5.6.7 says recipients must accept: IMF-fixdate
// (`Wed, 21 Oct 2015 07:28:00 GMT`), RFC 850 (`Wednesday, 21-Oct-15 07:28:00 GMT`) and asctime
// (`Wed Oct 21 07:28:00 2015`). Date.parse alone takes far more, such as `1.5` or `10/21/2015`.
const day = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const longDay = "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)";
const month = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const time = String.raw`\d{2}:\d{2}:\d{2}`;
const httpDate = new RegExp(
  String.raw`^(?:${day}, \d{2} ${month} \d{4} ${time} GMT`
  + String.raw`|${longDay}, \d{2}-${month}-\d{2} ${time} GMT`
  + String.raw`|${day} ${month} [ \d]\d ${time} \d{4})$`
);

/** Milliseconds to wait from a `Retry-After` value, or `undefined` when it is missing or malformed. A past date is 0. */
export function parseRetryAfter(value: unknown, now = Date.now()): number | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  // Huge values stay finite here; the queue clamps them to its maxCooldown.
  if (delaySeconds.test(trimmed)) return Math.min(Number(trimmed) * 1000, Number.MAX_SAFE_INTEGER);
  if (!httpDate.test(trimmed)) return undefined;
  // asctime has no zone; RFC 9110 says it is UTC, but Date.parse would read it as local time.
  const date = Date.parse(trimmed.endsWith(" GMT") ? trimmed : `${trimmed} GMT`);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
