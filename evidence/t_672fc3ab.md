# B-11 — Narration + speech-led timing stage (US-021, US-022 timing integration)

Branch: `feat/t_672fc3ab`
Base: `03aad52` (B-09 head, which carries B-04 `050a26d`, B-08 `71b7435`, B-07 `9b54af2`, B-03 `d4bd6d4`)
Implementation commit: `640e993`
Evidence commit: this file
Developed in the isolated worktree `.worktrees/t_672fc3ab`; the shared tree was not modified.

Task (LEAD_PLAN §4): "B-11 Narration + speech-led timing stage (US-021, US-022 timing integration).
Owns: `src/workers/narration-stage.ts`, `src/workers/timing-stage.ts` (recalculate scene durations from
actual narration; ±5% band clamp ±1…±5 s; miss → return to script/voice review, never time-stretch).
Hard prereq: B-07, B-08, B-09 (approved script), B-03. Signal: narration stored with voice config +
request id; timing miss returns to review (R-009-4)."

## 1. Signal line — evidence from real runs

### 1.1 "narration stored with voice config + request id"

`src/workers/narration-stage.test.ts :: narration stage (US-021) > stores narration with voice config,
request id and full provenance (R-013-1/2)` — PASS, asserted against PostgreSQL 16.14:

- `asset` row (`stage='NA'`, `kind='audio'`, `mime_type='audio/wav'`, `project_id`, `generation_run_id`,
  `series_version_id`) carries `provider='fake'`, `model='fake-tts-model'`,
  `provider_request_id` matching `^fake-tts-[0-9a-f]{16}$`, `prompt_hash = ttsPromptHash(request)`,
  `prompt_text` = the approved narration, and `rights_metadata.voice = {voice_id, model_id,
licence_kind, licence_note}` (the voice/licence context US-021 asks for);
- `asset.object_key = 'sha256:' + content_sha256` and the bytes are present in the store under that key;
- the alignment sidecar (`kind='sidecar'`, `application/json`) parses to
  `schema_version='narration-alignment.v1'`, 228 words, `word_coverage = 1`;
- `generation_run` is `succeeded` / `billed` with the same `provider_request_id` and
  `idempotency_protected = false`;
- `video_stage.NA` is `done`, pinned to the series version in effect (`series_version_id`), and the
  project's `current_stage` is `TC`.

Identifier-free assertion summary: one adapter call, one audio asset, one sidecar, one billed run,
stage `done`.

### 1.2 "timing miss returns to review (R-009-4)"

`src/workers/timing-stage.test.ts :: timing stage (US-022) > a duration miss returns the video to
script/voice review and never time-stretches (R-009-4)` — PASS. 273 spoken words at the measured
3.035 words/s = 89.95 s narration; + lead 0.5 s + trail 0.5 s = 90.95 s final audio against the
75 s band 71.25–78.75 s:

- result `status='review_required'`, `reason='duration_out_of_band'`,
  `review_targets=['SC','NA']`, `time_stretched=false`, measured 90.95 s;
- one named failure string: "actual narration 89.95 s + lead/trail 1.00 s = 90.95 s vs target 75 s
  (+21.3%), outside 71.25–78.75 s (R-009-3: ±5 %, clamped ±1…±5 s). The video returned to
  script/voice review; the speech was not time-stretched (R-009-4).";
- **nothing is committed for render**: every `scene.narration_start_ms/end_ms` stays NULL, no timing
  asset is written, `video_stage.TC` is `failed`, `project.status = 'NEEDS_ATTENTION'`, the job is
  `failed`;
- the take is byte-identical afterwards (`content_sha256`, `object_size_bytes` and the whole alignment
  document re-read and compared) — there is no audio transform in this module at all.

The mirror case (`> a short take is a miss in the other direction`) proves a take below the band is
also returned, never stretched up.

## 2. Acceptance mapping

