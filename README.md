# reels-generator

A private, single-operator, self-hosted factory for narrated vertical videos. One Docker Compose project on a Synology DS923+ takes a series definition (niche, voice, art style, duration) and produces reviewable, platform-ready 1080×1920 videos — script, images, narration, captions and render — then exports a ZIP you upload by hand.

Not a SaaS, not a publishing tool, not multi-tenant. One operator, one host, no GPU.

**Status: Milestone A implemented and integrated; release withheld.** The code is green (1,614 tests on a real Postgres) but two acceptance benchmarks are still open — see [Status](#status).

---

## What it actually does

A project moves through a stage rail. Every stage is inspectable, editable and independently regeneratable:

```
topic → research → script → storyboard → images → narration → timing → render → QC → export
                                                                    ↑
                                            approvals gate the billable stages
```

- **Approval gates.** Script approval is mandatory before any image or TTS call. Final approval is mandatory before export. Rejecting a gate rewinds to the named stage without firing billable calls downstream.
- **Staleness, not silence.** Editing anything shows, _before_ you commit, exactly what goes stale and what a regeneration would cost in calls (`image calls: 0 · TTS calls: 1 · render passes: 1`). Completed assets survive every edit they don't invalidate.
- **Per-stage pins.** A series can be edited mid-project. Each stage records the series version it ran under, so a mid-batch edit never retroactively changes already-generated media.
- **Batches of up to 30.** Each video is independently reviewable, independently retryable and independently failable. Retrying a failed video re-runs only its uncompleted stages and re-bills nothing already done.
- **Crash safety.** A provider attempt row is committed _before_ the socket opens. After a hard kill mid-call the reconciler marks the attempt `unknown_charge` and refuses to reissue it — deliberately preferring one manual operator action over a possible double charge, because none of the providers offer idempotency keys.
- **Export.** A ZIP per batch with the MP4s, `.srt`/`.vtt` captions derived from word timings, `manifest.csv`, and a source manifest for factual-mode claims.

Doubles as a design-document repo: the full PRD, architecture, UX/UI specs, build plan and QA report live at the root — see [Docs](#docs).

## Stack

| Layer             | Choice                                                            | Why                                                                                       |
| ----------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Runtime           | Node.js 20 / TypeScript                                           | matches the operator's stack; one language across web and workers                         |
| API + UI          | `node:http` server, server-rendered HTML                          | LAN tool, no SPA build step, no client state to keep in sync; only 5 runtime dependencies |
| Data              | PostgreSQL (+ `pgvector` for topic dedupe), Redis (BullMQ), MinIO | one durable store, one queue, one object store — all in Compose                           |
| Text & research   | DeepSeek chat + `/v1/tools/search`, `/v1/tools/fetch`             | cheap reasoning, native search with rerank scores                                         |
| Images            | `gemini-nano-banana-2.1` (9:16, 1K)                               | holds a character across scenes via reference images                                      |
| Voice             | ElevenLabs `convert-with-timestamps`                              | character-level alignment, grouped into word timings locally                              |
| Dedupe embeddings | bundled CPU-only ONNX MiniLM                                      | no fourth API key, no GPU, no per-call cost                                               |
| Render            | FFmpeg, baked into the worker image                               | free, deterministic, CPU-only                                                             |
| Deploy            | one `compose.yaml`, images built in CI and pulled by digest       | the NAS never builds                                                                      |

No GPU is used anywhere. Rendering is CPU-only and one render runs at a time by default.

## Status

`int/t_58f603ef` is the integrated Milestone A branch. QA's verdict is **not release-ready**, on two specific grounds:

| #   | Open item                                 | Why it's open                                                                                                         |
| --- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| D1  | Render wall-time + peak RAM on the DS923+ | measured on a dev container (1K: 200.5 s / 1,066 MB; 2K: 206.3 s / 1,257 MB) — the acceptance criterion names the NAS |
| D2  | 17-scene character-drift eyeball          | **run: 17/17 generated, 0 off-model** — awaiting the operator's own confirmation of the contact sheet                 |

Everything else in Milestone A is verified: lint, types, build, **1,614/1,614 tests on a real Postgres with 0 skips**, and a genuine forced-kill e2e (SIGKILL between provider call and asset write → exactly one billable request, attempt recorded `unknown_charge`).

Full detail in [`QA_REPORT.md`](QA_REPORT.md).

## Quick start

```bash
cp .env.example .env      # fill in the values; .env is gitignored and must never be committed
docker compose config -q  # validates the file and every required variable
docker compose --profile ops run --rm migrate
docker compose up -d
```

Then open `http://<host>:${APP_PORT}` and log in with the single seeded operator account. There is no registration, no password reset and no user management — this is a one-person tool on a private network.

One compose file ships. Application images are pulled from Docker Hub as
`:latest` with `pull_policy: always`, so a deploy is:

```
docker compose pull && ./deploy/up.sh
```

There are no release tags, digests or manifest files to exchange. **This is a
deliberate deviation from the approved design** (R-016-1 asked for digest
pinning): `:latest` is not reproducible, and rolling back means pinning a
previously published `<sha>` tag by hand. CI publishes both `latest` and a
`sha` tag per commit for exactly that reason. The full rationale and what is lost
is in [`DEVIATIONS.md`](DEVIATIONS.md) D-E. Third-party images (Postgres, Redis,
MinIO) keep explicit version tags.

**This build serves the HTTP API only.** `src/api/server.ts` mounts `/api/*`
plus the probes; the dashboard pages in `src/web/app.ts` are not mounted (they
need a DB-backed session store on the `reels_session` cookie and storage
adapters that do not exist yet). A page request answers `503` with an
explanation instead of redirecting, because the old behaviour redirected to an
unrouted `/login` and looped. Tracked as the UI integration card.

CI publishes each image to **both** Docker Hub (`wongjohnathanwh741/reels-generator-<service>`)
and GHCR from one build, and needs two repository secrets: `DOCKERHUB_USERNAME`
and `DOCKERHUB_TOKEN`.

### Environment

All names, no values — `.env.example` is the contract:

```
# app            APP_PORT APP_BASE_URL SESSION_SECRET SESSION_TTL_HOURS
# operator       OPERATOR_USERNAME OPERATOR_PASSWORD
# postgres       POSTGRES_HOST POSTGRES_PORT POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD
# redis          REDIS_URL
# object store   MINIO_ENDPOINT MINIO_ROOT_USER MINIO_ROOT_PASSWORD MINIO_BUCKET
#                MINIO_PUBLIC_ENDPOINT MINIO_IMAGE
# providers      DEEPSEEK_API_KEY DEEPSEEK_BASE_URL DEEPSEEK_MODEL RESEARCH_PROVIDER
#                GEMINI_API_KEY GEMINI_IMAGE_MODEL GEMINI_IMAGE_SIZE GEMINI_GROUNDING_MODEL
#                ELEVENLABS_API_KEY ELEVENLABS_VOICE_ID ELEVENLABS_MODEL_ID
# limits         PROVIDER_RATE_LIMIT_PER_MIN PROVIDER_TIMEOUT_IMAGE_S
#                PROVIDER_TIMEOUT_TTS_S PROVIDER_TIMEOUT_SEARCH_S
# render         MAX_RENDER_CONCURRENCY RENDER_MEM_LIMIT_MB RENDER_TIMEOUT_MIN
# release        RELEASE_TAG WEB_DIGEST WORKER_DIGEST OPS_DIGEST
# misc           RETENTION_DAYS LOG_LEVEL TZ
```

Three API keys, total. Startup validates the whole set and fails closed with the missing names listed.

## Repository layout

```
src/
  api/         HTTP surface, routes, health/readiness
  domain/      state machine, invalidation matrix (as data), retry scope, drift record
  adapters/    text, research, image, TTS — each with a deterministic fake
  workers/     queues, attempt wrapper, reconciler
  render/      FFmpeg pipeline, QC assertions, benchmark CLI
  export/      ZIP packaging, manifest, captions
  db/          migrations, repositories
  auth/ security/ storage/ boot/ config/ shared/ web/
contract/      OpenAPI + typed client + mock server (lets frontend and backend build in parallel)
tests/         integration + e2e (real Postgres, real ffmpeg, loopback fake providers)
evidence/      per-task acceptance evidence and benchmark artifacts
```

## Testing

```bash
npm run verify     # lint + typecheck + tests + build
npm test           # tests only; DB-dependent suites skip without TEST_DATABASE_URL
```

- **1,614 tests** with a real Postgres (`TEST_DATABASE_URL` set) — 0 skipped.
- Without a database, DB-dependent suites self-skip with a printed reason; nothing is quarantined for provider keys or network.
- **No test calls a paid provider.** Every adapter ships with a fake, and the e2e kill test uses a loopback HTTP server that counts requests and never answers.
- Render tests use the real FFmpeg binary (pinned in the worker image).

## Docs

| File                                                   | What it is                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [`PRD.md`](PRD.md)                                     | 39 requirements (28 P0), numeric acceptance criteria, rev 2.4                      |
| [`TECH_DESIGN.md`](TECH_DESIGN.md)                     | services, 22 tables, state machine, adapter contracts, FFmpeg pipeline, deployment |
| [`UX_SPEC.md`](UX_SPEC.md)                             | 21 screens, 14 interaction patterns, wireframes, accessibility requirements        |
| [`UI_SPEC.md`](UI_SPEC.md)                             | design system, components, 52 audited contrast pairs                               |
| [`LEAD_PLAN.md`](LEAD_PLAN.md)                         | task breakdown, dependency order, session estimates                                |
| [`QA_REPORT.md`](QA_REPORT.md)                         | independent verification, per-requirement verdicts, defects                        |
| [`RULINGS.md`](RULINGS.md)                             | design and scope rulings with reasoning                                            |
| [`QUALIFICATION_RESULTS.md`](QUALIFICATION_RESULTS.md) | measured provider behaviour (timings, credits, precision)                          |
| [`BACKLOG.md`](BACKLOG.md)                             | 38 user stories with traceability to requirements                                  |

`PRD_HASHES.md` is the single authoritative hash source for every artifact.

## What this deliberately does not do

- **No automated publishing.** No Instagram/Meta app, no TikTok Content Posting API, no YouTube quota management. You download a ZIP and post by hand. This removed an entire review-and-audit surface from the critical path.
- **No scheduling and no cron-created batches.** A batch exists only because the operator asked for one, with a target count. No timer can spend money here.
- **No billing or cost dashboard.** Call counts are recorded for debugging; there are no caps, no ledger, no invoices. Cost control is by not starting a batch.
- **No multi-tenancy.** One operator, one seeded account, LAN only. Google OAuth is a later concern, not a POC one.
- **No music.** Deliberate silence for now.

## Cost, measured

Per 75-second video: ~18 image calls ≈ **$0.60**, ~1,300 TTS characters ≈ **1,311 credits**, research/search a fraction of a cent. A 30-video batch is **~39,330 TTS credits**, which is why the ElevenLabs Creator tier is a floor rather than an option. Render is CPU-local and free.
