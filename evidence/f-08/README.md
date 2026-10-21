# F-08 / S-15 — Render & QC (US-024, US-025, US-028 final-approve gate)

Branch `feat/t_263157b2`, worktree `.worktrees/t_263157b2`, base `38df2b6`.
Everything below is real output from this worktree on 2026-10-21 (UTC).

## What was built

- `src/web/quality/model.ts` — pure view model. One catalogue entry per R-010-2…7
  (QC-2…QC-7), status merge of contract `RenderView.qc.checks` against the six
  requirements (`pass` / `fail` / `missing`), a single `qcComplete`/`qcAllPass`
  gate, state derivation (empty, blocked, running, failed, qc_running, qc_failed,
  stale, awaiting_approval, approved), stats rows, approval gate + reasons, text
  alternative, return links.
- `src/web/quality/gateway.ts` — `RenderGateway` (`get`, `revision`, `approve`),
  `RenderNotFoundError`, `RenderRefusedError`, and a deterministic in-memory
  gateway with revision fencing and one approval per render.
- `src/web/quality/notice.ts` — post/prepare notice tokens (`approved`,
  `refused`, `not_sent`).
- `src/web/render/quality.ts` — server-rendered panel: state chip, summary,
  player with poster + captions track + one 5 % safe-area rectangle, stats list,
  six-row QC table (measured / expected / chip), approval footer with gate line,
  form (hidden revision + optional ≤2000-char note) or disabled control with a
  stated reason, named-stage return links, monitoring note outside the hidden
  footer.
- `src/web/styles/quality.css` (+ embedded bundle) — tokens only, two-column
  layout ≥1024, single column 768–1023, approval/return hidden ≤767 with the
  monitoring note kept visible, 44 px targets, tabular numbers, structural
  (not colour-only) row status, focus ring on the scrollable table region.
- `src/web/app.ts` — `deps.render`, `POST /videos/:id/render/approve`
  (303 → `?notice=approved`; 409 refusals; 422 missing revision; 400 long note;
  503 unmounted), CSP `media-src 'self'`, F-04 summary fallback when no gateway.
- `src/web/authPreview.ts` — preview wiring: render gateway, revision 1,
  `/asset/<id>/full` for the video/poster/captions, lazily encoded stand-in MP4
  (ffmpeg, cached in memory) and a `PREVIEW_QC=fail` seed for the blocked state.
- `contract/mock/fixtures.ts` — the render fixture now reports all six checks,
  QC-3 is the audio-stream identity/duration check (it previously carried the
  duration-only payload under the requirement id, so QC-3 and QC-6 disagreed
  with PRD R-010), and poster/SRT/VTT assets carry their own asset ids in their
  URLs instead of all pointing at the video asset.

## Verification

`npm run format:check` · `npm run lint` · `npm run typecheck` · `npm run build`
all exit 0. `npm test` → **40 files, 616 tests passed** (546 at base; 69 new in
`tests/web/quality-model.test.ts` 26, `tests/web/quality-page.test.ts` 17,
`tests/web/app-quality.test.ts` 19, `tests/web/quality-styles.test.ts` 7, plus
one extended embedded-stylesheet case).

New tests cover: the six requirements and their numbers; missing/failing checks
and extra checks; every panel state; approval gating (QC fail, missing checks,
no video, stale render, unwired revision) and every refusal path; POST happy
path with revision + note; 409/422/400/503; 404/405 edges; CSP; the six rows in
DOM order with measured values; single safe-area rectangle; captions track and
text alternative; responsive breakpoints; structural row status; 44 px targets.

## Browser evidence (real Chromium, preview server)

`PREVIEW_PORT=4077 … tsx src/web/authPreview.ts` (and `4078` with
`PREVIEW_QC=fail`), signed in as `operator`/`preview`.

- `render-1440-awaiting.png` (1440 px): state `awaiting_approval`, summary
  `1080×1920 · 30 fps · 75.1 s · 6 of 6 checks passing`, six rows with measured
  values, exactly one `[data-safe-area]` node, video `readyState=4`,
  `1080×1920`, duration 75.1 s, one captions track, form posts to
  `/videos/2222…/render/approve` with `revision=1`, no page-level horizontal
  scroll (1440/1440), AX tree exposes the table caption, 7 rows and each cell.
- `render-900-awaiting.png` (900 px): grid collapses to one 861 px column,
  approval visible, monitoring note hidden, no horizontal scroll (885/885).
- `render-390-monitoring.png` (390 px): approval and return block `display:none`,
  monitoring note visible at the end of the panel, six rows still readable in
  the horizontally scrollable table region.
- `render-1440-approved.png`: after submitting the form with a note →
  `303 …?notice=approved`, success notice, `approved` state, `Final approval
recorded 2026-10-21T05:24:14Z. Export is enabled; nothing else changed.`,
  no form, `Open Export → /videos/2222…/export`.
- `render-1440-qc-failed.png` (4078, `PREVIEW_QC=fail`): state `qc_failed`,
  `QC-6 · R-010-6 · Captions inside the 5 % safe area — measured 94.2 %,
expected 100.0 %`, row chip `FAIL`, `Approve final` disabled
  (`aria-disabled=true`) with the reason naming QC-6/R-010-6, no form.

AX spot-check (CDP `Accessibility.getFullAXTree`): status notice, stage rail,
figure "OUTPUT", region "QUALITY CHECKS", table named by its caption, 7 rows,
cells `1080×1920 @ 30 fps` / `100.0 %` / `PASS`, media controls play/mute/full
screen. The table region is labelled "Quality checks results" so the two
regions do not share a name.

## Contract gaps raised (comments on this card, not silently decided)

1. `render.get` exposes no revision, but `render.approve` requires
   `{ revision ≥ 1 }`. The panel sends the revision the server read at render
   time; if no revision can be sourced the approve control is replaced by a
   stated disabled reason ("cannot supply the revision…") and nothing is sent.
2. R-005-4 names a stage on rejection, but the contract only has an approve
   decision (`ApprovalRequest { revision, note }`, `render.approve`). The return
   links open the named stage and record nothing; the copy says so rather than
   implying a recorded rejection.
3. Fixture/PRD mismatch on QC coverage (three checks vs six, QC-3 mislabelled);
   corrected in `contract/mock/fixtures.ts`, schema untouched.

## Deviations / follow-ups

- Monitoring note copy says "768 px or wider". UI_SPEC §9.3 still says 1024 px,
  RULINGS §narrowing allows final approval from 768 px; the copy follows the
  ruling so it does not claim the control is unavailable at widths where it is.
- Preview media is a stand-in: 75.1 s 1080×1920 ffmpeg colour clip + SVG poster
  - VTT/SRT cues. Not product output; the real assets arrive with INT-01.
- At 390 px the F-04 shell itself is 433 px wide on every tab (Script tab:
  434/390), so the page scrolls horizontally. Pre-existing, not introduced here;
  left for F-04.
- Shared/likely-conflict files: `src/web/styles/embed.ts`,
  `src/web/styles/embedded.ts`, `tests/web/embedded.test.ts`, `src/web/app.ts`,
  `src/web/render/workspace.ts`, `contract/mock/fixtures.ts` (also touched by
  F-07/F-09). The embedded bundle needed the same multiline formatting F-07
  applied so `format:check` stays green with seven stylesheets.
