# D6H-CRET — retained browser output-contract proof

Task: t_56e12a8e. NONBLOCKING test-infrastructure retention, C-RET-1…4 / existing T4.
No product defect, approval or release is inferred. Original A/B/C scoped acceptance
at base `a93e87fa56fbfbc49a95913172496c0d5e23d7cc` remains immutable.

## Ownership and implementation

Branch: `wt/d6h-output-contract`, isolated project worktree
`/opt/data/engineering-team/projects/reels-generator/.worktrees/d6h-output-contract`.
Base tree: `397bc4693a9f2df0a41108e3bb1095e357fc9672`.
Initial implementation commit: `22c6fdd70eb6977f1559759d01fa26d5ecdb518c`;
initial implementation tree: `857d8824ef92be2713fa1d57ded2479be9e4b4c3`.

Only these four paths belong to this lane:

- `tests/web/browser-output-contract.test.ts`: 16 lightweight Vitest tests, included
  in existing `verify`, no browser installation needed.
- `scripts/prove-browser-output.mjs`: opt-in real proof; NOT a discoverable browser
  harness. No existing runner edits.
- `docs/BROWSER_GATE.md`: exact focused-test/proof invocation, tooling and safety
  preconditions, output/archive semantics and limitations.
- `evidence/D6H-CRET.md`: this report.

C-RET-1 evaluates every actual bounded `const output = …` initializer in isolation,
not a reimplemented output helper. All four names and namespace uniqueness, cwd,
unset/empty/absolute/relative roots are checked; syntax drift fails explicitly.
C-RET-2 uses real Git and installed Prettier on unique JSON/PNG fixtures and a
nonignored control; finally cleanup removes only owned fixtures.
C-RET-4 imports the actual runner exports for preferred/present-only/sorted-extra
and empty discovery, missing/malformed module and invalid/failed authoritative
executable checks. Actual copied CLI also demonstrates sequential fresh-process
fail-fast with child exit19. Fake tooling is explicitly mechanics-only.

C-RET-3 uses clean tracked/untracked starts, fresh canonical external targets,
real launch/close, non-DB child environments and strict command exits/signals.
It retains historical evidence fingerprints, then checks each stage against them,
all four nonempty JSON namespaces, default bytes unchanged after external execution,
both roots unchanged by final verify and clean source. No restoration, cleanup or
formatting manufactures green. Disposable driver tests cover dirty starts,
relative/inside/existing/symlink targets, ignored output symlinks, missing namespace,
historical/default mutation, failed child and environment sanitization.

After the first real proof below, the final implementation additionally retains
actual historical bytes in external `.proof/historical-bytes/` with exclusive
copies checked against the initial fingerprint. These bytes are NEVER restoration
inputs. Its focused success test checks that the retained snapshot is real.
A second full exact-final-commit proof follows this report/snapshot commit;
its authoritative exact SHA/tree, exits and counts are in external
`.proof/result.json` and the final handoff, not a self-referential Git hash here.

## Executed qualification on initial implementation

Runtime explicitly pinned to Node `v20.20.2`, npm `10.8.2`:
`/opt/data/kanban/boards/engineering-team/workspaces/t_6359ef9a/tools/node-v20.20.2-linux-x64/bin/`.
`npm ci` exit0 (215 packages added, existing audit advisories:1 moderate/2 critical).
Focused `node node_modules/vitest/vitest.mjs run tests/web/browser-output-contract.test.ts`
exit0,16 passed; scoped ESLint, full typecheck, scoped Prettier check and
`git diff --check` exit0.

Real tooling, explicitly supplied (no downloads by driver):

- `PLAYWRIGHT_MODULE=/opt/data/nfc-photo-keychain/node_modules/playwright/index.mjs`;
  installed package version `1.63.0` read from its package.json.
