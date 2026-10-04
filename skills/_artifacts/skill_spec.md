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
| configure-throttled-queue | core | throttled-queue | Options, concurrency, adaptive outcomes, rate strategies, retries, cooldowns, task handles, lifecycle, state | 9 |

## Failure Mode Inventory

### configure-throttled-queue (9 failure modes)

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

## Tensions

| Tension | Skills | Agent implication |
| --- | --- | --- |
| Faster recovery versus provider limits | configure-throttled-queue | `max_rpi` above the provider ceiling causes repeated 429s |

## Subsystems & Reference Candidates

| Skill | Subsystems | Reference candidates |
| --- | --- | --- |
| configure-throttled-queue | — | rate-strategies.md, retries.md, lifecycle.md, state-and-idle.md |

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
- **Reference files:** configure-throttled-queue/references/{rate-strategies,retries,lifecycle,state-and-idle}.md

## Coverage and batch history

### Batch 1 — 2026-10-04, unreleased major after v2.2.0 (issue #79)

- **Assessed scope:** the full public API in `src/dynamic-throttled-queue.ts`
  and `src/scheduler.ts` types, `src/adaptive-rate.ts`, `src/retry-policy.ts`,
  `src/pending-work.ts`, the README, and the unit tests, at commit `6651dc1`
  (includes #77 task handles, #78 server-directed cooldowns, and #80: the
  `pending` property removed, `RateFailureOutcome` renamed to `FailureOutcome`,
  fire-and-forget callbacks may return any value). The guidance targets the
  next major release; `metadata.library_version` stays at the current
  `package.json` version until bumpy releases it.
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
