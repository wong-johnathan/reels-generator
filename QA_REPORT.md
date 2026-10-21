# QA-01 — Independent verification report, Milestone A

**Verdict: NOT RELEASE-READY.** 53 of 57 Milestone A acceptance criteria pass on independent execution; one is rejected (partial, R-008-3 text qualification), one is blocked on a scope ruling (R-014-4), and **two of the four A benchmarks are not met on the required basis** (render benchmark recorded on the wrong host; 17-scene drift eyeball never executed). Details and exact gaps below. QA pass is withheld; release authorisation remains the owner's decision at the release gate.

| Field | Value |
|---|---|
| Task | QA-01 (`t_e6b1bffd`) |
| Integrated SHA verified | `7c650c86c8343ae692c7cca596e7c4ee62e7230a` |
| Branch | `int/t_58f603ef` |
| Verifier | profile `qa`, run 233, 2026-10-21 |
| Scope source | PRD rev 2.4 §11, LEAD_PLAN §4 (B-01…B-15, F-01…F-09) + §7 QA contract, RULINGS L-2 (B-15 promoted to A), APPROVAL PA-2 (auth in A) |
| Verdict rule | an AC is ACCEPT only where a test exists, exercises the criterion, and passed in the run below. Skipped = failed unless approved; none approved. |

## 0. Artifact hash check (PRD_HASHES.md is authoritative, RULINGS L-5)

All nine artifacts were re-hashed from the working tree at the verified SHA. **9/9 match** the `PRD_HASHES.md` table (hash and byte length), so every approval binds to the content I verified.

`PRD.md` 57fda8aa…f031 · `BACKLOG.md` 05bf3bdc…b790 · `UX_SPEC.md` 93aeb482…bda5 · `UI_SPEC.md` ed62f122…74c0 · `TECH_DESIGN.md` 694b0ea2…d51d · `LEAD_PLAN.md` 32c1a458…0235 · `RULINGS.md` 6bf7a198…2228 · `QUALIFICATION_RESULTS.md` 36b75edf…b807 · `APPROVAL.md` 4910095e…bf83 — all PASS.

## 1. Method and environment

Executed independently on the integration worktree, not from developer summaries:

- `npm run lint`, `npm run typecheck`, `npm run build` — run directly at the verified SHA.
- `npm run test` **with a real Postgres** and again without one, to separate genuine skips from environment gating.
- The QA-owned forced-kill e2e (`tests/e2e/`) run on its own first, then inside the full suite.
- Cross-check of all 24 developer evidence artifacts against the tests they cite (paths, test names, AC coverage), plus the A benchmark artifacts.

Environment: Debian 13 container, Node v26.5.1, ffmpeg/ffprobe 7.1.5, no Docker daemon, non-root user. Postgres 16.15 was started by QA at `127.0.0.1:55432` from the pre-existing `/tmp/pg16` tree; that tree was missing `libicu76` and `pgvector`, so I extracted Debian `libicu76_76.1-4+b1` and PGDG `postgresql-16-pgvector_0.8.7` (pgcrypto 1.3 + pgvector 0.8.7 — the same extension versions the evidence run used). `TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/reels_test`.

No test called a paid provider, and no test required network egress: the only "provider" in the QA e2e is an `http.Server` on 127.0.0.1 that counts requests. No production operations, no spend, no push to `main`.

## 2. Independent suite result at `7c650c8`

| Gate | Command | Result |
|---|---|---|
| Lint | `npm run lint` | PASS — 0 problems |
| Types | `npm run typecheck` | PASS |
| Build | `npm run build` | PASS |
| Unit+integration, **no DB** | `env -u TEST_DATABASE_URL npm run test` | **109 files passed, 19 skipped; 1,463 tests passed, 151 skipped, 0 failed** (exit 0) |
| Unit+integration, **real Postgres** | `TEST_DATABASE_URL=… npm run test` | **128 files passed; 1,614 tests passed, 0 failed, 0 skipped** (633 s) |

The 1,614th test is the QA forced-kill e2e, which was untracked at handoff and therefore absent from INT-01's 1,613. It is committed with this report as an additive QA commit on `int/t_58f603ef` on top of `7c650c8`; the run above executed that working-tree content, and the commit changes no product code.

## 3. Skip register — coordinator item 1 closed