- `CHROMIUM_PATH=/opt/data/home/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
  CLI `Google Chrome for Testing 153.0.8010.12`, real launch/close version
  `153.0.8010.12` recorded by existing runner.

Executed from clean checkout at initial implementation commit:

```sh
export PATH=/opt/data/kanban/boards/engineering-team/workspaces/t_6359ef9a/tools/node-v20.20.2-linux-x64/bin:$PATH
PLAYWRIGHT_MODULE=/opt/data/nfc-photo-keychain/node_modules/playwright/index.mjs \
CHROMIUM_PATH=/opt/data/home/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome \
node scripts/prove-browser-output.mjs "$TMPDIR/d6h-cret-proof-node20"
```

Driver exit0. Actual child results:

| Stage                                   | Exit | Observed results                                                                     |
| --------------------------------------- | ---- | ------------------------------------------------------------------------------------ |
| verify before                           | 0    | lint/format/typecheck/build pass;1769 passed,238 skipped;141 files passed,31 skipped |
| default combined browser                | 0    | scene138,batch336,shell98,surface48;all4 PASS                                        |
| absolute external combined browser      | 0    | scene138,batch336,shell98,surface48;all4 PASS                                        |
| verify after, both output roots present | 0    | lint/format/typecheck/build pass;1769 passed,238 skipped;141 files passed,31 skipped |

Both roots contained225 files. All180 currently tracked `evidence/**` files were
byte-identical across stages, including the three inherited D6H lane reports.
The older177 historical-baseline count excludes those reports; it is not the
current entire tracked-evidence count. Default225 files were byte-identical after
external execution and final verify; external225 files survived final verify
unchanged. Checkout remained clean without restoration or generated formatting.
Logs/manifests initially under `$TMPDIR/d6h-cret-proof-node20/.proof/`; durable
copies and final exact-SHA proof are preserved in `coverage/d6h-cret/` and archive.

## Tests-first and honest fault sensitivity

Initial tests-first execution:13 tests,8 pass/5 fail. Four failures were genuinely
missing new proof-driver file; one was test fixture setup (missing default parent),
fixed only in owned tests. First implementation then passed13; expanded retained
coverage passed16. Initial typecheck found an overly narrow test env type and lint
found missing URL import; corrected in owned files and subsequent checks passed.

Disposable copies only — never mutations to existing checkout harnesses/ignores:

| Injected fault                      | Observed detection                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| shell namespace collides with scene | actual initializer expected-path checks                                                             |
| `                                   |                                                                                                     | `changed to`??` | explicit bounded syntax-drift failure |
| remove Git default ignore           | real Git fixture assertion                                                                          |
| remove Prettier default ignore      | real Prettier fixture assertion                                                                     |
| blanket-ignore evidence in Git      | nonignored control assertion                                                                        |
| blanket-ignore evidence in Prettier | nonignored control assertion                                                                        |
| reverse preferred scene/batch order | actual discovery regression and CLI order assertion                                                 |
| remove proof child-failure guard    | fake child writes valid namespaces then exits23; subsequent execution rejected by trace/exit checks |

Final sensitivity driver exit0; all8 expected mutant children exit1; unmodified
control and restored disposable copy each16 passed. Source checkout unchanged by
faults. Initial sensitivity attempt detected7, but removed exit guard escaped the
fake fixture because it exited BEFORE creating any namespace, masking the missing
exit guard with output absence. This was a test gap, not a product defect. Strengthened
fixture exits AFTER writing valid outputs; corrected8-case experiment passes.
Original attempt logs, including the escaped probe, remain in the evidence archive.

A first background real-proof attempt unexpectedly inherited default Node26.5.1
rather than the foreground Node20 PATH. It was deliberately killed during initial
format:check (no completed command or browser harness), verified no child processes
remained, and is NOT qualifying evidence. Its partial logs/result remain archived.
The successful run above and final run explicitly export the Node20 PATH.
One initial npm-ci-with-redirection command and one node `-p` tooling lookup were
policy-refused before execution; ordinary npm ci and file reads/CLI discovery
succeeded. No security configuration or dependency version was changed.

## Protected behaviors, review and limitations

No `src/**`, existing harness, existing `scripts/run-browser-gate.mjs`, package,
lock, config, dependency, ignore, specification or tracked historical baseline
edits. All existing browser assertions, build-first discovery, preferred order,
sequential/fresh-process execution and fail-fast semantics remain unchanged.
No duplicate A/B assertions or separate F-UP/DB chain imported.
`tests/web/surface-followup.browser.mjs` is a read-only hotspot owned by separate
F-UP assertion work; this lane only reads its output initializer.

SQL qualification remains BLOCKED;238 skips are not green. No other-SHA SQL pass
is imported. These are local Chromium SSR fixtures with JS-on/off enhancement
limits unchanged, not authenticated/provider/media end-to-end or global release
qualification. Existing dependency advisories and approval-provenance drift are
unchanged. No main writes, push, merge, deployment, publication, credentials or
human approval action. The precreated integration/review child must explicitly
integrate exact commits and independently reverify; dependency completion is not
merge, QA, approval or release.
