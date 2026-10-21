# Deviations from the frozen design set

Owner-approved departures from `PRD.md` rev 2.4 / `TECH_DESIGN.md` rev 1. Each
entry names the requirement it contradicts, the decision, and what is lost. The
design documents are not edited retroactively; this file is the record.

---

## D-E — Application images track `:latest` instead of a digest pin (2026-10-21)

**Contradicts:** R-016-1 ("every image is pinned by tag and digest").

**Decision:** `compose.yaml` pulls `wongjohnathanwh741/reels-generator-{web,worker,ops}:latest`
from Docker Hub, with `pull_policy: always` on all five application services.
`RELEASE_TAG`, `WEB_DIGEST`, `WORKER_DIGEST`, `OPS_DIGEST` and `MINIO_IMAGE` are
removed from `compose.yaml`, `.env.example` and `.env.template`, and CI no longer
publishes an `images.env` manifest.

Rationale: one tag keeps the deploy to `docker compose pull && ./deploy/up.sh`
with nothing to paste between machines. Digest pinning required copying four
values per release and keeping them in sync with `.env`.

**What is given up:**

- **Reproducibility.** The same compose file run two weeks apart can run different
  code. `:latest` is mutable; there is no immutable identity in the deploy.
- **Rollback by reference.** Rolling back means pinning a previously published
  `sha` tag by hand (docs/DEPLOYMENT.md §6). CI still publishes `:<sha>` per commit
  — that is the escape hatch, and it is the reason the sha tag must not be dropped.
- **Fail-loud pinning.** A missing pin used to stop compose with a `:?` guard.
  Now a missing publication is discovered at pull time.

**Guardrails kept in code:**

- `pull_policy: always` on every application service, so a redeploy cannot silently
  reuse a cached image — the failure mode that makes `:latest` genuinely dangerous.
- Third-party images (`postgres:16-alpine`, `redis:7-alpine`,
  `quay.io/minio/minio:RELEASE.…`) keep explicit tags, so a Postgres major never
  drifts under a running database.
- `tests/compose.test.ts` fails if `@sha256:` or any release variable reappears in
  `compose.yaml` or the env templates, so the two deploy models cannot coexist.

**Reversal:** restore the digest refs in `compose.yaml`, re-add the five keys to
the env templates, and reinstate the `release-manifest` job in
`.github/workflows/build.yml` (git history has it at `9c17b6b`).