Every skip in the repository is the **database gate**, and nothing else:

- 26 `describe.skipIf(!hasDatabase)` blocks across 24 files: `auth-routes`, `series-routes`, `db/client`, `db/runner` (×2), `provider-qualifications`, `image-qualification`, `qualification`, `text-qualify`, `tts-qualify`, `generation-run`, `series`, `scene-replace`, `export/stage`, `render/qc-stage`, `render/stage`, `attempt` (×2), `image-stage`, `narration-stage`, `reconciler`, `timing-stage`, `operator`, `service`, `sessions`, and the QA e2e.
- 1 `describe.skipIf(!hasFfmpeg || !hasFfprobe)` block (`render.integration.test.ts`) — ffmpeg 7.1.5 and ffprobe are present, so it ran.
- **Zero** skips gated on a provider key, network, or quarantine flag. No `it.skip`/`test.skip`/`describe.skip` anywhere.

What each group needs: a throwaway Postgres with `pgcrypto` + `pgvector`, which is startable on this host (I started it). What each group proves: the schema constraints, cross-session commit visibility, gate semantics, stage write paths and the reconciler — i.e. exactly the load-bearing behaviour that a unit stub cannot show. **With the DB up, 0 tests skip.** The 151 skipped tests in DB-less mode are those groups and are labelled with a printed reason; they are not an unapproved quarantine. **No skip-gap remains.**

## 4. Per-requirement verdicts — Milestone A (57 ACs)

Scope = the ACs owned by B-01…B-15 and F-01…F-09 per LEAD_PLAN §4, with L-2 (R-007-1/2 in A) and PA-2 (R-015 in A). "Result" is the outcome in my real-Postgres run; "Evidence" is the developer artifact I cross-checked, not a substitute for execution.

