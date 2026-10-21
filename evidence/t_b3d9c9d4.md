# t_b3d9c9d4 — B-08 delivery and acceptance mapping

Task: B-08 Attempt-row-before-call + retry/backoff + queue topology + reconciler
(US-013, US-031). Lead plan §4.

- Branch: `feat/t_b3d9c9d4`
- Base: `e793838` (B-02 head = B-01 + B-02), plus merge commits `ada6a4d` (B-03 `d4bd6d4`)
  and `b83f690` (B-07 `9b54af2`). Those two are hard prerequisites whose code this task
  compiles and runs against (state machine/retry scope, and the deterministic TTS fake with
  its scripted failure series). B-04/B-05/B-06 were not merged; their error vocabularies are
  supported structurally (see D5).
- Implementation commit: `1d72a16`
- Evidence commit: the commit that adds this file (see `git log feat/t_b3d9c9d4`).
- Developed in an isolated worktree `/opt/data/engineering-team/projects/reels-generator/.worktrees/t_b3d9c9d4`;
  the shared tree was left untouched.

## Files changed

New:

- `src/workers/attempt.ts` — attempt lifecycle, classification, retry ladder, unknown-charge guard
- `src/workers/queues.ts` — BullMQ topology, priorities, retry budget, backoff hook, enqueue port
- `src/workers/reconciler.ts` — startup resume/unknown-charge reconciliation
- `src/db/repositories/jobs.ts` — job status, retry scope, stalled-job scan
- `src/workers/attempt.test.ts` (7 tests), `src/workers/reconciler.test.ts` (7),
  `src/workers/queues.test.ts` (11), `src/workers/failure-classification.test.ts` (11)

Appended (B-02-owned files, no existing behaviour changed):

- `src/db/repositories/job-attempts.ts` — mark running, heartbeat, finish, list open/by job
- `src/db/repositories/generation-runs.ts` — mark started, finish with charge, pending-by-job, unknown charge
- `src/db/repositories/types.ts` — `JobRow`, `StalledJobRow`
- `package.json` / `package-lock.json` — `bullmq ^6.3.19`, `ioredis ^6.0.0`

## Commands run (real output)

```
TEST_DATABASE_URL=postgres://reels@127.0.0.1:55432/reels_test npm run test
  Test Files  22 passed (22)
  Tests       218 passed (218)
  Duration    165.53s

npm run test                      (no database)
  Test Files  16 passed | 6 skipped (22)
  Tests       174 passed | 44 skipped (218)
  Duration    10.33s

npm run lint                      PASS (eslint, 0 problems)
npm run typecheck                 PASS (tsc -p tsconfig.json)
npm run build                     PASS (tsc -p tsconfig.build.json)
prettier --check src/workers src/db/repositories   All matched files use Prettier code style!

git log --all -- .env             0 lines
```

Test database: PostgreSQL 16.14 server (`current_setting('server_version')`), migrations
M-001…M-005 applied by the suite via `runMigrations`. Host Node v26.5.1 (engines pin 20.x),
npm 11.17.0. No Redis server and no Docker daemon on this host.

Per-file results with a database:

- `src/workers/attempt.test.ts` — 7/7 PASS (85.3 s)
  1. commits the attempt row before the call, then bills a success
  2. fake 503 series → exactly 3 attempts at 1 s / 4 s, then failed with unknown charge
  3. 401 fails fast: one attempt, no requeue, unbilled
  4. 429 is transient but unbilled, then the retry succeeds
  5. a timeout is unknown charge, never unbilled (R-012-4)
  6. never reissues a pending run left by a dead process
  7. heartbeats the lease while the attempt is open and stops once it closes
- `src/workers/reconciler.test.ts` — 7/7 PASS (52.7 s)
  1. forced-kill mid-call: marks the run unknown charge, fails the job, enqueues nothing
  2. resumes a stale job with no in-flight call exactly once, at the next attempt
  3. leaves a job alone while its heartbeat is live
  4. fails a job whose three attempts are exhausted instead of re-running it
  5. stores the retry scope on the row before enqueueing (R-022-2)
  6. never enqueues the FA operator gate
  7. uses a 60 s lease by default
- `src/workers/queues.test.ts` — 11/11 PASS (no Redis needed; policy only)
- `src/workers/failure-classification.test.ts` — 11/11 PASS

## Signal evidence (quoted from the tests)

1. **fake 503 series → exactly 3 attempts then failed.**
   `FakeTtsAdapter({failures:[503,503,503]})` through `runAttemptSequence` with an injected
   sleep: `adapter.calls` = 3, outcomes attemptNo `[1,2,3]`, recorded waits `[1000, 4000]`,
   final `errorClass='transient'`, `requeue=false`. Database: `job_attempt` rows
   `attempt_no [1,2,3]` all `unknown_charge`, `backoff_s [1,4,16]`, `error_class='transient'`,
   `http_status=503`; three `generation_run` rows (one per provider call) all `failed` with
   `charge_status='unknown'`; `job.status='failed'`.

