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

## D-G — Migrations run on boot (R-017-2 deviated)

**Rule:** R-017-2 keeps the web and worker entrypoints free of migration work; the
schema step is the profile-gated `migrate` one-shot, run before `up`.

**What we do instead:** `web` and both workers call `runMigrations` before they
serve, controlled by `MIGRATE_ON_START` (default `true`). `false` restores the
old contract exactly.

**Why:** the first deploy of the UI failed with `relation "operator" does not
exist` because a `pull` then `up -d` skipped the separate migration step. At
single-operator scale, an ordering rule that lives in a shell script is a rule
that gets skipped.

**Why it is safe:** `runMigrations` takes a `pg_advisory_lock` on a dedicated
connection, so replicas booting together serialise rather than race, and every
migration is recorded in `schema_migration` with a checksum, so the second caller
finds nothing pending. A migration that fails throws, the process exits, and the
container does not take traffic on a schema older than its code.

**Cost:** a slow migration lengthens boot and can trip the health check, which is
why `MIGRATE_ON_START=false` plus the one-shot remains the answer for a large or
risky change.

**Reversal:** set `MIGRATE_ON_START=false` in `.env` and keep `deploy/up.sh` as
the entry point; no code change needed.

## D-F — Object keys are readable paths, not content hashes (R-026 deviated)

**Rule:** R-026 makes `asset.object_key` a pure function of the content hash —
`CHECK (object_key = 'sha256:' || content_sha256)` plus `UNIQUE (content_sha256)`
— so the object store can never hold two blobs for one hash.

**What we do instead:** objects are addressed by where they belong —
`<series-slug>/batch-0001/scenes/S01.png`, `.../narration.mp3`, `.../video.mp4`,
`.../script.json`. `content_sha256` stays on the row as provenance, but it no
longer determines the key and no longer dedupes.

**Why:** the operator reads the bucket through a MinIO console. Content
addressing is the right shape for a deduplicating blob store and an opaque wall
of hashes for a human. "Which file is scene 7 of batch 2" has no answer when
every object is named after its bytes.

**Cost:** the same image used by two batches is stored twice, and a re-render
writes new bytes under the same path rather than reusing one object. For a
private factory where every video is unique content this is negligible; it buys a
library that can be read.

**Also deviates from R-017-3** (additive-only migrations): M-007 drops a CHECK
constraint and an index, which is structural. Applied while the stack is
pre-release, with one live batch. Existing objects stay at their `sha256:` keys
and remain readable — only new assets use the readable layout, so no data
migration is needed.

**Note for future work:** `ON CONFLICT (content_sha256)` no longer resolves;
asset writes must conflict on `object_key` instead. `batch.ordinal` (added in
M-007 and backfilled from creation order) is the stable number in the path —
deriving it from a count at read time would rename folders when a batch is
deleted.

**Reversal:** re-add the CHECK and the hash index, switch keys back to
`objectKeyFor(contentSha256)` in the storage port, and delete `batch.ordinal`.

## D-J — A finished stage may be held for approval (`done --gate--> awaiting_approval`) (2026-10-22)

TECH_DESIGN §4.2 lists `gate` only from `running`. The storyboard gate needs it
from `done`, because the orchestrator decides whether to advance _after_ the stage
has marked itself complete: by the time `advanceAfterStage` ran, SB was `done`, so
`done --gate-->` raised `IllegalTransitionError`. The error was swallowed by the
loop, which is why batch-0016 went straight into image generation and why the
first e2e run reported SB as `done` while the code looked correct.

The alternative — having the SB stage park itself instead of succeeding — would
mean stages knowing about approval, which is the orchestrator's job. One extra
edge is the smaller change.

`storyboardGateApplies()` also requires `state = 'done'`, so a duplicate advance
cannot re-gate a stage that is already waiting.

**Reversal:** drop the `gate` entry from `done` in `STAGE_TRANSITIONS`, and gate
from inside the SB stage before it succeeds.