| AC | Story | Test id (file :: name) | Result | Evidence | Verdict |
|---|---|---|---|---|---|
| R-001-1 | US-008 | `tests/web/series-fields.test.ts :: includes the series name when it changes` | PASS | t_972d5a76, t_eef060d2 | ACCEPT |
| R-001-4 | US-010 | `src/api/series-routes.test.ts :: an HTTP edit never mutates an existing project or its stage pins (R-001-4)` | PASS | t_972d5a76 | ACCEPT |
| R-002-1 | US-010 | `src/domain/series.test.ts :: an edit mints a new immutable version with the changed field named` | PASS | t_972d5a76 | ACCEPT |
| R-002-2 | US-010 | `src/workers/narration-stage.test.ts :: stores narration … full provenance`; `scene-replace.test.ts` | PASS | t_672fc3ab | ACCEPT |
| R-002-3 | US-010 | `src/domain/series.test.ts :: a later stage adopts the new version when it starts; earlier pins keep theirs` | PASS | t_972d5a76 | ACCEPT |
| R-002-4 | US-010 | `tests/web/export-model.test.ts` (per-stage pins inspector) | PASS | t_d46e306d, f-09 | ACCEPT |
| R-003-1 | US-017 | `src/domain/authoring.test.ts` (1–5 references + style summary) | PASS | t_1e422e39 | ACCEPT |
| R-003-2 | US-017 | `src/domain/eight-gram.test.ts`; `tests/web/script-model.test.ts` | PASS | t_1e422e39 | ACCEPT |
| R-003-3 | US-017 | `src/domain/authoring.test.ts :: rejects a reference without a rights note … stored source text` | PASS | t_1e422e39 | ACCEPT |
| R-003-4 | US-017 | `src/domain/authoring.test.ts` (rights notes per reference) | PASS | t_1e422e39 | ACCEPT |
| R-004-1 | US-014 | `src/adapters/text-schemas.test.ts`; `src/domain/validation.test.ts` | PASS | t_1e422e39 | ACCEPT |
| R-004-2 | US-014 | `src/adapters/text.test.ts :: rejects a schema violation and names the failing field` | PASS | t_c0d801d9 | ACCEPT |
| R-005-1 | US-028 | no test names the AC; behaviour covered by `script-client :: approves, swaps the control…`, `quality-page`, `scene-replace`, `app-narration :: POST /videos/:id/audio/rerun` | PASS (behavioural) | t_90884a02, t_167e32e7 | ACCEPT — test-tag gap (D5) |
| R-005-2 | US-028 | `src/workers/image-stage.test.ts :: refuses to generate before the script is approved (R-005-2)` | PASS | t_90884a02 | ACCEPT |
| R-005-3 | US-028 | `src/export/stage.test.ts :: refuses to export without an FA approval (R-005-3)` | PASS | t_263157b2 | ACCEPT |
| R-005-4 | US-028 | `src/db/runner.test.ts :: requires a reason and a return stage on a rejected review decision` | PASS | t_263157b2 | ACCEPT |
| R-006-1 | US-029 | `tests/web/script-impact.test.ts` (invalidation preview before spend) | PASS | t_8e44bd1a | ACCEPT |
| R-006-2 | US-029 | `src/domain/invalidation.test.ts` (8-row matrix, reframe conditional) | PASS | t_90884a02 | ACCEPT |
| R-007-1 | US-020 | `tests/web/scene-detail-page.test.ts`, `scene-grid-page.test.ts`; `src/domain/scene-replace.test.ts` | PASS | t_167e32e7 | ACCEPT |
| R-007-2 | US-020 | `src/db/runner.test.ts :: keeps scene_no stable and unique per project (R-007-2)` | PASS | t_167e32e7 | ACCEPT |
| R-008-1 | US-011 | `src/adapters/{text,image,tts,errors}.test.ts` (model id, creds, timeouts) | PASS | t_c0d801d9, t_91b76917, t_fa5e83c8 | ACCEPT |
| R-008-2 | US-011 | `src/adapters/text.test.ts :: acquires the rate limiter before the request is issued (R-008-2)` | PASS | t_c0d801d9 | ACCEPT |
| R-008-3 | US-012 | qualification machinery: `src/adapters/qualification.test.ts`, `image-qualification`, `text-qualify`, `tts-qualify` | PASS (mechanism) | QUALIFICATION_RESULTS.md, B-04/B-06/t_fa5e83c8 | **REJECT — partial (D8)** |
| R-008-4 | US-011 | `src/adapters/research-deepseek.test.ts :: surfaces the provider request id from the response headers` | PASS | t_4967e91f | ACCEPT |
| R-009-1 | US-023 | `src/domain/series.test.ts :: applies the R-009-1 defaults: 75 s, 9:16, 1K…`; `series-routes` 10 s floor | PASS | t_972d5a76 | ACCEPT |
| R-009-2 | US-018 | `src/adapters/text-schemas.test.ts :: keeps the script inside the measured 75 s word band (216–239)` | PASS | t_1e422e39 | ACCEPT |
| R-009-3 | US-022 | `src/render/qc.test.ts :: fails duration when the render lands outside the R-009-3 band` | PASS | t_62fc8fe1 | ACCEPT |
| R-009-4 | US-022 | `src/workers/timing-stage.test.ts :: a duration miss returns the video to script/voice review and never time-stretches` | PASS | t_672fc3ab | ACCEPT |
| R-010-1 | US-024 | `src/render/stage.test.ts` (1080×1920, 30 fps, H.264/AAC argv) | PASS | B-12 | ACCEPT |
| R-010-2 | US-024 | `src/render/qc.test.ts :: passes all six R-010 assertions on a conforming file`; `fails geometry … one pixel` | PASS | B-12 | ACCEPT |
| R-010-3 | US-024 | `src/render/qc.test.ts :: fails audio when it drifts more than 0.5 s` | PASS | B-12 | ACCEPT |
| R-010-4 | US-025 | `src/render/qc.test.ts :: flags blank and white frames (R-010-4)` | PASS | B-12 | ACCEPT |
| R-010-5 | US-025 | `src/render/qc.test.ts :: fails scene presence when a chapter is shorter than its narration span − 0.2 s` | PASS | t_672fc3ab | ACCEPT |
| R-010-6 | US-025 | `src/render/qc.test.ts :: fails the safe-area check when caption ink lands outside the inset rectangle` | PASS | f-08 | ACCEPT |
| R-010-7 | US-025 | `src/render/qc.test.ts :: fails duration when the render lands outside the R-009-3 band` | PASS | B-12 | ACCEPT |
| R-011-1 | US-031 | `src/workers/reconciler.test.ts :: resumes a stale job with no in-flight call exactly once`; `retry-scope :: never re-runs a done (not stale) downstream stage` | PASS (behavioural) | t_b3d9c9d4 | ACCEPT — test-tag gap (D5) |
| R-011-2 | US-031 | `src/domain/retry-scope.test.ts`; `src/adapters/errors.test.ts` (transient vs non-retryable) | PASS | t_b3d9c9d4 | ACCEPT |
| R-011-3 | US-031 | `tests/web/app-narration.test.ts :: POST /videos/:id/audio/rerun`; `script-client :: applies and regenerates at the first invalidated stage only` | PASS (behavioural) | t_b3d9c9d4 | ACCEPT — test-tag gap (D5) |
| R-012-1 | US-013 | `src/workers/attempt.test.ts :: commits the attempt row before the call, then bills a success` | PASS | t_b3d9c9d4 | ACCEPT |
| R-012-2 | US-013 | `src/adapters/tts.test.ts :: declares the provider idempotency contract (R-012-2)` | PASS | t_b3d9c9d4 | ACCEPT |
| R-012-3 | US-013 | **`tests/e2e/forced-kill.e2e.test.ts :: resumes with exactly 1 billable request and records unknown charge`** | **PASS** (independent) | §5 below | ACCEPT |
| R-012-4 | US-013 | `src/db/runner.test.ts :: forbids billed_units on an unbilled charge and unbilled on a timeout (R-012-4)` | PASS | t_b3d9c9d4 | ACCEPT |
| R-013-1 | US-019/021 | `src/workers/narration-stage.test.ts :: stores narration with voice config, request id and full provenance (R-013-1/2)` | PASS | t_672fc3ab | ACCEPT |
| R-013-2 | US-019/021 | same test (tagged R-013-1/2); `tests/web/scenes-model.test.ts :: provenance (R-013-1/2)` | PASS | t_672fc3ab | ACCEPT |
| R-014-1 | US-026 | `src/export/package.test.ts`, `src/export/stage.test.ts` (MP4 + srt + vtt + sidecar + manifest) | PASS | B-12, f-09 | ACCEPT |
| R-014-4 | US-026 | **none** — no write path, no route, no test | NOT TESTED | B-12 §"Out of scope" | **BLOCKED — scope ruling (D3)** |
| R-015-1 | US-004 | `src/auth/password.test.ts` (argon2id), `src/auth/operator.test.ts` | PASS | t_a1946210 | ACCEPT |
| R-015-2 | US-004 | `src/api/auth-routes.test.ts`, `src/auth/cookies.test.ts` (httpOnly) | PASS | t_a1946210 | ACCEPT |
| R-015-3 | US-004 | `src/api/auth-routes.test.ts :: has no registration or password-reset endpoint (R-015-3)` | PASS | t_a1946210 | ACCEPT |
| R-015-4 | US-004 | `src/api/auth-routes.test.ts :: protects every /api route except login/session (R-015-4)` | PASS | t_a1946210 | ACCEPT |
| R-015-5 | US-004 | `src/security/redact.test.ts`, `src/security/log.test.ts`, `tests/compose.test.ts`; `npm run security:scan` | PASS | B-13 | ACCEPT |
| R-015-6 | US-004 | `src/auth/service.test.ts` (auth always on; refuses to start without it) | PASS | t_a1946210 | ACCEPT |
| R-016-1 | US-001 | `tests/compose.test.ts :: pins every image by tag and digest, for linux/amd64 (R-016-1)` | PASS | t_401214c5 | ACCEPT |
| R-016-2 | US-001 | `tests/compose.test.ts :: never builds on the NAS: no service has a build key (R-016-2)` | PASS | t_401214c5 | ACCEPT |
| R-016-3 | US-001 | `tests/compose.test.ts :: publishes only the web entrypoint; stores stay on the private network` | PASS | t_401214c5 | ACCEPT |
| R-016-4 | US-001 | `tests/compose.test.ts :: keeps data on named volumes, so "down" cannot delete it` | PASS | t_401214c5 | ACCEPT |
| R-016-5 | US-001 | `src/boot/validate-env.test.ts`, `src/config/env.test.ts` (names the missing key) | PASS | t_401214c5 | ACCEPT |

