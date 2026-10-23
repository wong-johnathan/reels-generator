# F-UP-C1T2: copy provenance and required browser gate

## Copy decision applied

Source: owner decision recorded by coordinator on DECIDE-C1 task `t_6b2c1165`, comment created_at `1792757842` and completion created_at `1792757873` (canonical_ui_spec_copy). This document is an implementation provenance snapshot, not a new approval or an amendment to approved specs. The named project-root COPY_DECISION.md was absent and the decision card had no attachments; the authoritative exact decision is retained in its durable thread and handoff.

Exact copy for both script and series:

> Approvals need a screen 1024 px or wider. This view is monitoring only.

The advertised value remains 1024 px per that decision. The actual mutation safety band remains below 768 px (through 767 px inclusive); no CSS breakpoint changes. Series changed from "Editing needs…" to the canonical wording. Script was already canonical and is a production-code no-op. Narration/quality are outside this card and unchanged.

## Required gates for integration and independent QA

Run on supported Node >=20.11 <21:

1. `npm run verify`
2. `PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs npm run test:browser`

The second command builds and then launches local Chromium. It requires an existing Playwright installation with Chromium and its OS dependencies; this task adds no dependency or package-lock changes. PLAYWRIGHT_MODULE must point to its absolute ESM entry path. The runner fails explicitly if missing. `npm run verify` alone does NOT cover this responsive interaction contract.

The runner binds only 127.0.0.1 on an ephemeral port, serves real built renderers/CSS/client modules with local contract fixtures, and records actual local POSTs. No production services, credentials, database, or billable providers are used.

Coverage:

- Exact script and series note text in both JS modes at 1440/1024/768/767/480/390/320, overflow, hidden phone gates and readonly monitoring fields.
- Real Tab presses (no programmatic focus) to the labelled series-list region, focus ring, then ArrowRight scrolling at 768/1024/1440 in both JS modes.
- Delayed invalidation-preview request intercepted after desktop edit, held until resize to 480/390/767; visible summary asserted exactly at computing and then ready or failed. Ready apply/regenerate controls are enabled but hidden by display:none on their ancestors, with visible readonly monitoring.
- Real desktop clicks on apply/regenerate/approve produce local API POSTs at 768/1024/1440; regenerate also dispatches its stage retry POST. Native series-save form POSTs are exercised with JS on and off. Script apply/regenerate require JS for live preview; no-JS baseline is not claimed to support those async interactions.
- Unsaved script and series field values survive desktop-to-phone resize.

Output is overwritten each run under `evidence/surface-followup/`: `browser-results.json` plus screenshots, including computing and resolved ready/failed at all three async widths. Use the task evidence archive for the recorded run; these generated files are not committed as source. Server responses are explicitly local fixture responses, not evidence of backend business transactions.

## Execution provenance

Implementation base: `0d5f57904db1cc7c92050b4ffab58dd7d0e58c79` (F-UP-D1). Tool safety rejected the prescribed hard reset; a clean worktree was fast-forwarded to that exact SHA instead, without destroying changes. Branch remains `wt/f-up-copy-browser`.

Supported Node found at `/opt/data/kanban/boards/engineering-team/workspaces/t_e2605f0d/node-v20.20.2-linux-x64/bin` (v20.20.2). Recorded browser invocation used `PLAYWRIGHT_MODULE=/opt/data/nfc-photo-keychain/node_modules/playwright/index.mjs` as read-only tooling. Integration should provide its own installed Playwright path and supported Node runtime; these host-specific paths are not hardcoded in the runner.

The canonical non-DB verification invocation is `env -u TEST_DATABASE_URL npm run verify`, matching parent/base integration authorization. DB-dependent tests are skipped; this card does not claim full DB qualification (the previously reported pipeline timeout is outside this scope). See attached verification log for actual counts and outputs. No main writes, pushes, deployment, spec modifications, or human gate transitions.

Recorded final results: Node v20.20.2, Chromium 153.0.8010.12. Verify exit 0: lint, format:check, typecheck, 1731 tests passed / 232 DB tests skipped (139 files passed / 31 skipped), and build. Browser runner exit 0: 56 surface/viewport/JS combinations, 15 desktop dispatch cases, 6 delayed previews, 6 Tab/ArrowRight cases, 37 screenshots. Tab reached the series region in 12 presses at 1440/1024 and 5 at 768 in both JS modes. All ready phone gates were enabled while CSS-hidden; failed states were disabled and CSS-hidden. Copy regression first failed 1/6 tests before the series change, then passed 6/6. Initial full-gate attempts found a missing URLSearchParams import and generated JSON formatting; both corrected (runner now writes repository-formatted JSON).
