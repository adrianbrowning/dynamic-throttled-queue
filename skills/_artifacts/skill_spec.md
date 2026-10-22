# dynamic-throttled-queue — Skill Spec

`dynamic-throttled-queue` paces arbitrary callbacks between a minimum and
maximum number of starts per interval and adapts the rate to failures. It is
used mainly to call rate-limited HTTP APIs.

## Domains

| Domain | Description | Skills |
| --- | --- | --- |
| throttled-queue | Pacing starts, bounding in-flight work, adapting to failures, retrying, and lifecycle control | configure-throttled-queue |

## Skill Inventory

| Skill | Type | Domain | What it covers | Failure modes |
| --- | --- | --- | --- | --- |
| configure-throttled-queue | core | throttled-queue | Options, concurrency, adaptive outcomes, rate strategies, retries, cooldowns, task handles, lifecycle, state, faxios plugin | 10 |

## Failure Mode Inventory

### configure-throttled-queue (10 failure modes)

| # | Mistake | Priority | Source | Cross-skill? |
| --- | --- | --- | --- | --- |
| 1 | Ignoring the abort signal in callbacks | CRITICAL | README Lifecycle; src/scheduler.ts | — |
| 2 | Using the start rate as an in-flight limit | HIGH | ThrottleOptions.concurrency | — |
| 3 | Returning false from submit() to signal failure | HIGH | TaskCallback; task-handles tests | — |
| 4 | Expecting retry classification or cooldowns to change the rate | HIGH | README Failure classification, cooldown | — |
| 5 | Leaving cancelled task results unhandled | HIGH | README Task handles | — |
| 6 | Treating stop() as shutdown | MEDIUM | README Lifecycle | — |
| 7 | Expecting maxQueueSize overflow to return a value | MEDIUM | src/pending-work.ts | — |
| 8 | Returning malformed decisions from a custom rateStrategy | MEDIUM | src/adaptive-rate.ts | — |
| 9 | Starting a promise without returning or awaiting it | CRITICAL | README Queuing work | — |
| 10 | Installing the faxios plugin before `retry`, or giving its queue retries | HIGH | src/faxios.ts; README faxios plugin | — |

## Tensions

| Tension | Skills | Agent implication |
| --- | --- | --- |
| Faster recovery versus provider limits | configure-throttled-queue | `max_rpi` above the provider ceiling causes repeated 429s |

## Subsystems & Reference Candidates

| Skill | Subsystems | Reference candidates |
| --- | --- | --- |
| configure-throttled-queue | faxios plugin (`dynamic-throttled-queue/faxios`) | rate-strategies.md, retries.md, lifecycle.md, state-and-idle.md, faxios.md |

## Remaining Gaps

| Skill | Question | Status |
| --- | --- | --- |
| configure-throttled-queue | Separate v1 migration skill? | open |
| configure-throttled-queue | Separate v2 → v3 migration skill? | open |

## Recommended Skill File Structure

- **Core skills:** configure-throttled-queue
- **Framework skills:** none (framework-agnostic library)
- **Lifecycle skills:** none yet; v1 and v2 migration are open gaps
- **Composition skills:** none
- **Reference files:** configure-throttled-queue/references/{rate-strategies,retries,lifecycle,state-and-idle,faxios}.md

## Coverage and batch history

### Batch 1 — 2026-10-04, unreleased major after v2.2.0 (issue #79)

- **Assessed scope:** the full public API in `src/dynamic-throttled-queue.ts`
  and `src/scheduler.ts` types, `src/adaptive-rate.ts`, `src/retry-policy.ts`,
  `src/pending-work.ts`, the README, and the unit tests, at commit `6651dc1`
  (includes #77 task handles, #78 server-directed cooldowns, and #80: the
  `pending` property removed, `RateFailureOutcome` renamed to `FailureOutcome`,
  fire-and-forget callbacks may return any value). The guidance targets the
  3.0.0 release.