Count: 57 ACs — 53 ACCEPT, 3 ACCEPT with a test-tag gap (R-005-1, R-011-1, R-011-3), 1 REJECT (R-008-3 partial), 1 BLOCKED on a scope ruling (R-014-4). Nothing in this table is accepted on the strength of a developer summary: every ACCEPT row was executed in my own run at `7c650c8`, and every cited test path and test name was checked against the tree (§9).

### 4.1 Out of A by scope (not assessed as A criteria)

R-001-2 (duplicate), R-001-3 (archive with in-flight batch), R-006-3 (reorder), R-007-3 (reorder remaps captions), R-014-2/3 (batch ZIP + `manifest.csv`), R-017 (migration/rollback safety beyond the minimal A migration), R-018 (degraded startup), R-019…R-023 (batch mode), R-024 (optimistic locking / 409), R-025 (retention preview), R-026 (asset dedupe), R-027 (citation enforcement), R-028 (batch cancel). Several of these already have unit coverage on the integrated branch (for example the R-024 series-API tests, R-023 reconciler tests and R-026 hash-dedupe tests all ran green), but they are **not** acceptance criteria for A and none of them is claimed here.

## 5. QA-owned e2e suite — six cases

Only case #1 plus the four A benchmarks gate Milestone A (LEAD_PLAN §7). Cases #2–#6 are Milestone B exit criteria and are recorded here as NOT IMPLEMENTED so they cannot be mistaken for passing.