2. **401 fails fast with no requeue.**
   `FakeTtsAdapter({failures:[401,503,503]})`: `adapter.calls` = 1, zero waits,
   `errorClass='non_retryable'`, `requeue=false`, charge `unbilled`; one `job_attempt`
   (`status='failed'`, `http_status=401`, `backoff_s=NULL`), one run `failed`/`unbilled`,
   `job.status='failed'`. `workerFailureFromOutcome` maps it to BullMQ's `UnrecoverableError`
   (unit-tested), so a real Worker would not requeue it either.

3. **forced-kill resume never auto-reissues a pending run.**
   `attempt.test.ts` #6: a committed `pending` run is left by a "killed" worker; the next
   `runProviderAttempt` reaches the adapter **0** times, returns `runId=null`, charge
   `unknown`, and the run is rewritten to `status='unknown'`, `charge_status='unknown'`, its
   attempt to `unknown_charge`, the job to `failed`.
   `reconciler.test.ts` #1: same residue, reconciler run ⇒ `scanned=1`,
   `failedUnknownCharge=1`, `requeued=0`, `enqueuer.requests=[]` — nothing can reissue the call,
   so at most one billable request exists (R-012-3).

## Acceptance mapping (LEAD_PLAN §7 format)

| Criterion                                                           | Test id                                                                                                                 | Result                                      | Artifact                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------- |
| R-011-1 jobs persist; restart re-runs only the in-flight stage      | `reconciler.test.ts` › resumes a stale job…; leaves a job alone…; R-011-1 mechanism                                     | PASS (mechanism)                            | `src/workers/reconciler.ts`                           |
| R-011-2 429/5xx/network retry ≤3 with 1/4/16 s; 4xx/auth fail fast  | `attempt.test.ts` #2, #3, #4; `failure-classification.test.ts` › R-011-2 backoff ladder                                 | PASS                                        | `src/workers/attempt.ts`                              |
| R-011-3 owner can retry a failed stage                              | `attempt.test.ts` #6 (manual-retry entry point refuses to reissue a pending run); `reconciler.test.ts` #2 (resume path) | PASS (mechanism; UI/API wiring is B-14)     | `src/workers/attempt.ts`                              |
| R-012-1 attempt row committed before the call                       | `attempt.test.ts` #1 (row read as `pending`/`pending` while the adapter runs) + B-02 two-connection test (unchanged)    | PASS                                        | `src/workers/attempt.ts`, B-02 guard                  |
| R-012-2 idempotency unprotected is recorded                         | `attempt.test.ts` #1 (`idempotency_protected=false` on the run)                                                         | PASS                                        | `src/db/repositories/generation-runs.ts`              |
| R-012-3 forced kill ⇒ ≤1 billable request on resume                 | `attempt.test.ts` #6; `reconciler.test.ts` #1                                                                           | PASS (mechanism; no live provider — L2)     | `src/workers/attempt.ts`, `src/workers/reconciler.ts` |
| R-012-4 timeout that may have billed is `unknown`, never `unbilled` | `attempt.test.ts` #5 (timeout ⇒ `timed_out`/`unknown`); #2 (503 ⇒ unknown); #3/#4 (401/429 ⇒ unbilled)                  | PASS                                        | `src/workers/attempt.ts`                              |
| R-023 resumable from Postgres with no duplicate runs                | `reconciler.test.ts` #2 (requeued once at attempt 2, second tick scans 0)                                               | PASS (mechanism; batch e2e is QA case #2)   | `src/workers/reconciler.ts`                           |
| R-022-2 retry scope stored on `job` before the retry runs           | `reconciler.test.ts` #5 (scope observed on the row at enqueue time)                                                     | PASS (storage half; computation stays B-03) | `src/db/repositories/jobs.ts`                         |
| US-013 attempt ledger visible with provider/model/request id/charge | `attempt.test.ts` #1, #2                                                                                                | PASS                                        | `src/workers/attempt.ts`                              |
| US-031 retry scope portion                                          | as R-022-2                                                                                                              | PASS                                        | `src/workers/reconciler.ts`                           |

## Decisions

- **D1 — one attempt counter, not two.** BullMQ `attempts` for a job whose first execution is
  attempt _n_ is `3 − n + 1`, and the processor derives `attemptNo = job.data.attemptNo +
job.attemptsMade`. A reconciler re-enqueue at attempt 2 therefore gets two BullMQ attempts,
  not a fresh three, so BullMQ and `job_attempt.attempt_no` cannot disagree.
- **D2 — `backoff_s` records the ladder position** (1, 4, 16) whenever the failure is
  transient, including attempt 3 (no fourth attempt is scheduled). That is the §3.1 invariant
  `{1,4,16} for attempts 1,2,3`; a non-retryable failure records `NULL`.
- **D3 — charge on doubt is `unknown`.** Any failure with no explicit `mayHaveBilled` flag and
  no 4xx status (bare `Error`, transport failure) is recorded `unknown`; only 4xx/429 (and an
  explicit `billedUnknown=false`) are `unbilled`. R-012-4 forbids claiming unbilled on doubt.
