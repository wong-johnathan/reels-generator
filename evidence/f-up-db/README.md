# F-UP-DB: explicit database-proof FFmpeg boundary

Task: t_36d29a61. Branch: `wt/f-up-db-seam`.
Base verified: `b9b5fb8f1d197dcb3d06a7dc728047f4a21bfd26`.

## Change and scope

Only `src/worker/pipeline.e2e.test.ts` changes executable code. The test now selects
its existing 16,384-byte stub runner by default. Only
`REELS_E2E_REAL_RENDER === '1'` selects `ProcessFfmpegRunner`; FFmpeg discovery on
PATH no longer selects the runner. The regression covers unset, `0`, `true`, and
`1` with the host PATH and with an empty PATH, restoring environment afterward.
All existing durable-row assertions and the 300,000 ms timeout remain unchanged.
No production, schema, dependency, renderer, or render-half-proof changes.

## TDD evidence

Recovered from the preceding interrupted attempt on this same task/worktree:

- `red.log`: `npm run test -- src/worker/pipeline.e2e.test.ts -t 'selects the stub'`
  failed the new identity assertion: actual `ProcessFfmpegRunner`, expected stub,
  while selection still used host FFmpeg discovery (1 failed, 2 filtered/skipped).
- `green.log`: same regression after explicit environment selection passed
  (1 passed, 2 filtered/skipped).

The resumed attempt inspected the diff and these logs before rerunning both full
verification gates. The prior incomplete DB gate is not treated as a pass.

## Runtime and disposable native database

- Node: `v20.20.2` from
  `/opt/data/kanban/boards/engineering-team/workspaces/t_e2605f0d/node-v20.20.2-linux-x64/bin`.
- Independently checked `node20.tar.xz` SHA256:
  `df770b2a6f130ed8627c9782c988fda9669fa23898329a61a871e32f965e007d`.
- Host FFmpeg present: `/usr/bin/ffmpeg`, version `7.1.5-0+deb13u1`.
- Fresh native PostgreSQL `16.14` cluster, `pgcrypto 1.3`, `vector 0.8.2`;
  see `db-version-run346.log`.
- Reused native runtime binaries in
  `/opt/data/profiles/devbackend/cache/scratch/t_5163bfb4-runtime/package/native/bin`.
- Initialized a separate cluster at
  `/opt/data/profiles/devbackend/cache/scratch/t_36d29a61-pg-run346`, trust auth,
  loopback only, port `56346`, user/database `reels_test`.
- Disposable-cluster-only options: `fsync=off`, `synchronous_commit=off`,
  `full_page_writes=off` (not production settings or application changes).
- Real connections used
  `TEST_DATABASE_URL=postgresql://reels_test@127.0.0.1:56346/reels_test`.
  The test helper creates independent native databases; no SQL mocks substitute
  for the DB gate. The cluster is stopped after verification.

## Executed verification (resumed attempt)

`npm ci` completed (215 packages). It reported 3 dependency vulnerabilities
(1 moderate, 2 critical); no dependency edits or audit fixes were made.

Both full gates ran with the supported Node directory first on PATH, with
`REELS_E2E_REAL_RENDER` unset and FFmpeg present:

1. `TEST_DATABASE_URL=postgresql://reels_test@127.0.0.1:56346/reels_test npm run verify`
   - Exit 0, including lint, format check, typecheck, tests, and build.
   - 170/170 test files; **1964/1964 tests passed**, no skips.
   - Test duration 229.09 s.
   - `pipeline.e2e.test.ts`: 3 passed in 15,331 ms (no timeout).
   - Unchanged `render-half-proof.test.ts`: 1 passed in 22,395 ms.
   - Raw output: `verify-db-run346.log`, ending `VERIFY_EXIT_CODE=0`.
2. `env -u TEST_DATABASE_URL npm run verify`
   - Exit 0, including lint, format check, typecheck, tests, and build.
   - 140 passed / 30 skipped files; **1732 passed / 232 skipped** tests,
     1964 total. Database skips are expected and are not DB evidence.
   - Test duration 204.05 s.
   - Unchanged `render-half-proof.test.ts`: 1 passed in 31,220 ms.
   - Raw output: `verify-no-db-run346.log`, ending `VERIFY_EXIT_CODE=0`.

The card's expected 1963 baseline becomes 1964 with the new selection regression;
no existing test was removed. These gates ran concurrently against the same
unchanged source; final standalone formatting verification covers this document.

## Limitations and downstream handoff

Full-length 17-scene 1080p real-encode performance remains unresolved/outside this
DB proof. Its previously diagnosed >300-second execution on the real runner is
not fixed or hidden by this change. Real-media coverage remains independently
exercised by the unchanged render-half proof; full encode can still be explicitly
requested with `REELS_E2E_REAL_RENDER=1` and is not claimed qualified here.

The resumed native host is different from the interrupted attempt's host, so the
older timing figures are not a performance comparison. pg emitted its existing
client-query deprecation warning; the gates still exited 0.

Integration/review belongs to child t_f97f2398 and independent QA afterward.
No main-branch writes, push, deployment, human-gate approval, or specification
changes. Dependency completion does not integrate this branch.