| # | Case | Milestone | Status | Where |
|---|---|---|---|---|
| 1 | Forced kill mid-call → exactly 1 billable request, attempt `unknown charge` | **A** | **PASS** (independently executed) | `tests/e2e/forced-kill.e2e.test.ts`, `tests/e2e/fixtures/forced-kill-child.ts` |
| 2 | Mid-batch restart: kill in a 5-video batch → 0 duplicate `generation_run` | B | NOT IMPLEMENTED | — |
| 3 | Reorder two scenes → 0 image + 0 TTS calls, captions remap, `scene_no` unchanged | B | NOT IMPLEMENTED | — |
| 4 | Two-tab save → one 200 + one 409 carrying the current revision | B | NOT IMPLEMENTED | — |
| 5 | Postgres down → 503 readiness + "service not ready"; up → self-heal ≤30 s | B | NOT IMPLEMENTED | — |
| 6 | Batch cancel → stops scheduling, keeps completed assets, rest CANCELLED, excluded from export, in-flight call not aborted | B | NOT IMPLEMENTED | — |

### Case #1 — what actually runs

The test is a real forced kill, not a simulated one:

1. A **separate OS process** (`tsx tests/e2e/fixtures/forced-kill-child.ts`) executes one billable attempt through the production `runProviderAttempt`, which commits the `job_attempt` + `generation_run` pair before the adapter is allowed to call out.
2. The adapter POSTs to an `http.Server` on `127.0.0.1` that **counts the request and never answers** — so the kill lands in the requirement's exact window: attempt committed, provider called, no asset persisted.
3. The parent waits for the request body, sends **SIGKILL**, and asserts `exit.signal === 'SIGKILL'` plus the absence of the child's `CALL_RETURNED`, `PERSISTING_ASSET` and `OUTCOME` markers.
4. Pre-resume state is asserted from a second connection: exactly **1** `generation_run`, `status = pending`, `charge_status = pending`, `provider_request_id IS NULL`, `started_at` set, **0** assets.
5. Resume runs the production startup reconciler (`reconcileStalledJobs`) with a recording enqueuer: `failedUnknownCharge = 1`, `requeued = 0`, and **`enqueuer.requests` empty** — nothing is handed back to the queue, so the call cannot be reissued.
6. Post-resume: `generation_run` → `unknown/unknown`, `job_attempt` → `unknown_charge`, `job` → `failed`; the fake provider counted **exactly 1** request; a second reconcile scans 0 and still leaves the count at 1.

Observed in my run: `tests/e2e/forced-kill.e2e.test.ts (1 test) 33.5 s` → `✓ resumes with exactly 1 billable request and records unknown charge 5.6 s`.

**Limitation, stated rather than papered over:** R-012-3's wording says "verified against the provider's usage report". That is impossible without a paid provider call, which this card forbids. The counting loopback provider is the strongest admissible substitute and it counts requests at the wire, not in the app. A real-provider usage-report check therefore remains outstanding for the first production run; it does not block the mechanism, which is what the criterion protects.

