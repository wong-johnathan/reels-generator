# F-UH-DEV — exact scene/image and phone Tab regression proofs

Task t_477733ec. Developer verification PASS; integration and independent QA remain
required. This is not release approval. Exact source commit is recorded in the
Kanban completion and archive manifest (this report is part of that commit).

## Authority, source and scope

Base: 857065655d72f82a0b269afa30196ef3de31216b.
Branch: wt/f-up-cardinality-tab, isolated task worktree. The initial attempt
verified clean base; this resumed run found only its documented partial pipeline
assertion edit and report. No unrelated work was overwritten.

Owned changed files only:

- src/worker/pipeline.e2e.test.ts
- tests/web/surface-followup.browser.mjs
- evidence/F-UH-DEV.md

Johnathan's decision relayed on this card explicitly removes the unsupported image
asset_ref requirement: prove existing direct scene/image ownership instead, do not
add production persistence or fabricate refs. Prior RED found zero image refs for
17 valid images. That failed attempt/report/patch remains in the archived
F-UH-DEV-BLOCKED.zip. Video and narration asset_ref assertions remain unchanged.
No product, fake, schema, package, lockfile, ignore, shared docs or baseline edit.
No new design approval inferred; historical provenance drift remains t_de560b30's
owner-visible limitation.

## A — R-007-1/2, R-013-2, TECH_DESIGN11

Read the deterministic text-fixtures.ts storyboard: S01 through S17. Strengthened
both >=1 checks to exact17. Independent unjoined scene and IM/image asset queries
prove all17 scene numbers,17 distinct current asset IDs and full ordered equality:

    asset.id == scene.asset_id
    asset.scene_id == scene.id
    asset.object_key == e2e-series/batch-0001/scenes/<scene_no>.png

Exact independent collection cardinality plus full identity/key equality rejects
missing, extra, orphan, misassigned or duplicate current mappings; no inner join
can discard a failing row. Existing S01/path-pattern, topic/script, stage/job,
project/batch, video/ref, narration/sidecar and retry assertions are preserved.
The 300000ms timeout and explicit runner selection are unchanged: default stub;
only REELS_E2E_REAL_RENDER=1 selects ProcessFfmpegRunner. Render-half real-media
assertions are untouched. Read-only audit of a real test database separately
confirms COMPLETE/QC,17/17 and every mapping (db-audit.json); image refs remain0,
diagnostic only under the explicit owner decision.

## B — AX-01, AX-06, AX-22, T2

The shared phoneTabProof retains all70 actual Tab presses and original per-press
negative checks. It adds positive reach for every visible monitoring input or
textarea, selecting independently of readonly/tabindex. It asserts readonly and
nonempty unique IDs. Plain editor choice-summary paragraphs are not input fields
and are deliberately not sequential focus targets. No programmatic focus is used.
The existing baseline tabSequence evidence key is preserved.

Passed all16 baseline phone cases: script/editor x767/480/390/320 x JS off/on.
Passed8 additional resolved script cases: four phone widths x ready/failed.
Each has70 real Tab presses:24 walks /1680 presses. Each records expectedIds,
reachedIds, presses, tabSequence and pre-walk control disabled/display-none state.
All gates are CSS-hidden; no mutation control is reached. Before each resolved
walk, the independent existing summaryGates assertion proves apply/regenerate
are enabled for ready and disabled for failed. The captured ready gate evidence
also shows approve enabled/hidden; failed apply/regenerate disabled/hidden.

Script expected/reached IDs (all4 in every applicable case):

- script-body-monitor
- script-title-monitor
- script-description-monitor
- script-hashtags-monitor

Editor expected/reached IDs (all19 in each baseline editor phone case):

- field-name-monitor
- field-niche-subject-monitor
- field-script-style-example-script-monitor
- field-target-duration-s-monitor
- field-videos-per-batch-monitor
- field-narration-language-monitor
- field-voice-config-voice-id-monitor
- field-art-style-preset-monitor
- field-niche-audience-monitor
- field-niche-boundaries-monitor
- field-niche-language-monitor
- field-niche-location-monitor
- field-niche-prohibited-topics-monitor
- field-niche-preferred-sources-monitor
- field-script-style-tone-monitor
- field-script-style-structure-monitor
- field-voice-config-speed-monitor
- field-voice-config-style-monitor
- field-art-style-palette-monitor

