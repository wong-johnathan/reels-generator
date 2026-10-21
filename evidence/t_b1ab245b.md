# B-10 acceptance evidence — image stage + provenance + first-three checkpoint (US-019)

- Task: t_b1ab245b, profile devbackend
- Branch: feat/t_b1ab245b, worktree .worktrees/t_b1ab245b
- Base: 03aad52, the B-09 head carrying B-04 050a26d, B-08 71b7435, B-07 9b54af2 and B-03 d4bd6d4
- B-06 merged first: d60c3ee, content of 17709c4
- Implementation: e0997e1, full sha e0997e16d2420d472f1553f2721b0c203af1958f

Long-form refs: LEAD_PLAN section 4 backend B-10; PRD rev 2.4 R-013, R-026 and section 10; TECH_DESIGN rev 1.0.1 4.2, 4.7, 4.8, 5.6, 11.1.

## Deliverables

- src/workers/image-stage.ts: the IM stage. planImageStage is pure and decides what one pass may generate; runImageStage claims the stage, opens a committed generation_run per scene call, calls the adapter through executePersisted, stores the bytes content-addressed, persists the asset, scene and run links in one transaction, and parks at the first-three checkpoint.
- src/workers/image-stage.test.ts: 17 tests, 7 planner and 10 DB-backed stage tests, all on the deterministic FakeImageAdapter.
- src/db/repositories/assets.ts: the provenance write path. Insert-or-reuse by content hash, scene link only while asset_id is null, generation_run reverse edge, reference-set query and the checkpoint anchor query.
- src/db/repositories/scenes.ts: scene list ordered by position with the joined asset id.
- src/db/repositories/video-stages.ts: stage and project reads and writes used by the stage, including claim, retry, regenerate, fail and succeed transitions, progress, and needs-attention accounting.
- src/db/repositories/review-decisions.ts: reads and writes review_decision, so the checkpoint approval is data and never worker memory.
- src/storage/object-store.ts: the content-addressed store port and its in-memory fake; keys derive from the sha256 and every write is verified against it.
- src/domain/generation-run.ts: additive openRunInAttempt, so several scene runs share one job attempt as TECH_DESIGN 4.7 requires.
- src/domain/drift-record.ts: the 17-scene drift record. It validates the model and the scene ids, computes the drift rate, and refuses a record with no model, a duplicate scene or an out-of-range scene.
- src/domain/drift-record.test.ts and src/storage/object-store.test.ts: 5 and 5 tests respectively.

## Signal line mapping

Signal: one image per scene with full provenance; the first-three checkpoint blocks scenes 4+ until review; drift count recorded.

1. One image per scene with full provenance: PASS.
   - image-stage.test.ts "generates all 17 scenes in one pass without a recurring protagonist": 17 asset rows, one per scene, every scene has an asset id, every run succeeded.
   - image-stage.test.ts "generates scenes 1-3 only, with full provenance, and parks at the checkpoint": each asset row is read back and asserted for prompt text, prompt hash, provider, model, seed, provider request id, series version id, the reference rights notes inside rights_metadata, and the generation run link.

2. The first-three checkpoint blocks scenes 4+ until review: PASS.
   - planner: "refuses scenes 4+ while the checkpoint is open" asserts to_generate is exactly positions 1, 2, 3 and blocked_by_checkpoint is 14; "stops at awaiting_review with nothing left it may call"; "releases the remaining scenes once the checkpoint is reviewed".
   - stage: "generates scenes 1-3 only..." proves the adapter served exactly 3 calls; "does not honour an approval recorded before the images it claims to review" proves a decision older than the images cannot unlock 4+; "releases the remaining 14 scenes once the checkpoint is approved" proves exactly 14 further calls, 17 assets and stage done with progress 17 of 17.

3. Drift count recorded: PARTIAL, and honestly so.
   - The record and its arithmetic are implemented and tested: drift-record.test.ts records 3 off-model scenes of 17 as drift_rate 0.1765, records a clean run as 0, and refuses a missing model, an out-of-range scene and a duplicated scene.
   - The measurement itself is an operator eyeball on real output and was NOT executed here. No test may call a paid provider and no spend is authorised, so this run reports no real 17-scene drift number. recordDrift cannot be handed an empty scene list to fake a zero, which is why the missing benchmark stays visible instead of turning into a pass.

## Commands run and results

All from the worktree .worktrees/t_b1ab245b, with TEST_DATABASE_URL pointing at the throwaway PostgreSQL 16.14 cluster on 127.0.0.1:55432.

