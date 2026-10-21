# S-14 — Narration & timing (US-021, US-022; R-009-3, R-009-4)

Owner: F-07 · Branch `feat/t_62fc8fe1` · Base `38df2b6`

## What ships

The video workspace's **Audio** tab now renders the narration take instead of the
generic stage summary:

- **Audio player** — native `<audio controls preload="metadata">`, never autoplays,
  accessible name carries the duration ("Narration, 75.1 seconds"), a mono
  `mm:ss.d / total` transport readout, and a "Transcript — N words with timings"
  in-page link to the table.
- **Word timings** — a real `<table>` with `<caption>`, `scope="col"` headers and
  `data-word-start/end` on rows; rows highlight as the audio plays
  (`data-active` + `aria-current="true"`) and clicking a row seeks to that word.
- **Duration vs target** — actual / target / band / tolerance / deviation, with
  the tolerance sentence explaining a clamp ("clamped to at least/at most ±X s"),
  and a within/outside verdict.
- **Alignment provenance** — provider, model, request id, asset id, sha256, size,
  pin and creation time, so a take is auditable from the page.
- **Accept timing** — posts `alignment_id` to `/videos/:id/audio/accept` and
  redirects to `?notice=accepted`. **Disabled and explained in every build today**
  because `audio.get` exposes no alignment id (see Gaps).
- **Re-run narration** — a `<details>` disclosure carrying the spend line
  (`1 TTS call`, everything else reused), an optional reason (≤500 chars) and a
  409/503-aware failure path. Posts to `/videos/:id/audio/rerun`.
- **States** — `ready`, `out_of_band`, `stale`, `running`, `failed`, `blocked`,
  `empty`, each with its own heading, chip, summary and body copy; no fabricated
  audio or timings in the non-take states.

Progressive enhancement (`src/web/client/narration.ts`) does the playback
highlighting, click-to-seek and async form submission; with JavaScript off the
page still renders, the player still plays and the forms still post.

## Files

New:

- `src/web/narration/model.ts` — view model (state, band, tolerance, words, accept/re-run affordances)
- `src/web/narration/gateway.ts` — `audio.get` / `audio.rerun` / `audio.accept` + in-memory twin
- `src/web/narration/notice.ts` — `?notice=` token → notice copy
- `src/web/render/narration.ts` — panel renderer
- `src/web/client/narration.ts` — progressive enhancement
- `src/web/styles/narration.css` — panel styles (generated into `embedded.ts`)
- `tests/web/narration-model.test.ts`, `narration-page.test.ts`, `narration-client.test.ts`, `narration-styles.test.ts`, `app-narration.test.ts`

Modified:

- `src/web/app.ts` — audio routes, POST commits, CSP `media-src`, scripts, tab guard
- `src/web/render/workspace.ts` — `renderWorkspace(detail, tab, options)` seam for a prebuilt panel
- `src/web/authPreview.ts` — S-14 demo gateway + session-guarded, range-capable silent WAV at the fixture asset URL
- `src/web/preview.ts` — CSP `media-src`
- `scripts/generate-embedded-css.ts`, `src/web/styles/embed.ts`, `src/web/styles/embedded.ts` — narration.css in the bundle
- `tests/web/auth-preview.test.ts`, `embedded.test.ts`, `preview.test.ts`

## Contract alignment

- Reads `audio.get` (`NarrationViewSchema`), posts `audio.rerun` /
  `audio.accept` with `{ alignment_id }` (contract/api.ts:1064).
- Duration band, tolerance and deviation come from the payload; nothing is
  recomputed client-side except the ±% label and the clamp wording.
- Word timings validate monotonic non-overlap and are dropped with a visible
  count when a row is malformed, rather than silently mis-highlighting.

## Gaps and rulings carried forward

- **No alignment id in `audio.get` (S-14-1).** The accept control is rendered
  disabled with the exact reason, never faked. `tests/web/narration-page.test.ts`
  and `app-narration.test.ts` pin that behaviour; when the contract adds
  `alignment.id`, pass it through `alignmentId` and the control wires up.
- The preview serves a **silent WAV** generated at the fixture duration so
  playback, seeking and word-following can be exercised without a TTS provider.
  It sits behind the same session guard as the workspace and supports byte
  ranges; production assets stay behind INT-01's proxy.

## Verification (this worktree)

```
vitest run              41 files, 621 tests passed
tsc -p tsconfig.json    clean
tsc -p tsconfig.build.json  clean
eslint .                clean
prettier --check        clean (touched files)
```

Browser checks against `authPreview` (desktop 1280, review-lite 900, phone 390):

| Check                                     | Result                                                                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Panel renders take with band + provenance | yes — screenshot `narration-1280.png`                                                                                                                            |
| `<audio>` duration from real bytes        | 75.1 s, `readyState 4`                                                                                                                                           |
| Play via native control                   | `currentTime` advances, no autoplay before the click                                                                                                             |
| Word highlight follows playback           | last started word stays active between words (`aria-current` set)                                                                                                |
| Click a word row                          | seeks (`0.22 s`), highlight + transport readout move (`00:00.2`)                                                                                                 |
| Re-run disclosure                         | scope + reason field + 44 px confirm, screenshot `narration-1280-rerun.png`                                                                                      |
| Re-run POST                               | redirects to `?notice=rerun-queued`, page flips to `running` with "Already running" guard — `narration-1280-running.png`                                         |
| 900 px                                    | single column, accept visible (spec: approvals available at 768–1023)                                                                                            |
| 390 px                                    | single column, no horizontal scroll, accept/re-run absent, "Approvals need a screen 1024 px or wider" line shown — `narration-390.png`, `narration-390-note.png` |
| A11y                                      | `role="status"` notices, table caption, `scope="col"`, audio label, disabled controls keep their reason text                                                     |