- **Decision: one skill with conditional references.** The maintainer chose one
  entry-point skill; dense detail (strategies, retry formulas, lifecycle table,
  state fields) lives in `references/` with reading conditions.
- **Decision: package-only distribution** (`distribution.mode: none`). Skills
  ship in the npm tarball and version with the library; no repository or plugin
  exports.
- **Decision: review ignores.** `CHANGELOG.md`, `.bumpy/**`, `.github/**`,
  `.husky/**`, `.idea/**`, `.abide/**`, `docs/agents/**`, and tool configs carry no library
  guidance and are excluded from unmapped-change review so release and
  dependency PRs do not require skill reviews.
- **Checks (at `6651dc1` plus this batch):** `intent validate` passes; all 11
  TypeScript examples in the skill and references type-check under `--strict`
  against the freshly built package; the task check in
  `tests/skills/configure-throttled-queue/` accepts the reference solution and
  rejects one that omits `concurrency`.
- **Fresh consumer (before #80 was rebased in):** one isolated agent run in a
  disposable npm project, with the packed tarball installed using
  `npm install --ignore-scripts`, found the skill via `intent list`, loaded
  SKILL.md plus `references/lifecycle.md` and `references/retries.md`, and
  produced a solution that passes the task check's acceptance assertions.
  One run only, not repeated after the #80 rebase; no reliability claim.
  Discovery against adjacent should-not-load prompts was not evaluated.
- **Found during packing:** the published `package.json` carries
  `"preinstall": "only-allow pnpm"`, so `npm install dynamic-throttled-queue`
  fails for consumers unless `--ignore-scripts` is used. Pre-existing in 2.2.0;
  not fixed in this batch.
- **Remaining work:** the open gaps above.

### Pre-release review — 2026-10-06, 3.0.0 (PR #60)

- **Decision: `library_version` is 3.0.0 before release.** Batch 1 kept it at
  the `package.json` version until bumpy released, but bumpy's version PR
  bumps only `package.json` and `CHANGELOG.md`. The tarball would have shipped
  3.0.0 guidance labelled 2.2.0, so the skill and all three planning records
  now say 3.0.0.
- **Change reviewed:** two idle-timer fixes in `src/adaptive-rate.ts` and
  `src/scheduler.ts`. Canceling the last queued item while every slot was busy
  left the interval tick running, and `cooldownFor()` armed its timer with
  nothing queued. The skill makes no claim about either timer, so its guidance
  text is unchanged. The README gains a fuller "From v2" migration list.
- **Packing:** the `preinstall` gap above is fixed in this review. Plain
  `npm install` of the packed tarball now succeeds.
- **Decision: fixture source glob is `tests/skills/configure-throttled-queue*/*`.**
  The `Validate intent skills` CI job failed on #60 and #83 with the three task
  fixtures pending review. A diagnostic job showed why: on GitHub's git 2.55,
  `git ls-files -- ':(top,glob)tests/skills/configure-throttled-queue/*'
  ':(top,exclude,glob)**/node_modules/**'` lists nothing, so Intent hashed
  the fixtures as missing. Local git 2.39 drops them the same way. In a scratch
  repository the files vanish whenever the literal directory prefix is 16, 17
  or 19+ characters long. The new glob's literal prefix is `tests/skills/`
  (13 characters) and matches the same three files.

### faxios plugin — 2026-10-09, unreleased (issue #82)

- **Change reviewed:** new subpath `dynamic-throttled-queue/faxios`
  (`src/faxios.ts`, `src/__tests__/faxios.test.ts`, README "faxios plugin").
- **Decision: extend `configure-throttled-queue`, no new skill.** Throttling a
  faxios client is the same task (pace a rate-limited API) with a different
  entry point. The skill gains `references/faxios.md` and a pointer in Setup
  that says when to read it. The description names the task once. Purpose is
  unchanged.
- **Coverage:** install order after `retry({ respectRetryAfter: false })`, the
  `{ queue }` form (`retry: 0`, `rateOutcomeClassifier: isRateLimited`),
  stream slot hold, timeout start at dispatch, `Retry-After` parsing,
  `retryAfterOn503`, `cooldownFrom`, `ERR_CANCELED`, `ERR_THROTTLE_REJECTED`.
  `sources` (`src/*.ts`) already covers `src/faxios.ts`.
- **Task check:** `tests/skills/configure-throttled-queue-faxios/` (matched by
  the existing fixture glob). The reference solution passes. A throttle
  installed before `retry` and a shared queue with `retry: 2` both fail the
  grader.
- **Not verified:** fresh consumer session and discovery prompts.

### faxios 0.2.4 check — 2026-10-16, unreleased (issue #82)

- **Change reviewed:** the plugin against published `@gcmdev/faxios` 0.2.4
  (and 0.2.0) instead of the local `link:` build. Types, unit tests and task
  checks pass on both with no plugin change.
- **Decision: peer range `^0.2.0`, not `>=0.2.0`.** The faxios 0.3.0 changelog
  (not tested here; 0.3.0 is unpublished) makes `timeout` cover middleware, so
  queue time would count against it, and the README and reference say it does not.
- **Behavior change:** `parseRetryAfter` accepts RFC 850 and asctime dates as
  well as IMF-fixdate (RFC 9110 §5.6.7), the same forms faxios 0.2.4 `retry`
  accepts. Before, those headers set no cooldown, and the required
  `respectRetryAfter: false` meant nothing honoured them. The reference's
  `Retry-After` bullet and install note are updated; the task check is
  unchanged because it uses delay-seconds.
- **Remaining work:** re-check the plugin when faxios 0.3.0 publishes (done; see
  "faxios 0.3.0 support").

### PR #89 review fixes — 2026-10-16, unreleased (issue #82)

- **Change reviewed:** the Critical and High findings of the PR #89 review.
  `src/faxios.ts` now: handles signal-like caller signals without listener
  methods (they used to crash Node with an unhandled rejection); queues nothing
  when the caller aborted during earlier async middleware; makes the options
  union exclusive, so `{ queue, ...queueOptions }` is a type error; falls back
  to `Retry-After` when `cooldownFrom` returns an invalid number or throws;
  defaults `maxCooldown` to 300 000 ms on a queue it creates; and rejects the
  requests of a failed queue with `ERR_THROTTLE_REJECTED` (cause: the strategy
  error) instead of a raw `Error`.
- **Decision: a throwing `cooldownFrom` falls back to `Retry-After`.** The other
  option, rethrowing, replaced the request's `FaxiosError` (so `retry` stopped)
  and left a stream body open.
- **Decision: 5-minute default `maxCooldown`.** It matches faxios `retry`'s
  `maxRetryAfter`, which the required `respectRetryAfter: false` turns off.
  A shared `{ queue }` sets its own; the reference says so.
- **Guidance updated:** `references/faxios.md` (npm `ERESOLVE` note, exclusive
  forms, shared-queue `maxCooldown`, cooldown scope and fallback rules, a
  `cooldownFrom` example that returns `undefined` unless the window is used
  up, a stream example that compiles, the failed-queue row in the errors
  table) and the SKILL.md HIGH mistake (shared queue needs `maxCooldown`).
- **Task check:** `check.test.ts` now also grades starts per second, requests in
  flight and the 429-only classifier on fake timers. New mistake factories
  without `concurrency` and without `isRateLimited` fail the grader.
- **Not verified:** fresh consumer session and discovery prompts.

### faxios 0.3.0 support — 2026-10-16, unreleased (issue #82)

- **Change reviewed:** the plugin on published `@gcmdev/faxios` 0.3.0. Only one
  source change was needed: `onAbortOf` watches a signal when it has
  `addEventListener` (a type guard) and removes its listener only if the signal
  has `removeEventListener`, because 0.3 types both as required
  `(type: "abort", listener) => unknown` and 0.2 as optional. `pnpm lint` and
  the suite pass on 0.3.0, 0.2.4 and 0.2.0.
- **Behavior difference (faxios's, not the plugin's):** on 0.3, `timeout` covers
  the whole request, including time in the queue. A request that times out
  while queued rejects with `ETIMEDOUT`, leaves the queue and is never sent.
  0.3 also rejects a signal without listener methods before middleware runs.
  Each line has its own fixed-expectation tests, run only on that line
  (`it.runIf` on `VERSION`).
- **Decision: peer range `^0.2.0 || ^0.3.0`; dev dependency 0.3.0.** CI now
  tests 0.3.0; 0.2.x was checked locally only.
- **Decision: `@gcmdev/faxios` joins `minimumReleaseAgeExclude`** in
  `pnpm-workspace.yaml` (maintainer's choice, as for `@gingacodemonkey/config`),
  so the dev dependency can follow faxios releases the day they publish.
- **Guidance updated:** `references/faxios.md` (version support, a timeout
  section for each faxios line, `attemptTimeout` includes queue wait). Task
  check unchanged; it passes on 0.3.0.

### PR #89 review observations — 2026-10-16, unreleased (issue #82)

- **Change reviewed:** the 15 Observations of the PR #89 review.
  - `src/faxios.ts`: `linkSignals` is removed, so `next()` gets the queue item's
    signal; the caller's abort (including faxios 0.3's deadline) cancels the item
    with the caller signal's own reason. A first version cancelled with a
    `CanceledError`, so on faxios 0.3 a delivered stream that timed out errored
    with `ERR_CANCELED` instead of `ETIMEDOUT`; a regression test now pins
    `ETIMEDOUT` on both faxios lines.
  - The plugin is named `dynamicThrottle`, as faxios names its plugins.
  - An explicit `undefined` no longer turns off the default classifier or
    `maxCooldown`.
  - The stream wrapper reads only when the consumer reads (`highWaterMark: 0`).
- **Decision: `parseRetryAfter` is internal** (`src/retry-after.ts`, not a
  package export), so the unreleased plugin does not make the parser a semver
  contract. The reference no longer mentions it, and its source names faxios's
  own parser.
- **Guidance updated:** `references/faxios.md` and SKILL.md say `retry` is
  optional, and SKILL.md says the plugin creates the queue unless you pass
  `{ queue }`. The reference adds the 503 `Retry-After` caveat, the
  rejected-stream caveat and the delivered-stream `AbortError` row, and drops
  the version list that would go stale. `task.md` names faxios `retry`'s
  default statuses.
- **Task check:** a 15 s timeout (each grading run takes about 3 s), and a note
  that the fixture keeps its own helpers on purpose.
- **CI:** a `faxios 0.2.0` / `faxios 0.2.4` matrix job runs the type check, the
  plugin tests and the task check, so the 0.2-only tests also run in CI.
  Dependabot ignores faxios minor and major updates.
- **#93 (first-start wait):** see the entry below.

### Release fixes — 2026-10-22, unreleased (issue #82)

- **Change reviewed:** `src/faxios.ts` maps a caller abort to `CanceledError`
  for middleware before the plugin. The `ERR_THROTTLE_REJECTED` JSDoc covers a
  queue that fails while a request is queued or in flight. The plugin tests add
  401/403/5xx retry rows, 5xx capacity rows, tighter `cooldownFrom` priority
  rows with upper bounds, and test-owned queues.
- **Decision on #93: keep the first-start wait and document it.** Starting
  the first item at once changes the timing of existing users, so it would be
  a breaking change, and this release is a minor. The README (pacing example,
  burst example, cooldown scheduling, faxios Timeout bullet) and
  `references/faxios.md` §6 now say that a new or idle queue starts its first
  item one spacing after work arrives (a full `interval` with
  `evenly_spaced: false`), and that on faxios 0.3 this wait counts against
  `timeout`. A queue test pins the wait for a fresh and a drained, idle queue.
- **Guidance updated:** `references/faxios.md` §6 (timeout). SKILL.md needs no
  edit: it sends faxios readers to `references/faxios.md` first (line 51-52).
- **Not verified:** fresh consumer session and discovery prompts.