## 6. Milestone A benchmarks (the other gate)

| # | Benchmark | Recorded | Value | Basis | Verdict |
|---|---|---|---|---|---|
| 1 | Render wall-time + peak RAM | yes | 1K: 200.5 s / 1,066 MB; 2K: 206.3 s / 1,257 MB; QC pass on both | `evidence/benchmark/{1k,2k}.json` | **REJECT — recorded on the dev host, not the DS923+** |
| 2 | 17-scene character-drift eyeball | **no** | — | B-10 evidence, "PARTIAL … NOT executed here" | **REJECT — not measured** |
| 3 | Word coverage + monotonicity, ≥10 proper nouns | yes | 265/265 words = 100 %, monotonic, 87.3 s; sample carries 11 proper nouns (`d5-proper-nouns-75s`) | t_fa5e83c8; QUALIFICATION_RESULTS §2 (100 % char coverage, monotonic, 79.12 s real run) | **ACCEPT** |
| 4 | 1K-upscaled-1.406× vs 2K-downscaled caption legibility | yes | both crops + full frames; numbers above | `evidence/benchmark/caption{,-crop}-{1k,2k}.png` | **ACCEPT** (artifacts; I inspected both crops) |

On #1: the JSON itself says *"the DS923+ exit criterion is only met by a run whose --label says DS923+"* and carries `host_label: "dev host (Linux container, not DS923+)"` with an AMD Ryzen Embedded R1600 / 4-core / 19.9 GB container. The numbers are real and useful, but they are not the measurement the exit criterion and `GATE_RELEASE_A.md` require.

On #2: the drift record machinery is implemented and tested with synthetic counts (`src/domain/drift-record.ts`, `drift-record.test.ts` records 3/17 = 0.1765), but no real 17-scene run was measured. It cannot be measured here: it needs paid provider calls and an operator's eyes. This is a genuine blocker for A, not a QA limitation to excuse.

On #4: I loaded both caption crops myself. Both are sharp and fully legible over the busy testsrc2 pattern — white fill, black outline, no halo, no edge clipping in either the 1K crop or the 2K crop. The choice between them stays the owner's; the legibility question the benchmark asks is answered affirmatively for the 1K path.

## 7. Rejections and defects

Severity: **Blocker** = A cannot be accepted; **Major** = A-scope behaviour missing/ambiguous; **Medium** = acceptance evidence not to contract; **Low** = hygiene.

| id | Sev | Finding | Expected vs actual |
|---|---|---|---|
| D1 | **Blocker** | Render wall-time/RAM benchmark measured on the dev container, not the DS923+ | Expected: numbers from the target NAS per PRD §11 and `GATE_RELEASE_A.md`. Actual: `host_label` explicitly says not DS923+; the artifact's own note says the criterion is unmet. Re-run on the NAS: `tsx src/render/benchmark-cli.ts --scenes 17 --duration 75 --resolution 1K --out <dir> --json <file> --label "Synology DS923+ (render-worker)"`. |
| D2 | **Blocker** | 17-scene character-drift eyeball never executed | Expected: 17 scenes generated with the recurring-protagonist reference set, off-model scenes counted, `recordDrift` row. Actual: B-10 evidence marks the measurement PARTIAL/not executed; only the recorder is tested. Needs authorized spend + operator judgement. |
| D3 | **Major** | R-014-4 (mark posted → `posted_flag=1` on re-export) has no implementation | Expected: an action recording platform + ISO-8601 UTC timestamp + URL, and a re-export emitting `posted_flag=1`. Actual: `publication_log` DDL and a mock fixture field only — no write path, no route/action, no test. **Scope conflict:** BACKLOG gives R-014-4 to US-026 (B-12, an A task) while PRD §11 lists "posting log (R-014)" under Milestone B. QA does not rule on scope; the coordinator/owner must. If A: implement + test. If B: create the B card. |
| D4 | Medium | No end-to-end thin-slice test | Expected: one test that drives topic → script → storyboard → images → narration → timing → render → QC → export through the real orchestration with fake adapters. Actual: stages are covered individually (plus a real-FFmpeg render integration test); nothing stitches the chain, so a wiring break between stages would pass the suite. |
| D5 | Low | Three ACs have no test that names them (R-005-1, R-011-1, R-011-3) | Behaviour is covered by gate/reconciler/rerun tests; the AC-to-test trace the QA contract requires is missing. |
| D6 | Low | Three of 24 evidence files carry prose instead of the required `{criterion → test id → result → artifact}` table | B-07 is a pointer to `t_fa5e83c8.md`; B-08 and B-12 are narrative. Content is recoverable; the contract format is not met. |
| D7 | Low | `provider_qualification` rows proving R-008-3 in tests are written by fake adapters | Expected in production: rows from a real `qualify()` run. Actual: the real qualification results live in `QUALIFICATION_RESULTS.md`, not in the table the runtime gate consults. Operationally, run `qualify()` with real keys once per adapter before first production use. |
| D8 | **Reject (partial)** | R-008-3 is only partly qualified against real providers | Image (reference held across 3 scenes), TTS (100 % char coverage, monotonic, 79.12 s) and research (URLs retrievable) have recorded real runs in `QUALIFICATION_RESULTS.md`. The **text** adapter's "schema-conformant response for each schema" has no recorded real-provider run — only fixture-level `qualify()` tests. Also note §3 of that artifact records research precision of 1-of-5 high-quality results, while B-05's test asserts a 3-of-5 pass; the 3-of-5 claim is not reproduced against the live provider. |