| Requirement                                                                                    | Test (file :: name)                                                                                                                                                   | Result                                                                                                    |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| R-013-1 narration records model, provider request id, series-version id, voice/licence context | `narration-stage.test.ts` :: stores narration with voice config, request id and full provenance                                                                       | PASS                                                                                                      |
| R-013-2 narration traceable to project + stage                                                 | same test (`asset.project_id`, `stage='NA'`, `generation_run_id`, `asset_ref`)                                                                                        | PASS                                                                                                      |
| R-008-4 provider request id required and recorded                                              | same test (`asset.provider_request_id`, `generation_run.provider_request_id`)                                                                                         | PASS                                                                                                      |
| R-002-2 series version in effect on the asset and the stage pin                                | same test (`asset.series_version_id`, `video_stage.series_version_id`)                                                                                                | PASS                                                                                                      |
| R-026 one blob per content hash; sharing via `asset_ref`                                       | `narration-stage.test.ts` :: dedupes identical narration bytes to one blob across projects                                                                            | PASS (one audio row, refs for both projects, 2 objects not 4)                                             |
| R-012-1 commit-before-call and asset-before-billed ordering (§2 step c)                        | `narration-stage.test.ts` :: stores the take before the cost row closes billed                                                                                        | PASS (store outage → 1 provider call, 0 assets, run `failed/unknown`, no `billed` row without bytes)      |
| R-011-2 transient vs non-retryable, stage never falsely failed mid-retry                       | `narration-stage.test.ts` :: a non-retryable provider failure stores nothing and fails the stage; :: a transient failure keeps the stage running while retries remain | PASS                                                                                                      |
| No second bill for a stage that is already `done` (§4.2)                                       | `narration-stage.test.ts` :: refuses to call the provider when the stage is already done                                                                              | PASS (`IllegalTransitionError`, 0 provider calls, 0 runs)                                                 |
| R-012-4 doubtful charge is `unknown`, never `unbilled`                                         | `narration-stage.test.ts` :: transient failure… and :: stores the take before…                                                                                        | PASS                                                                                                      |
| R-009-3 band = ±5 % clamped to ±1 s…±5 s                                                       | `timing-stage.test.ts` :: R-009-3 duration band (3 tests: 75/40, 10/20, 180/120)                                                                                      | PASS                                                                                                      |
| R-009-3 scene durations recalculated from actual narration                                     | `timing-stage.test.ts` :: recalculates scene durations from the actual narration                                                                                      | PASS (spans start at word 1, end at the last word of each range, contiguous, sum = spoken span; whole ms) |
| R-009-4 miss returns to review, never time-stretches                                           | `timing-stage.test.ts` :: a duration miss… and :: a short take is a miss in the other direction                                                                       | PASS                                                                                                      |
| R-008-3 ≥99 % coverage + monotonic gate applied before any span is written                     | `timing-stage.test.ts` :: word-timing coverage below 99 % returns to review instead of inventing spans                                                                | PASS (225/228 words timed = 0.9868 → `word_timings_invalid`, no spans)                                    |
| Storyboard plan must partition the narration                                                   | `timing-stage.test.ts` :: a scene plan that does not partition the narration returns to review; :: sceneSpansFromWords (2 unit tests)                                 | PASS                                                                                                      |
| TC is local: no provider call, no `generation_run` (§4.7)                                      | `timing-stage.test.ts` :: recalculates scene durations… (`generation_run` where `stage='TC'` = 0)                                                                     | PASS                                                                                                      |
| No test reaches a paid provider; fakes only                                                    | whole suite (B-07 `FakeTtsAdapter`, injected stores)                                                                                                                  | PASS — no network access anywhere                                                                         |

## 3. What shipped

Owned files (LEAD_PLAN §4):

- `src/workers/narration-stage.ts` — one TTS attempt through B-08's `runProviderAttempt`; stores the
  audio + alignment sidecar before the cost row closes; full R-013-1 provenance; `asset_ref` on
  content-hash reuse; stage transitions only through B-03's state machine.
- `src/workers/timing-stage.ts` — the local TC transform: R-008-3 gate, R-009-3 band with the
  ±1…±5 s clamp, scene-span recalculation, timing document sidecar, RE handoff, and the
  return-to-review path (R-009-4).

Additive support (required by the two stages, reported rather than hidden):