Full retained browser gate passes56 surface/width/JS combinations,15 desktop
POST dispatch cases and14 delayed previews. Preserved all7 widths, exact canonical
copy, computing/resolved accessibility snapshots, baseline AX exclusions, no-JS
safe defaults, region Tab/ArrowRight/ring checks and resize synchronization.
Output override/default semantics are unchanged. browser-results.json and
independently parsed audit.json retain every expected/reached ID and gate state.

### Disposable mutation proof (all caught, no committed mutations)

Generated runner copies in ignored task evidence use the same built files and
assertions. Only the selected fixture DOM is mutated just before the walk; no
focus calls. The probe driver requires exit1 AND the exact intended assertion,
not merely any failure. All5 probes passed that criterion:

| Probe at767            | Mutation                                           | Actual assertion failure                      |
| ---------------------- | -------------------------------------------------- | --------------------------------------------- |
| script baseline JS off | monitor tabindex=-1                                | every visible readonly monitor reached by Tab |
| editor baseline JS off | monitor tabindex=-1                                | every visible readonly monitor reached by Tab |
| resolved ready         | monitor tabindex=-1                                | every visible readonly monitor reached by Tab |
| resolved failed        | monitor tabindex=-1                                | every visible readonly monitor reached by Tab |
| resolved ready         | enabled apply exposed by ancestor display override | mutation control reached by Tab               |

Negative probe logs independently capture all3 controls enabled and CSS-hidden
before exposing apply. Probe copies were removed, retained source never mutated.
The unmodified final gate subsequently passed again. Logs, driver and results
are archived for reproduction; these are regression sensitivity experiments,
not product defects or new product behavior.

## Actual runtime, commands and results

Node v20.20.2 / npm10.8.2. Node bin:
/opt/data/kanban/boards/engineering-team/workspaces/t_e2605f0d/node-v20.20.2-linux-x64/bin.
Fresh npm ci exit0,215 packages. Existing3 vulnerabilities (1 moderate,2 critical)
and deprecated ESLint warning remain; no dependency changes or audit clearance.

Real disposable native PostgreSQL16.14, pgcrypto1.3, vector0.8.2, loopback55477.
Reused this task's isolated stopped scratch cluster from the prior attempt;
helpers create new independent reels_test_* databases on each run. Test URL:
postgresql://hardening@127.0.0.1:55477/hardening_test (throwaway local role only).
fsync=off, synchronous_commit=off, full_page_writes=off, measured in db-audit.json.
Real SQL/constraints/commits are tested, NOT crash/power-loss durability.

Commands run from the isolated worktree:

| Command                                                                              | Actual result                                                                                            |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| npm ci                                                                               | exit0, fresh215 packages                                                                                 |
| npx vitest run src/worker/pipeline.e2e.test.ts                                       | tooling threat lookup blocked; installed local executable used below                                     |
| TEST_DATABASE_URL=... ./node_modules/.bin/vitest run src/worker/pipeline.e2e.test.ts | exit0,3 passed/0 skipped, tests3275ms, total7.67s                                                        |
| TEST_DATABASE_URL=... npm run verify                                                 | exit0,1964 passed/0 skipped,170 files,86.21s test duration                                               |
| env -u TEST_DATABASE_URL npm run verify                                              | exit0,1732 passed/232 DB skips,140 passed/30 skipped files,68.05s test duration; comparison only         |
| TEST_DATABASE_URL=... npm run verify (final source, output present)                  | exit0,1964 passed/0 skipped,170 files,88.56s test duration                                               |
| npm run build                                                                        | exit0; also passes in each verify                                                                        |
| explicit environment below, node tests/web/surface-followup.browser.mjs              | exit0,56/15/14; final repeat39.238s                                                                      |
| python3 scratch/f-uh-mutations.py                                                    | exit0,5 intended assertion failures caught                                                               |
| python3 scratch/f-uh-audit.py                                                        | exit0,24 walks/1680 presses, all expected reached;152 pre-existing tracked evidence files byte-identical |
| node scratch/f-uh-db-audit.mjs                                                       | exit0, real independent row/settings audit                                                               |
| npm run format:check with browser output present                                     | exit0                                                                                                    |
| git diff --check; git diff --exit-code -- evidence/surface-followup                  | exit0                                                                                                    |

