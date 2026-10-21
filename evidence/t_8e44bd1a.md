# F-05 — Script review & approval + invalidation preview

Task: `t_8e44bd1a` (US-017, US-029, R-005-2, R-006-1). Owns S-10 (UI_SPEC §6.6 W-05),
IP-01/UC-06 (UX_SPEC §4) and the post-commit stale ribbon (UC-05).

- Base: `38df2b6` (F-04, `feat/t_9a77c0c1`)
- Branch: `feat/t_8e44bd1a`
- Implementation commit: `cf9cd5f` (this file is committed separately, as F-02…F-04 did)
- Worktree: `/opt/data/engineering-team/projects/reels-generator/.worktrees/t_8e44bd1a`
- No `.env`, credential or provider key added. No test touches a network or a paid provider;
  every API call in tests goes through an in-memory fake (`FakeApi`) or an injected `fetch`.

## Signal

> "Approving script unlocks image+TTS; the impact panel shows invalidated stages + call
> counts before any edit."

**Before any edit** the impact panel is the server's `InvalidationPreview`, rendered on demand:
`tests/web/script-client.test.ts > IP-01 preview … > sends the edited content and renders the
invalidated stages and call counts` asserts one `POST /api/videos/:id/invalidation-preview` with
`{revision, edits:[{edit_kind:'script_wording'}], script_content}` and then 4 stale rows
(`SB 17`, `NA 1`, `TC 1`, `RE 1`), 2 survives rows and the call lines `image calls: 0 · TTS calls: 1`
/ `render passes: 1 · text calls: 1`, with the spend commit disabled until that response arrives.
Chromium against the real page and the shipped HTTP adapter (`evidence/f05/impact-ready-1280.png`)
shows the same panel: `4 stale`, both commits enabled, exactly one preview request — no provider call.

**Approving unlocks image+TTS**: `tests/web/script-client.test.ts > the approval gate … > approves,
swaps the control for the record line and unlocks image + narration` drives the real SSR markup:
`POST script.approve {revision:5}` → control replaced by `Approved rev 5 · operator · …` →
`video.get` refetch → `[data-stage="IM"]` and `[data-stage="NA"]` move from `blocked` to
`not_run`, and the live region says the stages are unlocked. The gate is data-driven from
`ScriptView`: a blocked draft makes no approve request at all (second test in that block), and
the server render carries the C-10 reason in `aria-describedby`.

## Acceptance mapping

| Criterion | Where | Result |
|---|---|---|
| R-005-2 mandatory script approval before any image/TTS call | `approvalView` (`src/web/script/model.ts`), `tests/web/script-model.test.ts` (5 tests), `tests/web/script-page.test.ts` (gate + `aria-describedby` + hidden control) | PASS |
| R-006-1 show expected invalidation before regeneration | `src/web/script/impact.ts`, `tests/web/script-impact.test.ts` (11 tests), `tests/web/script-client.test.ts` (preview + two commits) | PASS |
| R-006-2 exact matrix wording, conditional reframe, C-01/C-05/C-07 | `readyImpact`: stale rows, survives, calls, `conditional`, `blockers`, `C07_FAILED`; impact tests (ready, blockers, pending/reframable/not_reframable, failed) | PASS |
| R-003-2 8-gram result operator-visible, reference text never echoed | `eightGramView`; model tests assert FAIL wording and that a reference body after `:` is dropped | PASS |
| R-027-3 / C-10 citation block with the exact counts | `approvalView` C-10 sentence, `claimsView` statuses (`sourced`, `unsourced`, `url_unreachable`, `acknowledged_unsourced`, `non_factual`); model + page tests | PASS |
| C-09 unlock sentence before the commit | `approvalView.unlockLine` (`17 image calls and 1 TTS call`), page test | PASS |
| C-11 word budget vs 228 / 216–239 | `wordBudgetView`: `228 words → 75.1 s @ 3.035 w/s`, `band 216–239 words (71.2–78.7 s)`, warning copy out of band; `within_band` is read, never recomputed | PASS |
| AX-02 focus order status → budget → editor → claims → approval → impact | DOM order asserted in `script-page.test.ts`; CSS grid places the impact column visually right at ≥1101 px and below at ≤1100 px | PASS |
| AX-04 spend action second, never default focus, disabled until preview rendered | `impact.ts` `canApply`/`canRegenerate`; client tests; `script-styles.test.ts` 44 px stacked commits | PASS |
| AX-11 disabled reason is visible text wired by `aria-describedby` | page test for the blocked draft (`aria-describedby="script-approve-reason"`) | PASS |
| UC-05/IP-01 persistence: the panel collapses to the rail ribbon after commit | client test "paints the stale rail and ribbon" (SB/NA/TC/RE `data-state="stale"`, ribbon revealed) and Chromium `evidence/f05/after-apply-1280.png` | PASS |
| W-05 measurements: 40 px status and budget bars, 68ch editor, 56 px claim rows, 56 px approval block, 360 px sticky impact column | `src/web/styles/workspace.css` + `tests/web/script-styles.test.ts` (7 tests) | PASS |
| States: no script, drafting, schema failure, 8-gram hit, out-of-band, blocked citations, approved, 409 | `renderScriptReview` (empty / drafting / schema failure), model+page tests, `initScriptReview` conflict banner test | PASS (409 "Compare" deferred — see gaps) |
| Responsive: no horizontal scroll at 390 px, impact stacked | Chromium 1280 and 390 (`evidence/f05/*.png`); `scrollWidth == innerWidth` at both | PASS |

