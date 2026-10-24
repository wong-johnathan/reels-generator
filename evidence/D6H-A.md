# D6H-A — independent OR signals and frozen browser inputs

## Scope and provenance

- Task: `t_6e4808a6`; integration child: `t_d6135555`.
- Base: `b6f28d4b859bd58c9f9a72e80017b8053c152608`.
- Branch: `wt/d6r-hardening-batch`; initial HEAD matched base and status was clean.
- Changed files: `tests/web/batch-detail.browser.mjs`, `evidence/D6H-A.md` only.
- Test-only retention of parent QA coverage-hardening finding A, under existing PRD2.4 R-012-4 / UI AX-26 / D6-R behavior. No product, API, copy, specification, dependency or shared-runner changes. No new approval inferred from existing document-provenance drift; no main writes, push or deployment.
- Inspected `qa-extra.mjs` with Python `zipfile` inside `/opt/data/kanban/boards/engineering-team/attachments/t_8d07960c/QA_EVIDENCE.zip`. Extracted script SHA256: `d5c3afa2c923c2b72be882de876c77e519db10a7b06021095af364bf49b7529b`. The reference is included in the evidence archive, not reinterpreted as a new QA execution.
- Exact implementation commit is recorded in the task completion handoff (this report is included in that commit).

## Retained matrix

The expected outcome is specified by each test row, not calculated using the renderer's OR expression. All three individual predicates have explicit false values in the other two fields where independence is asserted.

| Variants                                          | attemptStatus  | runStatus | chargeStatus       | Disclosure |
| ------------------------------------------------- | -------------- | --------- | ------------------ | ---------- |
| `attempt-only-{pending,null,billed,unbilled}`     | unknown_charge | failed    | named charge value | yes        |
| `run-only-{pending,null,billed,unbilled}`         | failed         | timed_out | named charge value | yes        |
| `both-{pending,null,billed,unbilled}`             | unknown_charge | timed_out | named charge value | yes        |
| `charge-only`                                     | failed         | failed    | unknown            | yes        |
| `no-signal-{pending,null,billed,unbilled}`        | failed         | failed    | named charge value | no         |
| `timeout-{pending,null,unknown}` (existing cases) | unknown_charge | timed_out | named charge value | yes        |
| `failed-{billed,unbilled}` (existing controls)    | failed         | failed    | named charge value | no         |
| `charge-and-attempt`                              | unknown_charge | failed    | unknown            | yes        |
| `charge-and-run`                                  | failed         | timed_out | unknown            | yes        |

The first five table rows map directly to QA's 17 structured cases by the same variant names. The original five cases remain, including all three signals in `timeout-unknown`. Two extra unknown-charge pair cases complete the pair combinations. Total: 24 variants. Pending/null and conflicting billed/unbilled source facts remain unchanged. QA matrix no-signal controls deliberately say `Provider request timed out.` but must not disclose unknown charge. Charge-only and the two extra charge combinations deliberately say `Provider rejected the request.` and must disclose it; message text is not an oracle.

## Frozen-input and browser checks

Every variant renders a complete batch input, including its Date, videos array, nested retained topic/script, hashtags array and failure facts. The shell input is independently cloned from real contract fixtures. Before each render, every reachable object is frozen and checked with `Object.isFrozen`; `structuredClone` captures a before snapshot. After rendering, deep strict equality checks all values (including Date value), and graph path/count plus strict reference identity checks every nested object/array. No source status is normalized for presentation.

Actual result: 48 frozen batch/shell inputs, 456 object references checked. Each variant's rendered page is reused across viewport/JS combinations after these checks. `browser-results.json` retains per-input check evidence and per-case source fields, expected result, geometry, AX and Tab observations, preserving the existing `variant` result field.

Real Chromium exercised all 24 variants at widths 1440, 1024, 768, 767, 480, 390, 320, each with JS disabled and enabled: 336 passing cases. Exact `unknown charge` own-paragraph count, Playwright visibility, text presence/absence and AX StaticText presence are checked. Existing no-unbilled/free assertions, no-overflow, retry/monitoring visibility, target dimensions, gap, hidden form display, retained-content/class/attempt/next-action text, retry AX membership, keyboard Tab membership and focus outline checks remain. No page errors occurred.