- `src/workers/asset-store.ts` — `AssetBlobStore` port, `sha256Hex` / `objectKeyFor` / `jsonBytes`,
  and a deterministic `InMemoryBlobStore`. No new dependency.
- `src/db/repositories/assets.ts` — `insertAsset` (`ON CONFLICT (content_sha256) DO NOTHING` + read),
  `findAssetById`, `linkAssetToProject`, `assetBelongsToProject`.
- `src/db/repositories/stage-state.ts` — `findProjectState`, `findVideoStage`, `beginStage`,
  `applyStageEvent`, `applyVideoEvent`, `setProjectCurrentStage`; every state change is
  `FOR UPDATE`-locked and routed through `transitionStage` / `transitionVideo`.
- `src/db/repositories/scene-spans.ts` — `listSceneSpans`, `writeSceneNarrationSpans` (all spans of
  one take in one transaction; a missing scene refuses the whole take).
- `tests/helpers/stage-fixtures.ts` — stage/job/scene fixtures and the deterministic 228-word take.

Shared files touched (small, additive, called out for INT-01):

- `src/workers/attempt.ts` — new optional `AttemptDeps.onResult(result, ref)` invoked between the
  adapter call and the billed/succeeded close. Without that seam a stage has no legal place to persist
  its asset (TECH_DESIGN §2 step (c)); with it, a persistence failure leaves an `unknown` charge
  instead of a `billed` row whose bytes were never written. B-08's 8 attempt tests still pass.
- `src/db/repositories/generation-runs.ts` — appended `recordPendingRunProviderRequestId` (the request
  id is only known after the response). Same file B-08 already appended to (existing hotspot).

## 4. Decisions

- **D1 — where the alignment/timing records live.** The frozen 22-table schema has no caption/timing
  table, but `contract/api.ts`'s `audio.accept` needs an `alignment_id` and BACKLOG US-022 says it
  "owns the caption/timing schema". Resolution used: the provider alignment and the derived timing
  document are content-addressed `asset` rows of kind `sidecar` (stage `NA`), which gives them a uuid,
  R-026 dedupe, `asset_ref` sharing and provenance for free. No table was invented.
- **D2 — `asset.stage` cannot be `TC`.** M-004's CHECK is
  `IM/NA/RE/QC/EX/MUSIC/POSTER/DERIV/REF`. The timing document is therefore stored as an `NA` sidecar
  whose `rights_metadata.stage` says `TC` and which names the narration asset it derives from. Raised
  as a task comment, not patched via migration in this diff.
- **D3 — "returns to script/voice review" is a typed return, not a rewritten state.** §4.2 has no
  legal `done → awaiting_approval` transition and a worker must not fake an operator
  `review_decision` (R-005-4). A miss therefore emits
  `{reason, review_targets:['SC','NA'], failures, measured_duration_s, band, time_stretched:false}`,
  marks TC `failed` with that named reason and moves the video to `NEEDS_ATTENTION`; the operator's
  decision (edit/re-run/accept) writes the ledger.
- **D4 — retryable failures leave the stage `running`.** B-08 owns the 1 s/4 s/16 s ladder; marking a
  stage `failed` on attempt 1 of 3 would be a false alarm. Only a terminal attempt fails the stage.
- **D5 — sidecar documents are pure functions of the payload.** The alignment document carries no
  derivation timestamp, so re-storing an identical take is a content-hash no-op rather than a second
  row (R-026). Untimed characters travel as JSON `null` and are restored to `NaN`, never to `0`.
- **D6 — scene spans are refused, not approximated.** A plan that does not partition the derived words
  exactly (gap, overlap, short) returns `scene_plan_invalid` instead of a proportional guess.

## 5. Contradictions / gaps raised (task comment)

1. **No caption/timing table.** `BACKLOG.md` US-022 ("Owns the `caption`/timing schema") and
   `contract/api.ts` (`audio.accept { alignment_id }`, `NarrationViewSchema.words`) versus
   `TECH_DESIGN.md` rev 1.0.1 §3 (22 tables, none of them caption/timing). Recommended: accept the
   content-addressed sidecar (this diff) for Milestone A and add a `caption` table only if a later
   story needs queryable word rows.