- **D4 — pending run ⇒ fail, not resume.** A job with a `pending` generation_run is marked
  `unknown charge` and failed; only a job with no pending run is re-enqueued. A `done` stage is
  a different `job` row already `succeeded`, so it is not in the scan and cannot be re-run.
- **D5 — structural classification.** B-04/B-05/B-06/B-07 shipped four parallel provider-error
  vocabularies (`errorClass`/`failureClass`, `mayHaveBilled`/`billedUnknown`). B-08 reads the
  values structurally instead of importing one module, and does not add a fifth copy.
- **D6 — repository layering kept.** No existing repository function changed behaviour; the
  new queries are appended, and `src/db/repositories/jobs.ts` is new because B-02 had no
  `job` writer.

## Limitations

- **L1 — no Redis on this host (and no Docker daemon).** The BullMQ _binding_
  (`createAttemptQueues`, `enqueueStageAttempt`, `UnrecoverableError` mapping) is type-checked
  but not executed against a server. Everything decided by B-08's policy — concurrency 4/1/1/2,
  priorities, attempt budget, the 1/4/16 s ladder, no-requeue on non-retryable — is asserted as
  data and pure functions, and the same `runProviderAttempt` is exercised end-to-end against
  Postgres via `runAttemptSequence`.
- **L2 — no live provider call** (tests may not reach a paid provider, and no spend is
  authorised). The provider is B-07's deterministic `FakeTtsAdapter`; the 503/401/429 series
  are its scripted failures. The real adapters classify identically by contract, but were not
  executed here.
- **L3 — error vocabulary is duck-typed.** Only B-07's error classes exist in this branch;
  B-04/B-05/B-06 shapes are asserted with structural fixtures. INT-01 must converge on one
  `errors.ts` (existing hotspot).
- **L4 — heartbeats are exposed, not scheduled.** `heartbeatAttemptLease` and
  `LEASE_HEARTBEAT_INTERVAL_MS = 5000` are implemented and tested; starting the timer is the
  stage-worker's job (B-09/B-10/B-11).
- **L5 — Redis-mirrored token bucket (§5.7) is NOT implemented here.** B-04…B-07 each recorded
  it as owed to B-08's worker wiring, but B-08's Signal line is attempt/retry/topology/
  reconciler. The adapters' buckets remain in-process. Flagged as a follow-up rather than
  silently closed.
- **L6 — retry scope computation stays B-03.** The reconciler accepts `retryScopeFor` and
  stores the result; it does not recompute stage state.
- **L7 — `job` has no heartbeat column** (B-02's M-003 / TECH_DESIGN §3.1). The lease lives on
  `job_attempt.heartbeat_at`, with `job.updated_at` as the fallback for a job that never
  started. No schema change was made; schema ownership is B-02's.
- **L8 — base merges.** B-03 and B-07 are merged into this branch to compile and run against
  the real schema/state machine and the TTS fake. B-04/B-05/B-06 are not merged (L3).
- **L9 — host Node v26.5.1** while `engines`/`.nvmrc` pin Node 20; lint, typecheck, build and
  all tests ran green on v26.5.1, but no Node-20 run was possible.
- **L10 — queued-job requeue relies on BullMQ job-id dedupe.** A job sitting in `queued` for
  longer than the lease TTL is re-added with the same `<job uuid>.a<attemptNo>` id and is
  deduped while the original is still waiting. If the attempt row was already written, the
  unique `(job_id, attempt_no)` constraint stops a duplicate call; if Redis processed the job
  and the outcome write was lost, the run row is `pending` and the pending guard fails it as
  unknown charge rather than reissuing.

## Follow-ups (not in this diff)

1. B-09/B-10/B-11 processors: `attemptNo = data.attemptNo + job.attemptsMade`;
   `throw workerFailureFromOutcome(outcome)`; 5 s heartbeat timer around the call.
2. B-14 worker bootstrap: `createAttemptQueues(REDIS_URL)`, per-queue `Worker` with
   `workerQueueSettings(name)`, and `reconcileStalledJobs` on startup with
   `createQueueEnqueuer`.
3. INT-01: converge `src/adapters/errors.ts`, `qualification.ts`, `rate-limit.ts` on one copy
   each (pre-existing hotspots) and re-point B-08's structural classifier if one vocabulary
   wins; keep one `provider-qualifications` writer.
4. Owner/coordinator: the Redis-mirrored rate-limit bucket (§5.7) still has no owning task
   after B-08's Signal line; assign it explicitly or accept the in-process bucket in A.
5. The enqueue guard (gate preconditions §4.8) belongs to the stage tasks; B-08 supplies
   `enqueueStageAttempt` with `reason: 'new_work' | 'manual_retry'`.

## No secrets

No `.env` or credential file is committed (`git log --all -- .env` → 0 lines). Evidence and
tests contain key _names_ only; the test password hash in B-02's fixture is an obvious
placeholder.