## Tests run (real output)

```
prettier --check .              All matched files use Prettier code style!
eslint .                        LINT_OK
tsc --noEmit -p tsconfig.json   TYPECHECK_OK
npm run build                   BUILD_OK
vitest run                      41 files / 599 tests passed
```

New files: `script-model` 15, `script-impact` 11, `script-page` 10, `script-client` 10,
`script-styles` 7 — 53 new tests; the F-04 suite (546) is unchanged and still green.
Commands were run from the worktree with `../../node_modules/.bin/{tsc,eslint,prettier,tsx,esbuild}`
(the worktree has no local `node_modules`; the parent repo's binaries are used).

Chromium (real browser, 1280×1000 and 390×844, `document.write` of the fully inlined SSR page;
the browser has no route to the dev server, so CSS/HTML are inlined):

- `evidence/f05/approved-1280.png` — approved state: record line, claims, 360 px impact column
- `evidence/f05/draft-blocked-1280.png` — C-10 block, disabled approve with `aria-describedby`
- `evidence/f05/draft-390.png` — stacked impact column, no horizontal scroll
- `evidence/f05/impact-ready-1280.png` — IP-01 ready: 4 stale rows, call counts, both commits live
- `evidence/f05/after-apply-1280.png` — after `Apply edit (no regeneration)`: rev 6, NA stale, ribbon visible

The live enhancer was also driven in Chromium with the shipped `createHttpScriptApi` against a
stubbed `fetch` (bundled with esbuild): one preview POST, then `POST …/script` and
`GET /api/videos/:id` with **no** retry POST, rail `NA` → `stale`, ribbon revealed.

## Decisions and contract gaps (for INT-01 / QA)

1. **Regeneration endpoint.** The contract has no "regenerate stale stages" route. The second
   commit saves the revision and then calls `retry.run` at the *first* stage the server reported
   invalidated (`POST /api/videos/:id/stages/:stage/retry {confirm_scope:true}`), which the
   contract summaries as retrying a "failed/stale stage with its computed scope". If B-03 exposes
   a dedicated re-run route, swap it in `ScriptApi.save`'s caller only.
2. **8-gram pass copy.** UI_SPEC's string says "the 2 stored references"; `ScriptView.eight_gram`
   exposes only `violations`, not the reference count (R-003 allows 1–5), so the panel says "a
   stored reference". Fail copy keeps the spec sentence and prints the violation labels, truncated
   at the first `:` so reference text cannot leak (R-003-3).
3. **Operator name.** `ScriptView` has no approver field; the record line prints the single seeded
   operator id `operator` (D3: one account). Ask B-13 for `approved_by` if a name is required.
4. **409 conflict.** `ConflictEnvelopeSchema` carries revisions only — no timestamp and no server
   body. The banner names both revisions, keeps the typed text, and offers "Load the saved
   revision" (re-fetches `script.get`) and "Keep my text" (re-saves against `current_revision`).
   The "Compare" action from UI_SPEC would need the server revision body; recorded as a follow-up.
5. **Claim resolution actions.** The wireframe's `attach source / reword / acknowledge` need an
   endpoint that does not exist in `contract/api.ts`; rows are rendered read-only with the exact
   status. Follow-up for the contract owner (IP-10).
6. **Schema-failure detail.** `ScriptViewSchema` carries no failing field or schema version; the
   failure panel names both as `—` and says so rather than inventing them.
7. **After a committed revision** the client reloads the page (800 ms after the announcement):
   word count, claims and the 8-gram result are server-decided and must not be re-derived in the
   browser. The rail is repainted from `video.get` *before* the reload, which is what the
   Chromium evidence captures.
8. **Stale ribbon ownership.** F-04 built the rail ribbon; F-05 supplies the post-commit repaint
   path by extracting `src/web/workspace/railDom.ts` and calling it from both enhancers, so SSE
   frames and commit refetches cannot drift.

## Not in this diff (follow-ups)

- `Compare` in the 409 banner (needs the conflict body).
- Claim resolution actions (`attach source`, `reword as non-factual`, `acknowledge`) — IP-10,
  needs contract endpoints.
- `Accept staleness` (UC-05 explicit acceptance) — belongs with the stage controls (F-06/F-08).
- INT-01 must serve `script-review.js` and the `script/*`, `workspace/railDom.js` shared modules in
  the production asset reader (the dev preview already does: `src/web/authPreview.ts`).
