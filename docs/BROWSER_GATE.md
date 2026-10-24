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
