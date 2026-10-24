# D6H-C — combined browser output isolation

Task: `t_e88adf4e`. Branch: `wt/d6r-hardening-runner`.
Base verified clean at `b6f28d4b859bd58c9f9a72e80017b8053c152608`.
The exact resulting commit/tree is recorded in the completion handoff and archive
`revision.txt` (not self-referentially embedded in this committed report).

## Scope and coordination

Output-only changes in shell/surface, Git and Prettier ignore entries, and
`docs/BROWSER_GATE.md`. Each owned harness resolves
`process.env.BROWSER_OUTPUT_DIR || 'evidence/.browser-run'` from project cwd, then
appends `shell` or `surface`. JSON and screenshots use that destination.
Empty overrides fall back to the default. External absolute overrides are honored;
ignore/format policy for explicit overrides remains caller-owned.

Read F-UP-RETAIN `t_9dfdfcb2` / `e695b081e66bb28783477c3e13b3a00099271962`
and F-UP-INT2 `t_f97f2398` / `857065655d72f82a0b269afa30196ef3de31216b`.
Reused isolation lessons, not their separate async/AX/Tab retention or DB chain.
No product, package, lockfile, spec, scene/batch harness, or historical baseline
changes are included. No existing assertions were removed or weakened.
The combined runner and build-first package command are unchanged byte-for-byte.

Hotspot: `tests/web/surface-followup.browser.mjs` — this D6H lane changes output
paths only; preserve separate F-UP retention ownership. Shared ignore/docs ownership
was reported on the card. No sibling scene/batch edits were made.

## Execution and tools

Supported runtime: Node `v20.20.2`, npm `10.8.2`; Python `3.13.5` for proof/archive.
Node executable came from the existing QA tooling installation at
`/opt/data/kanban/boards/engineering-team/workspaces/t_6359ef9a/tools/node-v20.20.2-linux-x64/bin/node`.
Playwright `1.63.0` at
`/opt/data/nfc-photo-keychain/node_modules/playwright/index.mjs`.
Verified executable:
`/opt/data/home/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`.
Both the executable and the real launched browser reported `153.0.8010.12`.
No browser/package download or production request was performed by the browser gate.

| Command / proof                                                                                                                                            | Exit and result                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci` on Node20                                                                                                                                         | 0; 215 packages added; existing 1 moderate / 2 critical advisories                                                                                                                              |
| `python3 "$TMPDIR/d6hc-output-contract.py"` before implementation                                                                                          | 1; four expected failures: namespaces and both ignores                                                                                                                                          |
| Same contract check after implementation                                                                                                                   | 0; four tests passed                                                                                                                                                                            |
| `env -u TEST_DATABASE_URL npm run verify`                                                                                                                  | 0; lint, format, types, tests, build passed; 140 files passed / 31 skipped; 1753 tests passed / 238 skipped                                                                                     |
| `node "$TMPDIR/d6hc-gate-check.mjs"`                                                                                                                       | 0; discovery of all four, preferred ordering and sorted extras, empty directory rejection, missing module rejection, invalid explicit executable rejection, CLI exit 1 before harness execution |
| `PLAYWRIGHT_MODULE=<above> CHROMIUM_PATH=<above> npm run test:browser`                                                                                     | 0; build and all four harnesses passed with default output                                                                                                                                      |
| Same command with `BROWSER_OUTPUT_DIR=/opt/data/profiles/devbackend/cache/scratch/d6hc-external-output`                                                    | 0; build and all four passed; shell/surface results located under absolute override                                                                                                             |
| `npm run format:check` after each browser proof                                                                                                            | 0; generated default and external shell/surface output retained in place                                                                                                                        |
| `git diff --exit-code -- evidence` before adding this report                                                                                               | 0; all historical tracked evidence byte-identical after narrow legacy restoration                                                                                                               |
| `git diff --exit-code b6f28d4 -- scripts/run-browser-gate.mjs package.json tests/web/batch-detail.browser.mjs tests/web/scene-remediation.browser.mjs src` | 0; excluded files and runner semantics unchanged                                                                                                                                                |
| `git check-ignore -v evidence/.browser-run/surface/browser-results.json`                                                                                   | 0; matched new default-root ignore                                                                                                                                                              |
| `git diff --check`                                                                                                                                         | 0                                                                                                                                                                                               |

Both final browser runs reported: scene 124 cases; batch 70 combinations;
shell 98 cases; surface 48 combinations. Surface retains its base six-width matrix,
keyboard-region scrolling and resize sync; it does not claim separate F-UP coverage.

## Baseline safety and partial-integration limitation

Before execution, every tracked evidence file was snapshotted as bytes and SHA256;
Git evidence diff was empty. Shell/surface historical baselines remained unchanged
through execution: the proof asserts any changed baseline is confined to the
legacy scene/batch roots, before restoring anything.

Base scene/batch still write legacy paths. Each final combined run changed exactly
13 tracked scene files and created 42 legacy files (41 batch outputs plus scene
`primary-failures.json`). Generated bytes were archived first. Only the exact
changed tracked files were restored from captured clean bytes; only exact newly
created legacy files whose bytes matched the archive were removed. Full filename
lists are in `d6hc-browser-summary.json`. No broad checkout/reset/clean or user-change
discard occurred. All tracked historical evidence hashes matched afterward.

The initial all-four browser run passed, but the proof wrapper incorrectly assumed
legacy harnesses would create no new files; that wrapper exited 1. Its logs and
archive were retained. Exact archived generated files were cleaned, the wrapper
was corrected to handle newly created legacy outputs safely, and both complete
browser proofs and post-browser format checks then passed. A heartbeat initially
said 41 created files; the measured total was 42 and the card correction records it.

This is NOT proof that all four harnesses are isolated without restoration.
`t_d6135555` must explicitly integrate A, B, C commits, verify scene/batch namespace
changes, and repeat both browser runs and full verify without any restoration.
Parent D6R DB qualification remains BLOCKED; 238 skipped tests are not SQL green.
Independent integration/review and QA remain downstream. No release authorization,
main write, push, deployment, or human-gate completion/unblocking occurred.

## Durable evidence

`D6H-C-EVIDENCE.zip` delivered on this card contains the RED/GREEN contract checks,
proof scripts, unchanged-runner discovery/failure checks, verify and browser logs,
post-browser format logs, full baseline hash manifest and baseline archive,
archived generated legacy files, both isolated shell/surface output trees,
final revision/status evidence, and this report. Temporary scratch paths in commands
are provenance, not the only retained copy. The completion handoff records the
exact commit SHA and changed files; integration must cherry-pick explicitly.
