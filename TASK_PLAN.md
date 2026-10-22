# TASK_PLAN.md — Two-phase SC script generation (frozen frame + narration word budget)

Repo: /opt/data/engineering-team/projects/reels-generator
Base SHA: 909dcb8 (origin/main) — the pushed baseline this work branches from.
Approved direction: owner-approved replacement of the whole-script rewrite loop
(no new PRD/design revision; this is a correctness fix to SC within Milestone A).

## Problem

Real SC repeatedly misses the 75 s word band. Latest Video 1 reached attempt 9 at
210 words (~69.2 s) against the required 217–239 band (R-009-1, target 228). The
current loop (909dcb8) repairs the script.v2 field lookup but still asks the model
to count a whole script, which remains nondeterministic.

## Approved direction (must be preserved verbatim)

- Persisted/API contract stays the single `script` field (script.v2). Do NOT
  reintroduce persisted hook/narration/ending fields.
- Internally generate and validate a frame carrying `hook` + `ending` first (one
  frame call so the endpoints stay coherent), then freeze them.
- Count hook and ending with the same deterministic `countWords()` used by the
  final validator (`checkWordBudget`).
- Compute the remaining narration budget from the exact target (75 s -> 228 words;
  accepted band stays 217–239 under R-009-1).
- Generate only the middle narration for the remaining words.
- Assemble `script = hook + narration + ending`, count locally, reject until in band.
- Repair preserves hook/ending and regenerates/expands/cuts only the narration using
  the computed delta; never rewrite the whole script.
- Explicit sufficient `max_tokens` on SC frame/narration/repair responses.

## Design decisions (settled by tech lead)

D1. Two internal, non-persisted schemas, defined in a NEW pure module
`src/domain/script-generation.ts` (not in text-schemas.ts, so the versioned
script.v2 authority and qualification surface are untouched): - `script-frame.v1` -> `{ hook: string, ending: string, title: string,
      description: string, hashtags: string[] }` - `script-narration.v1` -> `{ narration: string }`
Both are `TextSchema` instances with `stage: 'SC'` (generation_run.stage has a
CHECK limited to T/RS/SC/SB/IM/NA, so no new stage code and no migration).
D2. Frame call also produces title/description/hashtags (frozen with hook/ending);
the narration call produces only the middle. Final `ScriptDocument` is
`{ script: hook + narration + ending, title, description, hashtags }` (script.v2).
D3. All three request kinds carry explicit max_tokens, as named constants:
`SC_FRAME_MAX_TOKENS = 1024`, `SC_NARRATION_MAX_TOKENS = 1536`,
`SC_REPAIR_MAX_TOKENS = 1536`. Values are generous so JSON is never truncated
(truncated JSON already fails schema parse, but a truncation must not be the
thing that loses the word count).
D4. Pure arithmetic (all in script-generation.ts, importing `countWords` and
`wordBudget` from authoring.ts / calibration.ts): - `frameWordCount(frame)` = countWords(hook) + countWords(ending) - `narrationWordTarget(frame, target)` = max(1, target_words - frameWordCount) - `assembleScript(frame, narration)` -> ScriptDocument (join hook, narration,
ending with single spaces; strip empty parts) - `narrationRepairDelta(assembledWordCount, target)` = target_words - count
(positive = expand, negative = cut; equals the narration delta because
hook/ending are frozen)
Final acceptance always goes through `checkWordBudget(assembled, target)`.
D5. Dashes: `stripForbiddenDashes` is applied to hook, ending and narration before
assembly (operator rule; no em/en dash can survive).
D6. No hook duplication: the narration prompt is told to write only the middle and
never restate the hook or ending; a light deterministic guard rejects a
narration whose opening repeats the hook verbatim (trimmed substring check).

## File ownership

devbackend (single writer, no parallel collision):

- NEW src/domain/script-generation.ts
- NEW src/domain/script-generation.test.ts
- EDIT src/workers/text-stage.ts (replace buildScriptRequest + scriptExpansionAdapter
  for SC only; T and SB paths untouched)
- EDIT src/workers/text-stage.test.ts (add wiring tests; keep existing)

Not touched (explicitly out of scope): text-schemas.ts (script.v2 unchanged),
authoring.ts countWords/checkWordBudget (reused, not redefined), any migration,
any DB/schema/API persistence, contract/api.ts.

## Pipeline (dependency-linked)

1. devbackend implementation (this card's child) -> commits on its own worktree.
2. techlead integration -> merges/commits the exact devbackend SHA, runs
   `npm run verify`, hands an exact SHA to QA.
3. qa -> independent verification at the integrated SHA.
4. HUMAN release gate (blocked, unassigned) -> release/deploy/retry of the failed
   batch stays gated on explicit owner approval. No live-DB mutation or batch
   regeneration as part of implementation.

## Required regression coverage (mapped to AC)

- frame validation (hook/ending non-empty, dashes stripped, freeze immutable)
- remaining-budget arithmetic (228 - hook - ending, min-1 clamp)
- assembly (exact order hook/narration/ending, single-space join)
- middle-only repair (delta computed, hook/ending preserved byte-for-byte)
- exact count semantics (217 and 239 inclusive in-band; 216 and 240 out; same
  countWords as checkWordBudget)
- out-of-band rejection (assembled out-of-band is never persisted; repair instead)
- explicit max_tokens (frame/narration/repair requests carry the constants;
  buildChatRequestBody forwards them)

## Verification

`npm run verify` (lint + format:check + typecheck + test + build) must pass locally
and on CI for the resulting commit.
