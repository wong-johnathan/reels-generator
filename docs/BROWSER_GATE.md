# Combined browser gate

Use the supported Node 20 runtime, install the project dependencies (`npm ci`), then run:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROMIUM_PATH=/absolute/path/to/chromium \
npm run test:browser
```

`test:browser` extends the existing runner name: it builds first and then runs every
present `tests/web/*.browser.mjs` in separate processes, sequentially:

1. `scene-remediation.browser.mjs`
2. `batch-detail.browser.mjs`
3. `shell-quality.browser.mjs`
4. `surface-followup.browser.mjs`
5. Any additional matching harnesses, sorted by filename.

Only present files are included (the runner prints its exact list as it runs).
An empty harness directory, unavailable tooling, failed launch, failed build or
failed assertion fails the gate; the first failing harness stops execution.
Dependency cards do not merge harness revisions: integration must include the
scene, batch and shell harness commits before claiming the expanded regression
coverage. The base branch may contain only three harnesses.

## Tooling discovery and reproducibility

- `PLAYWRIGHT_MODULE` selects an importable Playwright module file, not a package
  directory. Otherwise the runner resolves project-local `playwright`, then
  `playwright-core`. It does not search unrelated repositories.
- `CHROMIUM_PATH` selects the executable and is authoritative: an invalid explicit
  override fails instead of falling back silently. Older harnesses that omit
  `executablePath` receive this executable through a process-local launch adapter;
  their assertions and other launch options are unchanged.
- Without `CHROMIUM_PATH`, the runner tries Playwright's default executable, then
  Chromium revisions (newest first) in `PLAYWRIGHT_BROWSERS_PATH` or
  `~/.cache/ms-playwright`, then `~/Library/Caches/ms-playwright`, then `chromium`,
  `chromium-browser`, `google-chrome` and `google-chrome-stable` on `PATH`.
- Candidates must be executable and pass a real headless launch/close. The gate
  reports the selected module, executable and actual browser version. Harnesses
  retain their local `--no-sandbox` fixture launch configuration.
- No browser/package is installed or downloaded by the gate. If absent, provision
  an exact Playwright version in your CI tooling environment and install its
  matching browser (`npm exec -- playwright install chromium` from that tooling
  project), or supply the two absolute overrides above. Preserve the tooling lock
  file/container and browser version in CI evidence. This project deliberately
  does not add an unpinned browser dependency or change the application lockfile.
  Discovery is convenient locally; explicit overrides with pinned external tooling
  make repeated qualification runs reproducible.

## Coverage and evidence

`npm run verify` alone does **not** cover the responsive/interaction contract:
its Vitest `.test.ts` suite never invokes these `.browser.mjs` harnesses. Run both
`npm run verify` and `npm run test:browser` for qualification.

The combined runner executes the original harnesses without removing assertions,
including real Tab reach and ArrowRight scrolling on labelled `[role=region]`
containers in surface-followup. Root `overflow-x: clip` alone is not a containment
or keyboard-accessibility test. These are local SSR fixture tests, not authenticated
production transactions, provider tests or DB qualification.

### Generated output contract

Each harness resolves `process.env.BROWSER_OUTPUT_DIR || 'evidence/.browser-run'`
from the project working directory, then appends its own namespace:

| Harness           | Subdirectory |
| ----------------- | ------------ |
| scene-remediation | `scene`      |
| batch-detail      | `batch`      |
| shell-quality     | `shell`      |
| surface-followup  | `surface`    |

The combined runner sets each harness working directory to the project root.
JSON, screenshots and any other generated evidence belong inside that harness's
subdirectory, so shared filenames such as `browser-results.json` cannot collide.
The default `evidence/.browser-run/` is ignored by both Git and Prettier; tracked
historical evidence must not be overwritten or reformatted by qualification runs.
Archive a run before repeating it: the namespace separates harnesses, not runs.

To retain a separate run outside the repository, supply an absolute shared root:

```sh
BROWSER_OUTPUT_DIR=/absolute/path/to/browser-run \
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROMIUM_PATH=/absolute/path/to/chromium \
npm run test:browser
```

Relative overrides are also resolved from the project root; an empty override
uses the default. Ignore/format policy for any explicit override is caller-owned.
Prefer an external absolute directory (or a child of the ignored default root);
an arbitrary in-repository override is not automatically ignored. Run
`npm run format:check` after browser execution with generated output still present.

D6H integration note: the shell/surface isolation commit implements those two rows
only. At its base `b6f28d4`, scene/batch still write historical tracked evidence;
their sibling commits implement the other two rows. Before combined integration,
archive and restore only the exact scene/batch baseline files generated by a run,
after proving they had no pre-existing changes. Never discard user changes.
Integration must prove all four isolated outputs and byte-identical tracked
baselines without restoration; the shell/surface commit alone is not that proof.

### Retained lightweight regression checks (C-RET-1/2/4)

The integrated D6H base `a93e87fa56fbfbc49a95913172496c0d5e23d7cc` includes
all four isolated namespaces. `tests/web/browser-output-contract.test.ts` is
included in the existing Vitest suite and therefore in `npm run verify`:

```sh
node node_modules/vitest/vitest.mjs run tests/web/browser-output-contract.test.ts
```

These checks need only installed project dependencies, Node 20 and Git, not an
installed browser. They extract and evaluate each actual harness's bounded output
initializer (unset, empty, absolute and relative roots), failing explicitly if its
syntax changes. They do not import or execute the browser harnesses. Real
`git check-ignore` and the installed Prettier API check disposable nested JSON/PNG
fixtures plus a nonignored control. Unique fixture directories are removed in
`finally`; existing user files are never overwritten. Discovery, preferred/sorted
order, empty discovery, tool errors and CLI fail-fast are also retained against the
existing runner. Fake modules and disposable Git repositories exercise only
runner/proof-driver mechanics; they are NOT real browser qualification evidence.

### Opt-in repeatable real-browser output proof (C-RET-3)

After `npm ci` on supported Node 20, commit the intended changes and start from a
clean tracked AND untracked checkout. From the project root run:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROMIUM_PATH=/absolute/path/to/chromium \
node scripts/prove-browser-output.mjs /absolute/external/fresh-browser-proof
```

The final argument must NOT already exist. Its parent must already exist and be
canonical (no symlink aliases); the target must be outside this worktree AND its
primary repository, and must not contain either. The driver rejects dirty starts,
unsafe/existing targets and output symlinks before running children. Use exclusive
access to the checkout/output directories during proof; this is not a sandbox for
concurrent filesystem attackers. It requires explicit absolute tool overrides,
performs the runner's real launch/close check and never downloads tooling.

The driver removes inherited `TEST_DATABASE_URL` and `BROWSER_OUTPUT_DIR` from its
child environment and sequentially runs:

1. `npm run verify` (non-DB).
2. `npm run test:browser` with the default output root.
3. `npm run test:browser` with the supplied external absolute root.
4. `npm run verify` again, with BOTH generated output roots still present.

Every failed child, signal, missing/empty namespace, historical evidence change,
default-output change after the external run, final output change or dirty
checkout fails the proof. All four namespaces must contain JSON evidence. Existing
default outputs may be overwritten by the default browser run: archive them first
if needed. The proof never restores, deletes or formats generated/historical files
to manufacture a clean result, on success OR failure. The ordinary per-run
namespace is not a run-history store; use a fresh external target for each proof.

The external target contains `scene/`, `batch/`, `shell/`, `surface/` and `.proof/`.
Archive the entire target AND the default `evidence/.browser-run/` separately.
`.proof/result.json` records exact commit/tree/branch, runtime/executable, selected
browser/module/version, actual child exits/signals and log paths. Sibling JSON
manifests record relative filenames, byte lengths and SHA256 of tracked historical
evidence before/after each stage and both output roots, proving default bytes do
not change during external execution or final verify. Logs remain outside source;
the driver itself is deliberately NOT named `*.browser.mjs` and is never run by
the combined browser gate or normal verification.

A successful proof qualifies local Chromium SSR fixtures and non-DB checks only.
Skipped SQL tests remain BLOCKED, never green; other-SHA DB evidence cannot be
imported. It does not authorize release or certify authenticated/provider/media
end-to-end behavior. Preserve the installed Playwright package version and browser
tooling lock/container alongside the recorded paths and actual browser version.