Full verify includes lint, format check, typecheck, test and build, all passed.
Final DB suite pipeline:3 passed in5061ms. Short real-media half proof:1 passed
in9807ms in final DB gate;12116ms in explicit non-DB gate. Uses /usr/bin/ffmpeg
and /usr/bin/ffprobe; unchanged genuine media assertions are not replaced by stub.

Browser: real Playwright module
/opt/data/nfc-photo-keychain/node_modules/playwright/index.mjs.
Installed its matching headless Chromium153.0.8010.12 in this task's private cache:

    PLAYWRIGHT_MODULE=/opt/data/nfc-photo-keychain/node_modules/playwright/index.mjs
    PLAYWRIGHT_BROWSERS_PATH=/opt/data/profiles/devbackend/cache/scratch/f-uh-playwright
    BROWSER_OUTPUT_DIR=/opt/data/profiles/devbackend/cache/scratch/f-uh-resume/browser
    node tests/web/surface-followup.browser.mjs

Verified executable:
/opt/data/profiles/devbackend/cache/scratch/f-uh-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell.
This base runner does not support CHROMIUM_PATH, so supported Playwright cache
discovery is used without changing the output or launch contract.

### Honest intermediate failures

- Prior attempt's real imageRef0-vs17 RED required owner scope decision; preserved.
- Initial resumed local pipeline ran without TEST_DATABASE_URL and skipped2; not
  DB evidence. A mislabeled first verify likewise actually ran non-DB and passed
  1732/232; retained separately, never counted as real DB proof. Shell environment
  assignments did not reliably cross calls; successful commands use explicit env.
- Initial browser used old cache1228 while module required1243. Installed matching
  Chromium into task scratch via Playwright CLI (exit0). Another call lacked
  PLAYWRIGHT_MODULE and failed fast; successful calls pass explicit values.
- First new positive selector included editor summary paragraphs and failed the
  readonly property check. Inspected actual renderer; corrected to monitoring
  input/textarea controls without filtering readonly or tabindex. Not a defect.
- Security filter blocked npx threat lookup, redirected repeat npm ci, a grouped
  read-only command and unnecessary LD_LIBRARY_PATH assignment. Used installed
  local Vitest/plain commands/native pg_ctl without that assignment; no gate bypass.
- /usr/bin/time is absent (exit127); final browser timing is an actual Python
  monotonic measurement around subprocess execution, not invented shell output.

## Evidence, identity and handoff

Durable report: this file. Durable raw archive:
evidence/.browser-run/F-UH-DEV-EVIDENCE.zip, also attached to the task on completion.
Archive includes final source manifest/diff, full logs, browser JSON/screenshots/
AX snapshots, row audit,152-file baseline hashes, mutation probes/results/drivers,
prior blocked archive and this report; excludes DB files, runtimes and node_modules.
Final archive manifest records exact source commit and clean tracked status.

All152 pre-existing tracked evidence files were byte-compared with base, including
all19 surface-followup baseline files. No tracked baseline byte changed. Final
source status must be clean after the authorized local commit; checked in handoff.
Generated output remains ignored and present during final format/verify checks.
Disposable PostgreSQL is stopped before handoff; stop result is in the archive.

hotspot: tests/web/surface-followup.browser.mjs — separate D6H-C output-only lane
and C-RET read-only-harness lane remain distinct. No merge/cherry-pick or output
contract/shared ignore/docs changes here. Integration t_fe37914a must explicitly
integrate this exact local commit; dependency completion does not merge it.
Then independent QA t_1577d6fa must assess the integrated exact SHA. This card's
completion releases integration only, not release approval.

## Limitations

No full17-scene real encode/performance qualification; default DB stub is only
orchestration proof. No production/authenticated/provider E2E, paid calls, spending,
full30-video workload, Firefox/WebKit, actual screen-reader announcements, zoom,
NAS/crash durability or dependency security remediation. No main writes, push,
merge to main, deployment, publication or human-gate completion/unblock. Image
asset_ref persistence is explicitly excluded by the owner's decision; no reference
rows were fabricated. Different branch QA results cannot be combined into global
acceptance; historical design/UI hash drift and release decision remain gated.
