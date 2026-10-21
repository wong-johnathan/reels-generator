# F-03 — Series list + editor (US-008, US-010)

Branch: `feat/t_eef060d2` · worktree `.worktrees/t_eef060d2`
Base: `5aca3b1` (F-02 evidence commit; F-01 `89cef74` in history)
Task: t_eef060d2 · LEAD_PLAN rev 1.0 §5 F-03 · owns S-03, S-04, IP-02 · prereq F-01

**Signal (verbatim):** editing a series shows the version-mint commit and
"existing projects/assets untouched" (R-002-3).

## 1. Signal evidence

Everything below was produced by real execution, not inspection.

| Check                                                | Command / method                                                                                                | Result                                                                                                                                                                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The commit panel names the minted version            | `GET /series/:id` (Chromium, 1440)                                                                              | PASS — lead `Saving mints v4.`, `<strong data-commit-version>v4</strong>`                                                                                                                             |
| It says existing work is untouched                   | same render                                                                                                     | PASS — `Nothing is regenerated. 1 open batch keeps its current pins; stages that have not started will use v4 when they start. v3 stays immutable. Existing projects and their assets are untouched.` |
| The save actually mints                              | live edit `voice_config.speed=1.2`, click Save, Chromium                                                        | PASS — 303 to `?saved=4`, chip `current version v4`, banner `Saved as v4`, polite region announces `Saved as v4. Existing projects and their assets are untouched.`                                   |
| Existing projects and per-stage pins are not touched | `tests/web/app-series.test.ts` › "mints v4 on save, redirects, and leaves every existing project pin untouched" | PASS — `projectsOf()` deep-equals the pre-save snapshot, pins stay `SB/IM/NA/TC = 3`; `versionsOf()` keeps v3 unchanged                                                                               |
| The previous snapshot stays immutable                | `tests/web/app-series.test.ts` › "never mutates the previous version snapshot (v3 stays immutable)"             | PASS                                                                                                                                                                                                  |
| The live panel recomputes while typing               | Chromium: set field + `input` event                                                                             | PASS — button `Save as v4` enabled, row `data-changed="true"`, mark visible, summary `Speed: 1 → 1.2`, reason hidden                                                                                  |
| No toast is used for the save (IP-02)                | render + client modules                                                                                         | PASS — no toast component exists; the version chip and the inline banner are the record                                                                                                               |
| Unknown series → SY-3                                | `GET /series/9999…`                                                                                             | PASS — 404 page                                                                                                                                                                                       |
| Unauthenticated → login, destination preserved       | `tests/web/app-series.test.ts` › access control                                                                 | PASS — 303 `/login?required=1&next=/series…` for all three routes                                                                                                                                     |

Screenshots in this directory:

- `t_eef060d2-list-1440.png`, `-list-1024.png`, `-list-900.png`, `-list-390.png`, `-list-320.png`
- `t_eef060d2-create-1440.png` (first save: "This creates the series and mints v1.", nothing to invalidate)
- `t_eef060d2-editor-saved-1440.png` (v6 minted, chip updated, announcement)
- `t_eef060d2-editor-mode-1440.png` (Mode block: factual/creative with consequences)
- `t_eef060d2-editor-390.png`, `-editor-320.png`
- `t_eef060d2-conflict-1440.png` (IP-09 409: current revision, your revision, typed text preserved)

## 2. Acceptance mapping

| Source                             | Requirement                                                                    | Where it is satisfied                                                                                                                                 | Evidence                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| US-008                             | See every series; create one                                                   | S-03 `/series` (native table at ≥768, labelled card list below), empty state `No series yet.` + `Create series`, `/series/new` five-block create form | `series-list.test.ts` (13), `app-series.test.ts` create block, screenshots          |
| US-010                             | Edit the profile; commit as a new immutable version                            | S-04 `/series/:id`; POST mints `current_version + 1`, appends an immutable `series_version`, bumps `revision`                                         | `series-commit.test.ts` (14), `app-series.test.ts` (19), `preview.test.ts`          |
| R-001-1                            | A series is the unit of profile + voice + art                                  | the five blocks from UX A-4 are exactly the editable profile leaves                                                                                   | `series-fields.test.ts` › "covers every editable profile leaf the contract exposes" |
| R-001-3                            | Archived series accepts no edit/batch and says so                              | read-only render + 409 on POST + `Archived series cannot be edited or used for new batches.`                                                          | `series-editor.test.ts`, `app-series.test.ts` archived case                         |
| R-001-4                            | Editing never mutates an existing project                                      | gateway keeps `projects` untouched across a mint                                                                                                      | `app-series.test.ts` pin test                                                       |
| R-002-1                            | Monotonic version per edit; old versions immutable                             | `commitState` next version; `series_version` append-only in the gateway and the contract shape                                                        | `series-commit.test.ts`, gateway test                                               |
| R-002-2/4                          | Pins are per stage and inspectable                                             | S-04 header states open batches and that stages not yet started will use the new version; pins belong to S-16 (out of this card)                      | commit panel copy                                                                   |
| R-002-3                            | A version change regenerates no existing asset                                 | panel says `Nothing is regenerated` + `Existing projects and their assets are untouched`; no regeneration path is reachable from S-04                 | `series-commit.test.ts` › "never uses invalidation language"; browser flow          |
| R-009-1                            | Duration 10–180 s                                                              | field bounds + validation both client and server                                                                                                      | `series-fields.test.ts` duration tests                                              |
| R-027-1                            | Explicit factual/creative, no silent default                                   | radio group, per-mode consequence copy, create blocked without a mode                                                                                 | `series-editor.test.ts` mode tests                                                  |
| IP-02                              | Version mint, not an invalidation                                              | `series/commit.ts` — one source for the panel, the button label and the announcement                                                                  | `series-commit.test.ts`                                                             |
| IP-09                              | 409 conflict preserves typed text                                              | inline banner + `revision` re-armed to the current revision, `Discard mine`                                                                           | `app-series.test.ts` conflict test, conflict screenshot                             |
| UX A-4 / A-5 / D-2 / D-3           | five blocks; v1 first save; per-field changed marks; profile-terms commit copy | `series/fields.ts` + renderer                                                                                                                         | `series-editor.test.ts`, `series-fields.test.ts`                                    |
| UI_SPEC §5 UC-17/UC-18/UC-19/UC-20 | table/card, buttons, fields, native selects                                    | renderers + `series.css` (44 px rows, 28 px sticky header, 32 px controls, 44 px primary commit)                                                      | `series-styles.test.ts` (14)                                                        |
| UI_SPEC §7.2 / AX-14               | no page-level horizontal scroll; card list ≤767                                | measured 0 overflow at 1440/1024/900/390/320 on both surfaces                                                                                         | screenshots + Chromium measurements                                                 |
| UI_SPEC §8.1/§8.5                  | labelled controls, `aria-describedby`, inline errors, polite announcement      | renderer + `client/seriesEditor.ts` writing `#live-status`                                                                                            | `series-editor.test.ts`, `series-editor-client.test.ts` (10)                        |
| UI_SPEC §9.1                       | no currency/cost/publishing language                                           | string scan over both surfaces                                                                                                                        | `series-list.test.ts` › language test                                               |
| UI_SPEC §6.1/CSP                   | no inline style, script or handler                                             | renderers emit classes only                                                                                                                           | both surfaces' CSP tests                                                            |

