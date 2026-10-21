# F-09 / S-16 Export & provenance, S-19 Failures & health, S-21 Settings

Branch `feat/t_d46e306d`, worktree `.worktrees/t_d46e306d`, base `38df2b6`.
Every command and capture below was run in this worktree on 2026-10-21 (UTC).

## What was built

### S-16 — Export & provenance (US-026, R-014-1, R-002-4, R-013-1)
- `src/web/provenance/model.ts` — pure view model: package state
  (`not_eligible` / `not_built` / `building` / `built` / `stale` / `failed` /
  `missing_files` / `blocked`), the five-file row list with kind, size, full
  SHA-256 and URL, the eleven per-stage pins (package pin preferred, current
  video pin fallback, source labelled), pin summary (`v3` when uniform,
  `v2 ×3 · v3 ×8` when mixed), `v5 ×…` counts, download/build enablement and a
  written reason for every disabled control.
- `src/web/provenance/gateway.ts` — `ExportGateway` (`get`, optional `build`),
  `ExportNotFoundError`, `ExportRefusedError`, deterministic in-memory gateway.
  `build` refuses a blocked or fileless export instead of inventing files.
- `src/web/provenance/notice.ts` — `?notice=built` / refusal tokens.
- `src/web/render/export.ts` — server-rendered panel: state chip, five-part
  summary lines, package-contents table, stacked file list below 768 px,
  44 px download summary with per-file links, pins table with version ids in a
  details block, source manifest (collapsed JSON), build/rebuild form or a
  disabled control with its reason, 768 px band note.
- `src/web/app.ts` — `deps.exportPackage`; `GET /videos/:id/export` renders the
  panel on the Export tab (F-04 stage summaries when no gateway);
  `POST /videos/:id/export` → 303 `?notice=built`, 409 on refusal, 503 JSON
  when the gateway or its `build` seam is not mounted; POST elsewhere → 405.

### S-19 — Failures & health (US-011/012/013, R-008-3, R-011-2, R-012-4, R-018)
- `src/web/health/model.ts` — provider rows (key presence, env-var name,
  qualification, idempotency, note, one structural state), qualification lines
  (`PASS <time>` / `NOT RUN`), queue counts, disk percent + headroom warning,
  migration status, attempt-row models (stage label, attempt n of m, request id,
  prompt hash, idempotency, error class + HTTP status, backoff, charge word) and
  `attemptsView` (newest first, stage filter, 50-row page, honest empty/error/
  limit lines). `chargeFor` maps `timed_out` / `unknown_charge` / `unknown`
  to **unknown charge** even when `charge_status` says `unbilled` (R-012-4).
- `src/web/health/gateway.ts` — `OpsGateway` (`health`, `settings`, `attempts`)
  with an in-memory seed that filters/sorts/limits exactly like the real query.
- `src/web/render/health.ts` — five-part degraded block (cause, blocked, still
  works, system, next action), ready state, provider grid, qualification chips,
  queue/disk/migration list with a `<progress>` text equivalent, attempt table
  (10 columns, no billed-units or totals), stage filter form, video picker from
  `overview.attention`, captions and region labels.
- `src/web/app.ts` — `deps.ops`; `GET /health` (503 with a named unavailable
  section when absent/throwing), `?video=` UUID and `?stage=` validated; the
  shell degraded banner is suppressed on `/health` because S-19 owns the block.

### S-21 — Settings (US-004, US-012, R-015-5, C-19)
- `src/web/settings/model.ts` + `src/web/render/settings.ts` — read-only table of
  provider, key presence + env-var name, qualification, idempotency and note;
  `N of M keys present. Absent: … Set it/them in .env and restart.`; explicit
  "values are never read back". No input, form or secret value exists on the page.
- `src/web/app.ts` — `GET /settings` (503 when ops is absent/throwing).

### Styling and wiring
- `src/web/styles/operations.css` — tokens only, no raw colour; export grid
  two-column ≥1024 and single below; provider grid 3 columns ≥1200, 2 at
  768–1199, 1 below; 44 px file rows and download targets, 36 px attempt rows;
  dense tables scroll inside labelled `tabindex=0` regions with sticky headers;
  package table swaps to a stacked list ≤767; pins table keeps its columns
  ≤767 by scrolling; unknown-charge rows get a structural left bar + tint;
  disk meter 2 px with `::-webkit-progress-value` / `::-moz-progress-bar`;
  visible token focus rings; reduced-motion opt-out.
- `src/web/styles/embed.ts` + `scripts/generate-embedded-css.ts` +
  `src/web/styles/embedded.ts` — operations.css added as the seventh layer.
- `src/web/authPreview.ts` — export + ops gateways, three deterministic attempt
  rows (newest is a timeout with `charge_status: pending`), and seeds:
  `PREVIEW_EXPORT=built|unbuilt`, `PREVIEW_HEALTH=ready`.
- `contract/mock/fixtures.ts` — `health.report.disk.headroom_ok` is now `false`:
  38 GB free of 220 GB is 17 % and the report already called the disk degraded;
  the old `true` made the disk row contradict its own degraded component.

## Verification (real output)

```
npm run format:check  → All matched files use Prettier code style!
npm run lint          → eslint . (exit 0)
npm run typecheck     → tsc -p tsconfig.json (exit 0)
npm test              → 45 files, 681 tests passed (547 before this card's tests)
npm run build         → tsc -p tsconfig.build.json (exit 0)
```

New suites (all green): `export-model` 20, `export-page` 23, `health-model` 24,
`health-page` 14, `settings-page` 8, `app-ops` 21, `operations-styles` 11,
`operations-a11y` 11, `format` 3, plus the embedded-stylesheet guard extended to
seven layers. They cover every panel state, all refused/missing/unmounted route
paths, the exact eligibility and absent-key copy, R-012-4 charge handling,
newest-first + 50-row + stage filtering, heading order, table captions, labelled
filter, discernible download names, structural (non-colour) state, and the
responsive swaps.

## Browser evidence (real Chromium against the preview server)

```
PREVIEW_PORT=4710 PREVIEW_EXPORT=built tsx src/web/authPreview.ts   # built package
PREVIEW_PORT=4710 tsx src/web/authPreview.ts                        # default: not eligible
```

Signed in as the repository's demo operator (`operator` / `preview`), then:

- `export-built-1440.png` — package ready: 5 files, sizes, full hashes, five
  downloads, eleven pins, manifest, version ids.
- `export-built-768.png` — single-column layout, build control hidden, band note.
- `export-built-390.png` — stacked file rows with 44 px Download buttons; pins
  table scrolls inside its region.
- `export-not-eligible-1440.png` / `-390.png` — disabled download + build with
  the exact reason, expected five kinds, "Open Render and review final approval".
- `health-attempts-1440.png` — degraded five-part block, three providers, disk
  meter, and Video 18's three attempts with the timeout reading
  **unknown charge** (left bar, not colour alone).
- `health-390.png`, `settings-1440.png`, `settings-390.png` — no page-level
  horizontal overflow at 390 (document scrollWidth == innerWidth); dense tables
  scroll inside their own labelled regions.

## Gaps recorded, not papered over

- `export.get` carries no error detail; a failed build therefore says the failing
  step is not reported rather than inventing one, and `export.build` is the only
  build affordance (there is no queue/position data for a build).
- The attempt row has no `billed_units` field, so no units column is shown and no
  totals are computed (D2); the page states both.
- `/health` filtering is a plain GET form (no client JS), so the URL is the state.
- The workspace's sticky footer overlays long pages while scrolling — that is the
  F-04 shell behaviour, unchanged here.
