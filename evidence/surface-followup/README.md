# F-SURFACES-FOLLOWUP implementation evidence

Task: `t_c71d37f8`. Branch: `wt/f-surfaces-followup`.
Base: `a2f11003adb627fb3503c72aa01111e10e4f64d7`.

## Delivered scope

- AX-17: the degraded-banner Open Health link is an inline-flex target with the existing 24 px minimum token in both dimensions, not the 44 px gate token.
- AX-14: the native series table now sits inside a labelled, keyboard-focusable scroll region with a focus ring and sticky horizontal-scroll cue. `position: relative` contains the table's absolutely positioned screen-reader text as well as visible content. The existing phone card transform is preserved.
- AX-22: script review and series editing are monitoring-only below 768 px. CSS hides editable controls and all owned mutation actions. Server-rendered readonly copies have unique IDs, no names, and no editable `data-field` hooks. Select/radio/checkbox values are text summaries. Canonical/lead-approved width notices are server-rendered. Script impact collapses to a summary link; claims remain read-only rows.
- The lead-authorized enhancement synchronizes unsaved desktop values on input/change/resize. It lives in the already-served `client/behaviours.ts`, with bindings in the existing script and series enhancers, so no asset allowlist/server changes were needed. Safety does not depend on this enhancement.
- `embedded.ts` was regenerated once from all nine authored stylesheets at the end of CSS implementation. The scene-grid CSS region and all prohibited styles/backend/contract/spec files are untouched.

## TDD and commands actually executed

1. `npm test -- --run tests/web/surface-followup.test.ts`: RED, six regressions failed before implementation (shell minimum, table wrapper/style, script/series monitoring markup and phone hiding).
2. `npm test -- --run tests/web/monitoring.test.ts`: RED, missing enhancer module before implementation. The implementation was subsequently consolidated into existing `behaviours.ts` to avoid changing server asset allowlists.
3. Focused run of `surface-followup`, `monitoring`, `series-editor`, `script-page`, `series-list`, `script-client`, and `series-editor-client`: 78 tests passed.
4. `npm run typecheck`: passed.
5. `npm run build`: passed.
6. `../../node_modules/.bin/tsx scripts/generate-embedded-css.ts`: generated the combined runtime stylesheet. The requested `npx` route was blocked by unavailable package threat-intelligence checks; the already-installed local executable ran the same script instead. No package installation or dependency change.
7. `npm run verify`: passed lint, format check, typecheck, tests and build. Full output is in `verify.log`: 139 test files passed, 31 skipped; 1,723 tests passed, 232 skipped.
8. `PLAYWRIGHT_MODULE=/opt/data/nfc-photo-keychain/node_modules/playwright/index.mjs node tests/web/surface-followup.browser.mjs`: passed, using existing Playwright/Chromium installation read-only. Harness imports the built renderers and generated `APP_CSS`, binds localhost on an ephemeral port, and closes it afterward. No application service or external API is used.
9. Prettier ran on changed source/test files and generated browser evidence JSON; `git diff --check` passed.

## Browser evidence

Chromium 153.0.8010.12. Four surfaces (shell, series list, script review, series editor), six widths (1440/1024/768/480/390/320), JavaScript both disabled and enabled: 48 combinations passed. Detailed measurements are in `browser-results.json`.

- Open Health measured 73 × 24 CSS px throughout the matrix.
- No document horizontal overflow, including a deliberately unbroken long series name.
- At desktop/tablet widths the series region retained its label/tab stop, rendered a focus outline and scrolled with ArrowRight.
- Below 768, no visible editable input/select/textarea and no visible approve/apply/regenerate/save/start-batch control; width notice and script impact summary visible.
- At 768 and above, the draft script approval and changed-series Save controls are visible and enabled. Fixture claims are explicitly sourced so this is not a blocked/empty-state false positive.
- Enabled-JS desktop edits to script title and series name survive resizing to 390 in the visible readonly copies. Unit tests also cover radio labels and checkbox state summaries.
- No browser runtime errors. Sixteen full-page PNGs cover all four surfaces at 1440/768/390/320; every required width has JSON measurements.

Browser verification caught two issues before handoff: absolute screen-reader text escaping an unpositioned table scroll region, and the existing `.series-commit .btn-primary` display declaration outranking a single-class mobile Save selector. Both were corrected within owned CSS; the final matrix passes.

## Limitations and handoff

- `TEST_DATABASE_URL` is unset; the existing 232 database-dependent tests skip. No real database/provider/spend path was exercised or changed.
- Browser evidence uses real renderers and client modules over local fixtures, not production API requests or mutation submissions. Independent integration/review/QA remain required.
- Without JavaScript, monitoring copies reflect the current server render; JavaScript-enabled unsaved resize synchronization is covered separately.
- This is only AX-17/AX-14/script+series AX-22 remediation, not global UI-spec conformance. Additional mobile safety states were explicitly routed separately by the operator to `t_6c9e2822`.
- No push, main-branch write, deployment, spec modification or release approval. Complete this implementation phase to release `t_0c568055`; integration must precede downstream QA. No same-card review or QA bypass.