## 3. Tests run

`npm run lint` → clean
`npm run typecheck` (`tsc -p tsconfig.json`) → clean
`npm run test` (`vitest run`) → 30 files, 455 tests, all passing
`npm run build` (`tsc -p tsconfig.build.json`) → clean
`prettier --check .` → all matched files use Prettier style

New/changed suites: `app-series` (19), `series-editor` (21), `series-commit` (14),
`series-fields` (23), `series-list` (13), `series-styles` (14), `series-editor-client` (10).

Two regressions were caught by mutation during this run and both new tests fail
without their fix:

- a stray `</fieldset>` closed the Mode fieldset early in a real browser
  (`series-editor` › "closes every fieldset it opens…");
- the 503 list page was a bare fragment without the shell
  (`app-series` › 503 case asserts `<!doctype html>` and `<main id="main">`).

## 4. Browser checks (Chromium via CDP, real HTTP against `createWebApp`)

Run against `createAuthPreviewHandler` (the same handler INT-01 mounts), port 4031,
demo session, in-memory gateway. No network/provider call, no paid provider.

- sign-in → `/series` 1 row, `0` overflow at 1440
- row click → S-04, enhancer loaded (`series-editor.js` + `/assets/series/commit.js`,
  `/assets/series/fields.js`, `/assets/format.js` all 200)
- live edit enables the mint; save → `?saved=4`; chip `v4`; live region announced
- stale-revision POST → 409 banner with `revision 6`, typed text preserved, Save as v6 live
- keyboard: skip link → status → rail → breadcrumbs → first field; focus ring 2 px solid
- card list at 390/320 with labelled cells, no clipping

## 5. Limitations and follow-ups

1. **INT-01 must supply `assets.readSharedModule`.** The S-04 enhancer imports the
   server's own rules (`series/commit.js`, `series/fields.js`, `format.js`); the app
   serves them at `/assets/series/<name>.js` and `/assets/format.js` but only when the
   dependency is provided. Without it the enhancer 404s and Save stays disabled
   (server render says `No changes`). The dist reader is one line:
   `path => readFileSync(new URL('./web/' + path, distUrl), 'utf8')` with the existing
   allowlist. This is the only blocker between this card and a working S-04 in
   production.
2. **CSRF** — the series POSTs carry no synchroniser token. Same B-13-owned gap F-02
   recorded; release-gate item.
3. **IP-09 Compare dialog** not built. The banner offers Discard mine and a re-save on
   the current revision ("Keep my text"); the field-level read-only compare is Milestone
   B surface work. No lost update: the stale form's text survives the 409.
4. **Server-side `in_flight_videos`** does not exist in the contract. The panel falls
   back to `series.in_flight_batches` (the count the contract exposes) and uses the
   video count whenever an adapter can supply it, so C-08's "30 in-flight videos" is
   rendered as "1 open batch" today. Raised as a contract gap for INT-01.
5. **≤767 editing.** UI_SPEC §7.1/§7.2 make ≤767 read-only for gate approvals, replace,
   reorder, retry, delete and cleanup; a series profile edit is none of those, so S-04
   stays editable down to 320 px (with the card/stacked layout). If the ruling is that
   "no editing below 768" covers profile edits too, the panel needs the read-only state
   at ≤767 — a copy/CSS change, no route change.
6. **Duplicate and archive actions** (UX S-03 row, milestone B) are absent rather than
   disabled, per the "no feature teaser" rule.
