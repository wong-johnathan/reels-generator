# F-UP-RETAIN browser regression retention

Scope: AX-22, AX-14, AX-17, AX-20 and the no-JS safe default. Test-only
changes; no product files, package scripts, specifications or user-facing copy changed.
Base: `b9b5fb8f1d197dcb3d06a7dc728047f4a21bfd26`, branch `wt/f-up-retain-tests`.
QA reference: `t_2a1bfecf/QA_EVIDENCE.zip`, `prepare_supplement.py` and `supplement.mjs`.

## Retained assertions

- All seven widths: 1440, 1024, 768, 767, 480, 390, 320; both JS modes.
- Four surfaces, 56 surface/width/JS combinations and 15 desktop POST dispatches.
- Four phone widths, two mutation surfaces, both JS modes: 16 real-Tab
  sequences of 70 presses. Script approve/apply/regenerate and series save
  must never receive focus. Series save is checked by element identity, not
  an assumed ID. Existing desktop series-region Tab/ArrowRight checks remain.
- Exact `No unsaved changes` phone script default in both JS modes (eight cases).
  No asynchronous preview is expected or tested with JavaScript disabled.
- Fourteen delayed ready/failed previews. Every resolved summary must match
  the exact expected copy. Desktop collapsed summaries remain hidden; phone
  summaries remain visible. Phone resolved text must also occur in the body
  accessibility snapshot. Resolved accessibility snapshots cannot retain
  `computing impact`.
- Body accessibility snapshots, screenshots and JSON results are generated
  under ignored `evidence/.browser-run/`, never the tracked baseline.

## Reproduction

Use supported Node `v20.20.2` on PATH:

```sh
env -u TEST_DATABASE_URL npm run verify
PLAYWRIGHT_MODULE=/opt/data/nfc-photo-keychain/node_modules/playwright/index.mjs npm run test:browser
BROWSER_OUTPUT_DIR=evidence/.browser-run/override PLAYWRIGHT_MODULE=/opt/data/nfc-photo-keychain/node_modules/playwright/index.mjs npm run test:browser
git diff --exit-code -- evidence/surface-followup
git check-ignore evidence/.browser-run/browser-results.json
```

`BROWSER_OUTPUT_DIR` accepts an absolute or working-directory-relative directory.
The default is repository-relative, regardless of the working directory. Overrides
outside the ignored directory are caller-owned: use an external directory or add
an appropriate ignore rule in your integration environment.

## Verification and limitations

Supported-Node20 non-DB verification: 139 test files passed, 31 skipped;
1731 tests passed, 232 skipped. Skips require a disposable database and are
not claimed as SQL verification. The sibling DB seam and integration cards
own DB-enabled qualification. Browser checks use local fixture renderers and
Chromium, not a production service or other browser engines.

Default-output and override-output browser gates passed with the retained
assertions. Generated output is ignored by Git and the normal Prettier gate;
the tracked `evidence/surface-followup/` baseline is unchanged. Execution logs
and generated browser evidence accompany the task handoff. Initial exploratory
Node26 execution is not the supported-runtime acceptance result; foreground
time-limited runs were rerun through tracked background processes.

This card is implementation evidence only, not independent QA, release approval,
main-branch integration, publication or deployment.