- npm run verify: PASS overall.
  - eslint . : clean, no findings.
  - tsc -p tsconfig.json : clean.
  - vitest run : 38 test files passed, 409 tests passed, 0 failed, 0 skipped. B-09 reported 332 tests on its head, so this branch adds 77: the B-06 merge plus 27 new tests in this card, 17 image-stage, 5 drift-record and 5 object-store.
  - tsc -p tsconfig.build.json : clean.
- prettier --check on the 11 files this card touches: all match the project style.
- git log --all -- .env : 0 lines. No credential and no dotenv file is committed.

## Image stage tests, as executed

Planner, pure, 7 tests: refuses scenes 4+ while the checkpoint is open / stops at awaiting_review with nothing left it may call / releases the remaining scenes once the checkpoint is reviewed / generates every scene in one pass without a recurring protagonist / reports complete when every scene already has an image / refuses a blank prompt before anything can be billed / refuses duplicate scene ids.

Stage, DB-backed, 10 tests, every one passed: generates scenes 1-3 only with full provenance and parks at the checkpoint / releases the remaining 14 scenes once the checkpoint is approved / does not honour an approval recorded before the images it claims to review / stores one asset row for identical bytes and links both scenes / retries a transient failure and never regenerates a persisted scene / fails the stage on a non-retryable error with no requeue and no asset / refuses to call the provider when the adapter is not qualified / refuses to generate before the script is approved / refuses a reference image without a rights note / generates all 17 scenes in one pass without a recurring protagonist.

## Decisions

- D1 planImageStage is pure and it refuses scenes 4+ rather than warning about them, so no caller can spend the other 14 image calls by re-running the stage.
- D2 The checkpoint anchor is the newest scene 1..3 asset creation time. An approval must postdate it, and a stage with no scene 1..3 image counts as not reviewed, so regenerating the first three re-arms the gate.
- D3 One generation_run per scene call, sharing the job_attempt opened by the first call. A transient failure ends the attempt and the next attempt resumes at the first scene with no asset, so a retry never re-buys a persisted image.
- D4 Asset persistence keeps one row per content hash and links a scene only while its asset_id is null. Replacing an existing image is B-15 path, not a stage retry.
- D5 The image qualification gate runs before the stage is claimed and before any call is made.

## Artifact contradiction raised, not silently chosen

C-B10-1. TECH_DESIGN 4.2 permits running to awaiting_approval but forbids awaiting_approval to running. UX_SPEC A-14 and A-15 plus UI_SPEC S-12 require the IM stage to stop at awaiting approval after 3 of 17 and then continue with the remaining 14 on the Release remaining action. Recommendation: add one row to TECH_DESIGN 4.2 allowing awaiting_approval to running for that action. Until the techlead rules, no illegal transition is performed: the stage stays running at 3 of 17, the project goes NEEDS_ATTENTION, and planImageStage refuses scenes 4+ until a matching approval exists. The only visible difference is the stage chip: running at 3 of 17 instead of awaiting approval.

## Limitations

- L1 No live provider call. Tests inject the deterministic fake; no spend was authorised and a test that needs the network is a broken test.
- L2 The real 17-scene drift eyeball is not measured, see the Signal section.
- L3 Only the in-memory content-addressed store exists today; the MinIO backend and its boot wiring are not in this card.
- L4 No HTTP surface. The S-12 approval is written through recordReviewDecision by the operator path; the route and the re-enqueue are later cards.
- L5 runImageStage is the unit a queue worker calls. Registering it with workerQueueSettings, the BullMQ retry policy and the heartbeat timer is B-14.
- L6 The DB-backed tests need TEST_DATABASE_URL and skip loudly without it; they ran against the throwaway PostgreSQL 16.14 cluster on 127.0.0.1:55432.
- L7 The host runs Node v26.5.1 while engines pins 20.x, as on every earlier card.

## Follow-ups, outside this diff

- MinIO or S3 implementation of ContentAddressedStore plus boot wiring.
- Register the image stage on the image queue with the B-08 retry policy and a 5 s heartbeat.
- S-12 API route: record the approval and enqueue the release job.
- Milestone A: run the real 17-scene eyeball with the reference set and record it with recordDrift.
- INT-01: converge the remaining duplicate adapter and qualification modules.

## No secrets

No credential, token or dotenv file is committed; git log --all -- .env returns 0 lines. Key names only appear in the environment documentation, never values.
