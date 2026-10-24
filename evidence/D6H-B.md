# D6H-B — scene keyboard and outside-focus browser hardening

Task: `t_94c59821`. Implementation phase complete for explicit integration and independent QA, not release authorization.

## Scope and provenance

- Base: `b6f28d4b859bd58c9f9a72e80017b8053c152608`.
- Branch: `wt/d6r-hardening-scene`; initial HEAD exactly matched base and worktree was clean.
- Owned changes only: `tests/web/scene-remediation.browser.mjs` and this report. No product, specification, package, shared-runner, or ignore changes.
- Test-only retention under parent scoped QA/plan (`t_8d07960c`, `t_a285911b`); no new design or approval decision. Requirements AX-01/02/06/22 and UI7.2.
- Exact final commit is recorded in the task completion handoff (avoids self-referential report hash).

## Retained and added checks

The existing broad AX-name presence/absence and hidden real-Tab exclusion assertions remain. Each matching control is now recorded separately by selector, index, tag, id/name/text, actual native `:disabled`, computed visibility and tabindex. CDP backend DOM identity joins that exact control to its AX node; disabled AX presence is not treated as Tab reach. Two full real keyboard Tab traversals collect individual DOM active-element matches. Explicit cardinality checks require both scene controls and the expected pending approval control; missing controls cannot vacuously pass.

Visible wired textareas and replace buttons must each be reachable, as must pending visible storyboard approval. Blocked/unwired textareas AND buttons are intentionally native-disabled: they remain AX-exposed on desktop, with AX disabled semantics, but must never be reached by Tab. Hidden controls remain absent from AX and Tab, whether enabled or disabled. No disabled control is modified/enabled by these tests.

All previous primary 44px/8px geometry, scene/back links, storyboard states, grid columns/computed ArrowDown stride, pager Tab/Enter/Space/arrows, and logical S02 breakpoint focus assertions are preserved.

Outside-focus coverage first focuses scene S02 to seed remembered grid focus, then retains an ElementHandle to the existing shell `.skip-link`. It focuses this link and checks the same connected DOM object remains `document.activeElement` across widths `1440 -> 768 -> 390 -> 1440 -> 1024 -> 767 -> 320 -> 1440`, with a 150ms settling interval after each change and expected pager-controls visibility checks. Repeated cross-band changes exercise breakpoint effects with JS on; the identical JS-off sequence verifies native safety only, not enhancement callbacks. The original four in-grid logical S02 resize tests remain unchanged.

## Actual Chromium results

Node `20.20.2`, npm `10.8.2`, Playwright `1.61.0`, Chrome for Testing `153.0.8010.12`.

Both JS modes and all seven widths `[1440,1024,768,767,480,390,320]` passed. Final result: **138 browser result rows**:

| Surface                                    | Rows |
| ------------------------------------------ | ---: |
| Direct scene: wired/unwired/blocked        |   42 |
| Storyboard: pending/approved/blocked/empty |   56 |
| Desktop grid                               |    4 |
| Checkpoint primary                         |   14 |
| Pager keyboard                             |    1 |
| Existing logical S02 resize focus          |    4 |
| Existing live column-stride resize         |    3 |
| New outside resize focus                   |   14 |

Per-control outcomes across the matrix:

| Target/state                            | AX                | Real Tab | Observations |
| --------------------------------------- | ----------------- | -------- | -----------: |
| Wired visible scene textarea            | exposed, enabled  | reached  |            4 |
| Wired visible scene replace button      | exposed, enabled  | reached  |            4 |
| Unwired visible textarea/button         | exposed, disabled | excluded |            8 |
| Blocked visible textarea/button         | exposed, disabled | excluded |            8 |
| Pending visible storyboard button       | exposed, enabled  | reached  |            6 |
| All hidden scene textarea/button states | absent            | excluded |           60 |
| Hidden pending storyboard button        | absent            | excluded |            8 |