JS-enabled runs serve real compiled shell ESM assets and wait for `reelsAnnounce`; 504 actual script responses were recorded. Screenshots: 192, covering every variant at 1440, 768, 390 and 320 in both JS modes. Manual inspection of attempt-only/unbilled at 320 JS-on and charge-only at 1440 JS-off found the exact disclosure visible, retained content readable and correct monitoring/retry layout without horizontal clipping.

Scratch-only sensitivity probes execute the same harness against copied compiled renderer modules, never changing tracked source or project build output:

| Injected fault             | Actual result                | Expected failing case      |
| -------------------------- | ---------------------------- | -------------------------- |
| Remove attempt predicate   | exit 1                       | attempt-only-pending       |
| Remove run predicate       | exit 1                       | run-only-pending           |
| Remove charge predicate    | exit 1                       | charge-only                |
| Mutate source chargeStatus | exit 1 / read-only TypeError | frozen input rejects write |

The probe driver passed all four expected-failure checks. These are intentional sensitivity failures, not product defects. No application implementation was changed.

## Commands and actual results

All application commands ran from the isolated worktree with the supported Node binary directory prepended to PATH:

`/opt/data/kanban/boards/engineering-team/workspaces/t_8d07960c/tools/node-v20.20.2-linux-x64/bin`

Verified Node `v20.20.2`, npm `10.8.2`, Playwright `1.61.0`, Chromium `153.0.8010.12`.

Browser environment:

- `BROWSER_OUTPUT_DIR=/opt/data/profiles/devfrontend/cache/scratch/d6ha-evidence/browser`
- `PLAYWRIGHT_MODULE=/opt/data/home/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs`
- `CHROMIUM_PATH=/opt/data/home/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`

| Command                                                        | Exit | Wall seconds | Evidence                                      |
| -------------------------------------------------------------- | ---- | ------------ | --------------------------------------------- |
| `npm ci`                                                       | 0    | 27.694       | command-3.log                                 |
| `npm run build`                                                | 0    | 45.747       | command-4.log                                 |
| targeted Prettier write of owned harness                       | 0    | 1.399        | command-5.log                                 |
| `node tests/web/batch-detail.browser.mjs` initial expanded run | 0    | 188.729      | command-6.log                                 |
| same browser command, final visibility/schema assertions       | 0    | 228.188      | browser-final.log / browser-final-result.json |
| `env -u TEST_DATABASE_URL npm run verify` completed retry      | 0    | 318.608      | verify.log / verify-result.json               |

Full verify passed lint, whole-repo formatting check, typecheck, Vitest and build. Vitest: 140 files passed / 31 files skipped; 1753 tests passed / 238 skipped / 1991 total; test duration 153.16 seconds. SQL-dependent skips remain skips: parent D6R DB qualification remains BLOCKED, not green or imported from another SHA.

An earlier foreground sequence exceeded the terminal transport's 420-second limit during verify/typecheck; that incomplete attempt is retained in command-7.log and is NOT counted as a pass. The independent background retry above completed successfully. The initial archive/tool-path discovery also exceeded a 180-second broad recursive lookup after printing the actual QA script; bounded file discovery then found and execution verified the tools.

`npm ci` reported 3 dependency vulnerabilities (1 moderate, 2 critical) and an ESLint deprecation warning. No dependency remediation was authorized or performed.

## Output isolation and baseline preservation

The harness resolves `process.env.BROWSER_OUTPUT_DIR || 'evidence/.browser-run'` from project cwd, appends `batch`, creates it recursively, and puts every generated screenshot/JSON there. The absolute scratch override was exercised; the final run produced only its `batch` child directory. Caller-owned external directories are not implicitly ignored. Backend owns ignore/documentation plumbing; integration owns combined/default-root verification.

SHA256 manifests before and after execution confirm all 177 previously tracked evidence files byte-identical. `git diff --check` passed and the only pre-report tracked diff was the owned harness. No baseline restoration was needed; a precautionary scratch backup exists but is not part of the deliverable archive. No historical evidence was edited, and generated output remained in the external override directory during full verify.

## Handoff

Integration must explicitly cherry-pick the exact source commit from this card, then integrate the scene and runner sibling commits and run its combined/default/override acceptance gates. Completion here is implementation-phase completion only; downstream integration and independent QA remain required. No hotspot collision was observed in this owned file.

Durable evidence archive delivered with the task: `D6H-A-EVIDENCE.zip`, containing actual final results/screenshots, command logs/results, baseline manifests, QA script reference and scratch-only probe logs/sources. The task handoff records its absolute durable attachment path and exact implementation commit.
