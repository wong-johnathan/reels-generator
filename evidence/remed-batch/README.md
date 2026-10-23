# REMED-BATCH evidence

Task: t_79218d67. Branch: wt/remed-batch. Base: 8c9110f6b3fe99c638a72f296fc63a75a6c76000 (includes B-R1 contract).

## Verification

- RED: batch-detail.test.ts had 4 expected failures / 6 passes before implementation; red.log.
- GREEN: 21 tests passed across batch detail and embedded CSS; green.log.
- Full `env -u TEST_DATABASE_URL npm run verify`: exit 0; lint, format, typecheck, 1733 tests passed / 238 database-dependent skipped, build passed; verify.log.
- Browser: Chromium 153.0.8010.12; 14 combinations of 1440/1024/768/767/480/390/320 and JS on/off; browser.log and browser-results.json.
- Computed display, page overflow, retry 44px target and 8px spacing, series 24px target, workspace/review 44px target, retry AX presence/exclusion, keyboard tab presence/exclusion, series focus ring and failure copy are asserted.
- Screenshots at 1440/768/390/320 for both JS modes. Desktop and 390px JS-off screenshots visually inspected: readable wrapped content, retry absent on mobile and monitoring line visible.

## Reproduce browser regression

Run `npm run build`, then:

    CHROMIUM_PATH=/opt/hermes/.playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell PLAYWRIGHT_MODULE=/opt/data/lorcana_management/client/node_modules/playwright/index.mjs node tests/web/batch-detail.browser.mjs

## Scope and limitations

- Real full-shell SSR and generated APP_CSS with explicit synthetic failed-batch data; no production service, authentication flow, provider request or mutation submitted. Batch detail has no client enhancement module; JS-on/off verify native SSR/CSS behavior.
- Node v26.5.1; supported Node >=20.11 <21 unavailable via node20/node-20/nvm/volta discovery. No supported-runtime claim.
- TEST_DATABASE_URL unset, matching parent canonical environment. Database execution is not covered.
- Initial verify exposed a missing URL import in browser harness; fixed and full verify then passed.
- Requested destructive reset blocked by policy; clean branch fast-forwarded to exact required B-R1 base and HEAD verified instead.
- `npx tsx` blocked by package threat-metadata timeout before execution; installed `../../node_modules/.bin/tsx scripts/generate-embedded-css.ts` succeeded, regenerated once from nine authored stylesheets.
- AX-25 answers use existing stage/message/class/attemptNo, topic/script presence and sceneCount. No missing source for those requested answers. Image/narration survival counts and aggregate billing amounts are NOT available, are not invented, and are explicitly not implied by retained scene records. Retry cost/acceptance not promised. AX-26 exact `unknown charge` renders only for chargeStatus unknown; pending/null never described as unbilled.
- Hotspots: series.css (new S-06 section only), tests/web/batch-detail.test.ts (B-R1 fixture consumer), embedded.ts (integration must regenerate combined mirror).
- No approved specs, main branch, push, deployment or human gates changed.
