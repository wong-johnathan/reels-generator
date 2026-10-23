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

Harnesses write JSON/screenshots to their existing `evidence/` destinations; newer
harnesses can honour `BROWSER_OUTPUT_DIR` (consult each harness). Archive evidence
before rerunning, and keep generated evidence formatting/restoration separate from
source changes when subsequently running `verify`.
