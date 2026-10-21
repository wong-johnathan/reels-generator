# Deployment guide — reels-generator (Milestone A)

Audience: the single operator, on the Synology DS923+ (x86_64, 20 GB RAM, no GPU).
This guide covers first install, start, upgrade, rollback and data safety. It is
the R-016-1 deployment guide; `tests/compose.test.ts` asserts the rules it encodes.

The NAS never builds and never installs application dependencies. CI builds `web`,
`worker` and `ops` for `linux/amd64` and publishes each one to Docker Hub and GHCR.
The NAS pulls the Docker Hub images by the `:latest` tag on every deploy
(`pull_policy: always`), so there are no release tags or digests to paste anywhere.
Everything else runs as an upstream image.

Trade-off, stated once: `:latest` is not reproducible. Two deploys a week apart can
run different code, and "roll back" means pinning a previously published `sha` tag
by hand (§6). If you need to reproduce an exact build, use that `sha` tag — CI
publishes one per commit alongside `:latest`.

## 1. Prerequisites

- Docker Engine with the Compose v2 plugin (`docker compose version`).
- Free space for the compose project and its volumes. Budget at least 20 GB for
  images, Postgres, Redis and the MinIO bucket.
- Outbound HTTPS to Docker Hub, `quay.io` and the provider APIs.
- No registry credentials for the application images: they are public on Docker Hub.
  `quay.io` may require `docker login quay.io` for the object store (§2.4).

No Node.js, FFmpeg or database client is installed on the host.

## 2. First install

### 2.1 Get the release

    git clone https://github.com/wong-johnathan/reels-generator.git
    cd reels-generator
    git checkout <release-tag>

### 2.2 Create the environment file

The repository tracks two templates: `.env.template` (generated from the startup
validator, with required keys marked and working defaults filled in) and
`.env.example` (names only, the tracked contract). Copy the generated one:

    cp .env.template .env
    chmod 600 .env

Fill every line marked REQUIRED and delete the rest you do not need.

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

### 2.3 Object-store image

`compose.yaml` hardcodes one reference:

    image: quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z

It is hardcoded because `minio/minio` is no longer published on Docker Hub (404)
and the quay.io manifest is not anonymously resolvable, so there is no verified
digest to point at. If your NAS cannot pull that ref, mirror the image locally and
change that single line. `MINIO_IMAGE` no longer exists as a variable.

### 2.4 Registry access

Application images come from Docker Hub and need no login. Only the object store
may require credentials:

    docker login quay.io

### 2.5 Nothing else to pin

There are no release variables to append. `RELEASE_TAG`, `WEB_DIGEST`,
`WORKER_DIGEST`, `OPS_DIGEST` and `MINIO_IMAGE` were removed with the switch to
`:latest` — see `DEVIATIONS.md` D-E.

## 3. Start

`deploy/up.sh` is the supported entry point. It checks the environment file,
pulls the newest application images, runs the migration one-shot, starts the stack
detached, and prints `docker compose ps`.

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

Upgrade: `docker compose pull`, then `./deploy/up.sh`, then check `/readyz` and
the container health checks. That is the whole procedure — `:latest` moves on its
own, and `up.sh` pulls explicitly because `up` alone would reuse the cached image.

Rollback: `:latest` cannot take you back. CI publishes a `sha` tag per commit, so
pin that commit's build temporarily:

    docker compose images web            # see which tag/id is running now
    docker tag <registry>/reels-generator-web:<sha> <registry>/reels-generator-web:latest
    docker compose up -d

or edit the three `image:` lines in `compose.yaml` to `:<sha>` and run
`./deploy/up.sh`. Data and in-flight jobs persist in the volumes.

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
- [ ] `grep -c 'sha256:' compose.yaml` prints `0` (no digest pins by design, D-E).
- [ ] `docker compose config --quiet` succeeds with the release `.env` in place.
- [ ] On a clean box, `docker compose pull` succeeds and `./deploy/up.sh` starts
      all six services with no local build.
- [ ] `docker compose ps` shows every service healthy; only `web` publishes 8080.
- [ ] Stopping and starting again leaves all data intact.
- [ ] Removing `SESSION_SECRET` makes the `web` container exit with a message
      naming `SESSION_SECRET`.

## 9. Troubleshooting

| Symptom                                              | Cause                                                   | Fix                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| `pull access denied` for `reels-generator-*`         | image never published, or wrong org in `DOCKERHUB_USER` | check the Actions run; §2.4                                               |
| `unauthorized` pulling `quay.io/minio/...`           | object store needs a login                              | `docker login quay.io` (§2.4)                                             |
| dashboard shows “Web UI not available in this build” | this build mounts the API only                          | expected; the UI integration card adds the pages                          |
| redeploy still runs old code                         | cached `:latest`                                        | `docker compose pull` first; `pull_policy` covers it                      |
| `web` exits listing keys                             | environment incomplete                                  | fill the named keys (§2.2)                                                |
| `/readyz` 503 after start                            | a store is still booting or unhealthy                   | `docker compose ps`, `docker compose logs <service>`                      |
| `migrate` exits non-zero                             | schema or migration failure                             | previous version keeps running; read the log, fix forward or restore (§7) |
