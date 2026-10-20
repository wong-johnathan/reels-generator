# Deployment guide — reels-generator (Milestone A)

Audience: the single operator, on the Synology DS923+ (x86_64, 20 GB RAM, no GPU).
This guide covers first install, start, upgrade, rollback and data safety. It is
the R-016-1 deployment guide; `tests/compose.test.ts` asserts the rules it encodes.

The NAS never builds and never installs application dependencies. CI builds `web`,
`worker` and `ops` for `linux/amd64`, pushes them to GHCR, and prints the digests
the NAS pulls by. Everything else runs as a pinned upstream image.

## 1. Prerequisites

- Docker Engine with the Compose v2 plugin (`docker compose version`).
- Free space for the compose project and its volumes. Budget at least 20 GB for
  images, Postgres, Redis and the MinIO bucket.
- Outbound HTTPS to `ghcr.io`, Docker Hub and the provider APIs.
- A GHCR credential that can read the private packages (`docker login ghcr.io`).
- A `linux/amd64` object-store image reference (see §2.5).

No Node.js, FFmpeg or database client is installed on the host.

## 2. First install

### 2.1 Get the release

    git clone https://github.com/wong-johnathan/reels-generator.git
    cd reels-generator
    git checkout <release-tag>

### 2.2 Create the environment file

The repository tracks a names-only template at `.env.example`. Copy it to `.env`
in the compose project directory, restrict it to the operator
(`chmod 600 .env`), and fill every value.

The template ships no values. At minimum:

- `SESSION_SECRET`: at least 32 random characters (`openssl rand -hex 32`).
- `OPERATOR_USERNAME` / `OPERATOR_PASSWORD`: the single operator account; the
  password is at least 12 characters and becomes an argon2id hash when seeded.
- `POSTGRES_*`, `REDIS_URL`, `MINIO_*`: store coordinates. Inside compose the
  hosts are the service names (`postgres`, `redis`, `minio`).
- `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`,
  `ELEVENLABS_VOICE_ID`: provider credentials, read by the worker only.
- `RETENTION_DAYS`: defaults to 365 (R-025-1).

Optional keys fall back to documented defaults when left empty; the validator
reports only keys that are required for the role or malformed.

### 2.3 Add the release pins

CI's `release-manifest` job publishes `images.env` carrying `RELEASE_TAG`,
`WEB_DIGEST`, `WORKER_DIGEST` and `OPS_DIGEST`. Append that file to `.env` so
compose can resolve the pins. The digest values are the bare 64-character hex
digest; `compose.yaml` supplies the `sha256:` prefix itself, so never paste
`sha256:` into these variables.

`compose.yaml` references those values with `:?` guards, so a missing pin fails
loudly instead of pulling `latest`. Never edit digests by hand: they are the
release identity, and a tag alone is not pinned.

### 2.4 Log in to GHCR

    docker login ghcr.io -u <github-user>

### 2.5 Pin the object-store image

Set `MINIO_IMAGE` to a tag and digest, for example:

    MINIO_IMAGE=quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z@sha256:<64 hex>

Resolve the digest with `docker buildx imagetools inspect <ref>` and confirm
`linux/amd64` is listed. This is the only image compose cannot pin for you:
`minio/minio` is no longer served by Docker Hub and quay.io requires registry
auth, so the reference is operator-supplied.

## 3. Start

`deploy/up.sh` is the supported entry point. It checks the environment file and
the release pins, runs the migration one-shot, starts the stack detached, and
prints `docker compose ps`.

    ./deploy/up.sh

The migration step on its own (safe to re-run; B-02 makes it idempotent):

    docker compose --profile migrate run --rm migrate

Why two steps: `migrate` and `backup` are profile-gated one-shots, and Compose
cannot express `depends_on` from an always-on service to a service outside the
active profile. TECH_DESIGN §9.2 asks for "web/workers depend on migrate"; the
supported equivalent is the ordered script. Migrations run only in the `migrate`
one-shot, never in the web or worker entrypoint (R-017-2).

Expected result:

- six containers running: `web`, `content-worker`, `render-worker`, `postgres`,
  `redis`, `minio`;
- only `web` publishes a host port (8080); the stores stay on the private compose
  network (R-016-3);
- every health check reports healthy, and `/readyz` returns HTTP 200 with
  `{"ready":true,"degraded_reasons":[]}`.

While a store is down the web container still starts, `/readyz` returns HTTP 503
with the dependency named in `degraded_reasons`, and it recovers by itself when
the store answers again (R-018-1/2).

## 4. Data safety

Persistent state lives in named volumes plus two host bind mounts:

