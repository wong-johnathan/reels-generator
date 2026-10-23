# REMED-SCENE D1/D2/D4/D5-scene

Base: 392e93232c72f9864ac5dd59fbe7a10415ce6736. Branch: wt/remed-scene.

## Changes

- SSR width notes plus CSS display:none remove scene replacement below 1024, and storyboard approval below 768. Existing wired/unwired/blocked desktop behavior is preserved.
- Explicit six desktop grid columns, four at 1024–1439. ArrowUp/Down resolve live rendered pixel tracks at each keypress (including immediately after resize), never data-columns.
- All scenes and storyboard scene links have 24px minimum dimensions, not 44px review sizing.
- Script-review CSS and sibling-owned files remain untouched. Embedded CSS regenerated once from this branch's authored CSS.

## Reproduction

Use installed repository tools (worktree resolves packages from ../../node_modules):

    ../../node_modules/.bin/vitest run tests/web/scene-detail-page.test.ts tests/web/storyboard-page.test.ts tests/web/scene-styles.test.ts tests/web/scene-grid-client.test.ts tests/web/scene-grid-page.test.ts tests/web/embedded.test.ts
    npm run build
    CHROMIUM_PATH=/opt/hermes/.playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell PLAYWRIGHT_MODULE=/opt/data/lorcana_management/client/node_modules/playwright/index.mjs node tests/web/scene-remediation.browser.mjs
    env -u TEST_DATABASE_URL npm run verify

CHROMIUM_PATH is optional when Playwright's default browser revision is installed. The harness uses external installed Playwright without adding a project dependency.

## Evidence

- red.log: pre-implementation failing renderer/CSS/keyboard tests.
- green.log: six targeted test files, 91 tests passed.
- verify.log: lint, format:check, typecheck, full tests, build. 1730 passed, 232 database-dependent tests skipped.
- browser-results.json and browser.log: 63 real Chromium cases covering widths 1440/1024/768/767/480/390/320, JS enabled and disabled, all three replacement states on directly loaded scene fixture URLs, real accessibility-tree and tab exclusion, 24px link targets, 44px storyboard approvals, visual grid-row geometry, ArrowDown/Up and live resize. A deliberately incorrect data-columns=99 does not affect navigation.
- PNGs: scene and storyboard full-shell screenshots, both JS modes. Narrow scene view and desktop storyboard visually inspected: no overlap/clipped text in changed regions, canonical monitoring copy visible and replacement absent on narrow view.

## Limitations / handoff

- Node v26.5.1; project requests >=20.11 <21. Canonical verification deliberately unsets TEST_DATABASE_URL, matching parent evidence. No DB-backed end-to-end run claimed.
- One repeat verification hit the terminal's 360-second timeout after test output (preserved in verify-repeat-timeout.log). A fresh full verification with a 600-second allowance completed successfully; verify.log is that final green run. No tests or timeouts were changed.
- Browser server is a local full-shell fixture harness using actual server renderers, generated APP_CSS and compiled browser modules. It directly loads /videos/<id>/scenes/S07 URLs; it does not exercise authenticated production routing, mutation requests or real stored-image delivery. Image asset endpoints are not served, so scene screenshots show the existing fixed-size image frame and alt text rather than a real image. No synthetic API responses or placeholder photos substituted.
- Default Playwright expected Chromium revision 1234 was unavailable; install attempt timed out. Existing local Chromium revision 1243 successfully ran the regression via CHROMIUM_PATH.
- Requested reset --hard was denied by runtime safety. Starting branch was verified clean at a2f11003; fast-forward to the exact requested base succeeded and HEAD was verified.
- Hotspots: src/web/styles/workspace.css (scene-only regions), src/web/styles/embedded.ts (generated). Integration must regenerate the combined mirror rather than adopt a single branch's output.
- No main writes, push, deploy, specification changes, or human-gate actions.