Total: **98 individual control observations**, including **14 positive Tab**, **16 visible native-disabled exclusions**, and **68 hidden exclusions**. Additionally **42 absent approval-target cases** (approved/blocked/empty) retain negative AX/Tab checks. Counts and full seven-width/two-mode/state coverage were programmatically verified. Every per-case target/state/AX/Tab result is in `browser/scene/browser-results.json`; `primary-failures.json` is `[]`.

All **14 outside-focus transitions** preserved exact DOM identity; JS-on and JS-off each passed seven transitions. The four existing in-grid S02 transfers passed. Twelve screenshots were generated; desktop wired and 320px no-JS examples were inspected. These are component/full-shell fixtures, not authenticated end-to-end or visual design approval; fixture asset URLs do not serve real image contents.

## Executed commands and results

All commands ran from this isolated project worktree with the supported Node directory prepended to PATH:

```sh
export PATH=/opt/data/kanban/boards/engineering-team/workspaces/t_8d07960c/tools/node-v20.20.2-linux-x64/bin:$PATH
npm ci
npm run build
npx prettier --write tests/web/scene-remediation.browser.mjs
BROWSER_OUTPUT_DIR=/opt/data/profiles/devfrontend/cache/scratch/d6hb-evidence/browser \
PLAYWRIGHT_MODULE=/opt/data/home/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs \
CHROMIUM_PATH=/opt/data/home/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome \
node tests/web/scene-remediation.browser.mjs
env -u TEST_DATABASE_URL npm run verify
python3 /opt/data/profiles/devfrontend/cache/scratch/d6hb-evidence/probes.py
python3 /opt/data/profiles/devfrontend/cache/scratch/d6hb-evidence/summarize.py
```

Each listed command exited **0**. Browser passed twice, including final cardinality/result metadata changes. Full verify passed lint, format check, typecheck, tests and build: **140 test files passed / 31 skipped; 1753 tests passed / 238 skipped**. SQL was skipped because `TEST_DATABASE_URL` was unset; parent D6R DB qualification remains **BLOCKED**, never green. `npm ci` reported three dependency vulnerabilities (one moderate, two critical); dependencies were not changed.

Scratch-only sensitivity probes copied the harness, used unchanged production modules, and independently removed the wired button or textarea from Tab order while leaving AX presence intact. Both were detected by their exact per-control positive assertion. A third probe deliberately blurred outside focus at a desktop band change and was detected by the outside identity assertion. All three expected child failures were confirmed by the probe driver (exit 0). The first exploratory button probe matched `data-replace-copy` instead of the button and did not mutate the intended target; it was corrected to exact submit-button markup before these confirmed results. No source/build artifacts were mutated. A combined command containing Python `-c` was rejected by the execution guard before execution; normal script-file invocation succeeded.

## Output isolation and durable evidence

The harness resolves `process.env.BROWSER_OUTPUT_DIR || 'evidence/.browser-run'` from project cwd and appends `scene`; all screenshots and JSON use that directory, recursively created. This lane used only the absolute scratch override above. Default/combined-gate behavior belongs to the downstream integration task after the backend sibling supplies shared ignore/runner changes.

Programmatic comparison to Git base verified all **177 existing tracked evidence files byte-identical**, with individual SHA256 values saved as `baseline-hashes.json`. No restoration was needed, and no historical baseline was edited. No hotspot collision was observed; this lane owns its scene runner exclusively.

Durable task archive `D6H-B-EVIDENCE.zip` contains final results, screenshots, verify/browser logs, sensitivity probe scripts/logs/results, baseline hashes, programmatic summary, this report and the patch. The task handoff records archive SHA256, final commit, clean status and integration child `t_d6135555`. Completion does not merge branches: the lead must explicitly cherry-pick this exact commit, then integrate sibling lanes and release independent QA. No main write, push, deploy, human-gate completion or release authorization occurred.