| Data              | Location                         | Survives a normal stop | Survives the volume flag |
| ----------------- | -------------------------------- | ---------------------- | ------------------------ |
| Postgres          | `pgdata` volume                  | yes                    | no                       |
| Redis AOF         | `redisdata` volume               | yes                    | no                       |
| MinIO bucket      | `miniodata` volume               | yes                    | no                       |
| Backups           | `./backups` bind mount           | yes                    | yes                      |
| Non-secret config | `./config` bind mount, read-only | yes                    | yes                      |

The Compose `down` command stops and removes containers but keeps every volume;
it is the normal stop command.

WARNING: never add the volume-removal flag to that command — `down -v` also
removes the three data volumes above, destroying the database, the queue state
and every stored asset with no in-app undo. If you think you need it, take a
backup first and read §7.

The environment file is never baked into an image (`.dockerignore`) and never
committed (`.gitignore`; CI fails if it ever appears in history).

## 5. Environment validation (R-016-5)

Every container enters through the validator, not the application:

    node dist/src/boot/validate-env.js --role <web|worker|ops|migrate> --exec <command>

It reports every missing or malformed key in one message and exits non-zero
before starting work. Values are never printed: a secret that is wrong is still a
secret.

| Role      | Also requires                                        |
| --------- | ---------------------------------------------------- |
| `web`     | app/session keys and stores                          |
| `worker`  | stores, all three provider credentials, the voice id |
| `ops`     | stores (plus the backup tooling delivered by US-002) |
| `migrate` | stores only                                          |

Example failure shape:

    Configuration invalid for role "web" — 2 problem(s) found before startup:

      MISSING  SESSION_SECRET     required, expected at least 32 characters of random data [hint: openssl rand -hex 32] (secret — value never printed)
      MISSING  POSTGRES_PASSWORD  required, expected non-empty secret (secret — value never printed)

    Fix these in .env (every name is listed in .env.example, names only) and restart the service.

Validate without starting a long-running process:

    docker compose run --rm --no-deps web --role web

## 6. Upgrade and rollback (R-017-3)

Migrations within a release line are additive and backward-compatible, so an
image rollback is valid.

Upgrade: fetch the new `images.env`, replace the four pin lines in `.env`, run
`docker compose pull`, then `./deploy/up.sh`, then check `/readyz` and the
container health checks.

Rollback: restore the previous `RELEASE_TAG` and digest lines, run
`docker compose pull`, then `./deploy/up.sh`. Data and in-flight jobs persist in
the volumes.

A structural (breaking) migration is not rolled back by image tag. Release notes
must say so, and the recovery is restore-from-backup (§7).

## 7. Backup and restore (Milestone B boundary)

B-01 builds and pins the `ops` image, but the backup runner (`pg_dump`, MinIO
mirror, config copy, restore-tested) is US-002 / R-017-5, Milestone B. Until it
lands, the `backup` profile starts and exits 1 with an explicit "not implemented"
message rather than pretending a backup happened.

Take a manual Postgres dump before any risky operation. Restore, and the
re-export of a prior video, are documented and tested with US-002.

## 8. Verification checklist (release acceptance)

The B-01 signal is a manual, on-hardware check:

- [ ] `git log --all -- .env` on the release tag prints nothing.
- [ ] `images.env` exists for the tag and carries three `sha256:` digests.
- [ ] `docker compose config --quiet` succeeds with the release `.env` in place.
- [ ] On a clean box, `docker compose pull` succeeds and `./deploy/up.sh` starts
      all six services with no local build.
- [ ] `docker compose ps` shows every service healthy; only `web` publishes 8080.
- [ ] Stopping and starting again leaves all data intact.
- [ ] Removing `SESSION_SECRET` makes the `web` container exit with a message
      naming `SESSION_SECRET`.

## 9. Troubleshooting

| Symptom                                 | Cause                                 | Fix                                                                       |
| --------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------- |
| `RELEASE_TAG must be the release tag …` | pins not appended to `.env`           | §2.3                                                                      |
| `MINIO_IMAGE must be a digest-pinned …` | object-store image not set            | §2.5                                                                      |
| `manifest unknown` or `denied` on pull  | wrong digest or missing GHCR login    | re-check `images.env`; `docker login ghcr.io`                             |
| `web` exits listing keys                | environment incomplete                | fill the named keys (§2.2)                                                |
| `/readyz` 503 after start               | a store is still booting or unhealthy | `docker compose ps`, `docker compose logs <service>`                      |
| `migrate` exits non-zero                | schema or migration failure           | previous version keeps running; read the log, fix forward or restore (§7) |
