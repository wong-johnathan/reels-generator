# INT-01 Integration — Conflict Log

Integration branch: `int/t_58f603ef`
Base: `196d7eb` (B-01's first commit). QA receives the exact head SHA in the handoff (it includes this log).
Scope: backend chain (B-01..B-15) + frontend chain (F-01..F-09), merged `--no-ff` in order.

Every merge is a distinct commit whose message begins `INT-01:`. The merge commits, in order:
c794914 B-12 (carries B-01..B-12), 39105dd B-05, 9f2c506 B-14 (carries B-13),
331bd9b B-15, 803a0a2 F-04 (carries F-01..F-04), 6affdc1 F-05, 4b88e0d F-06,
fdf3480 F-07, d8f9804 F-08, b5cde71 F-09, 250973a (ignore `.worktrees/`), and this log commit.

## Resolutions

### 1. B-05 research adapter — src/adapters/rate-limit.ts, rate-limit.test.ts

Sides: B-12 (HEAD) vs B-05.
Resolution: kept HEAD (B-12). Rationale: B-12 is the later, already-integrated backend
base; the rate-limit surface is identical in shape and B-05 adds no new behaviour there.

### 2. B-14 series CRUD — package.json, package-lock.json

Sides: B-12/B-14 dependency sets.
Resolution: unified union. deps: bullmq, hash-wasm, ioredis, pg, zod; devDeps:
@eslint/js, @types/node, @types/pg, eslint, prettier, tsx, typescript,
typescript-eslint, vitest, yaml. Lock regenerated/resolved to valid JSON.

### 3. B-15 per-scene replace — src/db/repositories/assets.ts

Sides: HEAD exports vs B-15 tail (`B-15 — per-scene replace (US-020, RULINGS L-2)`).
Resolution: kept HEAD file up to the B-15 marker, appended the B-15 tail (the one
path that may move an asset + the replace query). No textual conflict survived.

### 4. F-05 script review — no conflict (clean merge onto F-04).

### 5. F-06 storyboard review + scene grid — src/web/app.ts, authPreview.ts, embedded.ts, workspace.css

Sides: F-05 (script) vs F-06 (scenes), both off F-04.
Resolution: F-06 taken as base (`--theirs`), then F-05's script-review handling
re-applied on top (client module `script-review` + shared `script/impact.js`,
`script/model.js`, `workspace/railDom.js`). workspace.css combined (F-05 append

- F-06 mid-file hunk), `embedded.ts` regenerated from sources.

### 6. F-07 narration + timing tab — src/web/app.ts, authPreview.ts

Sides: F-05+F-06 (HEAD) vs F-07 (narration), both off F-04.
Resolution: kept HEAD's method-aware videoRoutes, added F-07's narration pieces:
`narration?: NarrationGateway`, `/assets/narration/` shared root, `isAudioCommit`
(POST audio/rerun|accept), narration tab, CSP `media-src 'self'`. F-07's segment
limit (>3) discarded in favour of HEAD's (>4), which already accommodates the
3-segment audio route.

### 7. F-08 render + QC panel — app.ts, authPreview.ts, embed.ts, embedded.ts, embedded.test.ts, generate-embedded-css.ts

Sides: F-05..F-07 (HEAD) vs F-08 (render/QC).
Resolution: kept HEAD, added F-08's `render?: RenderGateway`, `isRenderCommit`
(POST render/approve), render tab, `bodyBytes?: Uint8Array` on WebResponse.
CSS unified (narration.css + quality.css). Binary-mechanism decision: F-07 served
audio as a latin1 string via `body`; F-08 served render stand-ins as `Uint8Array`
via `bodyBytes`. Kept BOTH — the server writes `bodyBytes` when present, and
special-cases `audio/*` content-type through `Buffer.from(body, 'latin1')`.

### 8. F-09 export package + health/settings — app.ts, authPreview.ts, render/workspace.ts, embed.ts, embedded.ts, embedded.test.ts, generate-embedded-css.ts

Sides: F-05..F-08 (HEAD) vs F-09 (ops/export/settings), F-09 off F-04.
Resolution: kept HEAD, added F-09's `exportPackage?`/`ops?` gates, top-level
`/health` + `/settings` routes, export tab + POST build, health/settings pages,
`operations.css` (9th stylesheet). render/workspace.ts: F-09's `options.scripts ??
WORKSPACE_SCRIPTS` would DROP the workspace module on tabs that pass extra scripts
(narration/scene-grid); kept F-06's `[...WORKSPACE_SCRIPTS, ...(options.scripts ??
[])]`. TabKey `export` already present via auto-merge; `settings` is a top-level
page, not a tab.

## Suite results (real output)

- `npm run lint` — PASS (eslint ., 0 problems; `.worktrees/**` added to ignores — see below)
- `npm run typecheck` (tsc -p tsconfig.json) — PASS
- `npm run build` (tsc -p tsconfig.build.json) — PASS
- `npm run test` (no DB) — 118 files, 1478 tests, 1328 passed / 150 skipped (DB gated)
- `TEST_DATABASE_URL=postgresql://reels@127.0.0.1:55432/reels_test npm run test` —
  **127 files passed, 1613 tests passed, 0 failed, 0 skipped** (628.73s). Postgres 16
  with pgcrypto + vector, fakes only — no paid provider call.

No tests quarantined. The 150 skips are the DB-backed schema tests, which run and
pass when `TEST_DATABASE_URL` is supplied (see final run above).

## Non-conflict changes

- `.gitignore` + `eslint.config.mjs`: ignore `.worktrees/**` — the dispatcher's
  parallel worktrees (22 sibling tasks) sat inside the repo and broke `eslint .`.
  Not application code; this is the only housekeeping change beyond the merges.

## Not done (per rules)

- No merge to `main`, no push, no deploy. Integration lives on `int/t_58f603ef`.

# INT-D6R Integration — Conflict Log

Integration branch: `int/remed-qa-rework`
Base: `993203809309893b77643b71b42004f043a20841` (int/remed-qa tip, D1..D7 remediation head)
Scope: D6-R rework lanes — timeout-disclosure fix, scene focus, shell quality, combined browser gate.

## Lanes integrated (cherry-picked `-x`, in order)

- AX25/DB (t_5163bfb4): NO commit. Contract decision (a) — retained-record facts plus explicit
  image/narration disclaimer; verified unchanged at base 9932038. Nothing to integrate.
- T1/D6-R (t_45a38bd6): `85a8746a29ff0e48cfe585150909cfaf902d6d70` -> `04f8aef` (batchDetail.ts,
  batch-detail.test.ts, batch-detail.browser.mjs)
- T2 (t_4e3eca9c): `81e5102f3583db84fef8fac4a59f79e805de02d1` -> `0d8e452` (sceneGrid.ts,
  workspace.css, embedded.ts, scene-grid-client.test.ts, scene-remediation.browser.mjs)
- T3 (t_84a48f62): `6ac523558f2b9a8d9860dcba103de5c6b6850c03` -> `f02f9e6` (shell-quality.browser.mjs)
- T4 (t_3e0e71e9): `e97dc53700815966a28247f6a738b498773ec0c3` -> `2026f1e` (package.json `test:browser`,
  scripts/run-browser-gate.mjs, docs/BROWSER_GATE.md)

## Resolutions

Zero manual conflicts. All four lane commits are children of base 9932038 and touch disjoint files
(T1: batch detail renderer/tests/harness; T2: scene grid + workspace CSS + embedded mirror;
T3: shell-quality harness; T4: package.json + runner + docs). No authored-source auto-merge.

embedded.ts: after all lanes landed, regenerated once from the combined 9 authored stylesheets via
`tsx scripts/generate-embedded-css.ts` — ZERO drift (`git status` clean), so T2's mirror already
equals the true combined bundle and no single branch's mirror was adopted.

UI_AUDIT.md: versioned the QA-authored scoped audit (t_e2605f0d) at docs/UI_AUDIT.md. Content is the
QA's independent artifact, prettier-formatted only; the exact audited SHA 9932038, the FAIL /
NOT-RELEASE-READY verdict and the D6-R limitation are preserved. No global-compliance reassertion,
no silent overwrite of the QA's limitations.

## Suite results (real output)

- `env -u TEST_DATABASE_URL npm run verify` — GREEN (lint + format:check + typecheck + test + build):
  1753 passed / 238 DB skipped; 140 files passed / 31 skipped.
- `npm run test:browser` (build + combined gate, explicit PLAYWRIGHT_MODULE + CHROMIUM_PATH) — GREEN:
  4 harnesses — scene-remediation 124, batch-detail 70, shell-quality 98, surface-followup 48;
  Chromium 153.0.8010.12.

## Runtime / DB status

- Host Node v26.5.1 (engines want >=20.11 <21). The Node20.20.2 official tarball is not available
  in this environment (previously pruned), so the gate ran on the host runtime — a named limitation,
  not a supported-runtime claim.
- TEST_DATABASE_URL unset: 238 DB-dependent tests skipped (canonical env matching all lanes).
  AX25 contract is a named limitation (retained-record facts + explicit image/narration disclaimer);
  no DB qualification is claimed here.

## Not done (per rules)

- No merge to main, no push, no deploy. Integration lives on `int/remed-qa-rework`.