## 8. Test coverage — items to route back to the developers (via the lead)

1. **R-014-4** (after the scope ruling): write path + tests for mark-posted (platform, ISO-8601 UTC timestamp, URL) and re-export `posted_flag=1`; extend `manifest.csv` coverage.
2. **End-to-end thin-slice test** (D4): one test at the orchestration level with fake adapters, a real Postgres and real ffmpeg, asserting each stage's persisted output and the final package. This is the test that would catch a broken stage-to-stage wire.
3. **AC tagging** (D5): add or rename one test per AC for R-005-1 (approve/edit topic, script, visuals, audio, final), R-011-1 (restart reuses completed media, only the in-flight stage re-runs) and R-011-3 (manual retry of a failed stage), so the trace is explicit rather than inferred.
4. **R-008-3 text qualification** (D8): run `qualify()` against the real text provider for topic.v1, script.v1, storyboard.v1, commit the recorded rows/date, and reconcile the research 3-of-5 claim with the measured 1-of-5 precision.
5. **e2e cases #2–#6**: not implemented; they are B exit criteria. They need an owning card before Milestone B can be verified — QA is not assigning that work to itself.

## 9. Evidence cross-check (independent, not a file listing)

- **24/24** task evidence artifacts exist for B-01…B-15 and F-01…F-09 (named mostly by task id — `B-07 → t_fa5e83c8.md`, `B-08 → t_b3d9c9d4.md`, `B-12 → B-12.md`, `F-04 → f-04/`, and so on). No artifact is missing.
- **164** distinct test paths are cited across the evidence; **all resolve** in the tree (two are written relative to `src/`, e.g. `db/client.test.ts`, and resolve there).
- **96** quoted test names were extracted from evidence `file :: name` claims; **87 match a test name verbatim** in the suite. The other 9 are abbreviated with "…" inside the evidence (e.g. `app-auth :: sets an httpOnly…cookie`), which is imprecision, not fabrication.
- **3 of 24** artifacts do not contain the contract's per-AC table (D6). The remaining 21 do, and I checked the AC rows I relied on rather than accepting them wholesale.
- Benchmark artifacts: `1k.json`/`2k.json` carry all six QC checks with `"pass": true` and the requirement ids R-010-2…R-010-7; `caption*.png` exist and render legible captions (inspected).

## 10. Release recommendation

**NOT release-ready — do not authorise:** the code suite is green (1,614/1,614 with a real Postgres, 0 skipped) and the forced-kill e2e passes, but two of the four A benchmarks are unmet (render benchmark on the wrong host, 17-scene drift eyeball not executed) and R-014-4 needs a scope ruling; QA pass is withheld and releasing remains the owner's decision at `GATE_RELEASE_A`.

— QA (`qa`), 2026-10-21, verified SHA `7c650c86c8343ae692c7cca596e7c4ee62e7230a`.