2. **`asset.stage` admits no `TC`** (`TECH_DESIGN.md` §3.1 `asset` CHECK) although §4.1 has a TC stage
   that produces caption/timing artefacts. Recommended: additive migration adding `'TC'` to the
   CHECK, or an explicit ruling that TC artefacts belong to `NA` (this diff's choice).

## 6. Limitations (stated, not hidden)

- **L1** No live ElevenLabs call: tests may not reach a paid provider and this host holds no key. The
  stage is exercised against B-07's deterministic fake; the real adapter's transport is B-07's
  evidence, not re-proven here.
- **L2** No MinIO binding: `AssetBlobStore` ships with a deterministic in-memory implementation.
  Wiring the S3/MinIO client into `src/worker/main.ts` is a follow-up (B-01's scaffold has no such
  dependency, and adding one is an image change outside this card).
- **L3** No BullMQ worker registration: the queue topology is B-08's and the stage call sites
  (`src/worker/main.ts`) are B-14/B-integration work. The stages are invoked as typed functions.
- **L4** The NA gate precondition ("script approved", §4.8) is enforced by the enqueue guard, not here;
  no enqueue guard exists on this branch yet.
- **L5** Narration duration is the provider-reported `duration_s` (derived from the alignment), not an
  ffprobe of the stored WAV (B-07 L-1); a real provider with trailing silence could differ.
- **L6** Scene spans are contiguous per word; for a real provider with inter-word gaps the span
  durations sum to less than the narration duration. R-010-5's per-scene minimum is checked in B-12.
- **L7** The series-version _pin at stage start_ uses the version supplied by the caller
  (`B-14`'s `seriesVersionForStageStart`/`pinStageAtStart` seam is not merged into this base).
- **L8** Host Node is v26.5.1 while `engines` pins `>=20.11 <21`: lint, typecheck, tests, build and
  format are green on v26.5.1 only; no Node-20 run is possible here.
- **L9** DB-backed suites need `TEST_DATABASE_URL` (loud skips otherwise). The evidence run used
  PostgreSQL 16.14 + pgcrypto + pgvector on `127.0.0.1:55432` (throwaway databases).

## 7. Commands run (real output summarised)

- `npm run typecheck` → clean.
- `npm run lint` (`eslint .`) → clean.
- `TEST_DATABASE_URL=postgres://reels@127.0.0.1:55432/reels_test npm run test` →
  **33 files, 348/348 tests passed**.
- `npx vitest run src/workers/narration-stage.test.ts src/workers/timing-stage.test.ts` →
  **2 files, 16/16 passed**.
- `npx vitest run src/workers/attempt.test.ts` (B-08 regression after the `onResult` seam) →
  **8/8 passed**.
- `npm run verify` without a database → lint + typecheck + build clean,
  **286 passed / 62 loud skips (25 files passed, 8 skipped)**.
- `npm run format:check` → "All matched files use Prettier code style!" (one pre-existing
  `evidence/t_90884a02.md` drift was left untouched; the formatter's rewrite of that file was
  reverted).
- `git log --all -- .env` → empty (0 commits).

## 8. Follow-ups (not in this diff)

- B-12: consume `TimingPlan.scenes` (spans + `duration_s`) for the FFmpeg scene durations and the
  caption line grouping; the timing document is the single source of caption text order.
- B-14/B-integration: register the NA/TC processors on B-08's content queue, pass
  `attemptNo = job.attemptsMade + 1`, throw `workerFailureFromOutcome(outcome)` from the processor,
  and start the 5 s lease heartbeat.
- MinIO `AssetBlobStore` binding (L2) and the §3.4 orphan scan.
- INT-01: decide the `asset.stage`/caption-table question (§5) and converge the duplicate
  `provider-qualifications.ts` / `qualification.ts` modules flagged by B-04/B-05/B-06/B-07/B-09.
- F-05/S-14: render `NarrationView.words`, the band (with the clamp) and the
  `time_stretched:false` explanation from these two stages' outputs.
