# Technical design — reels-generator

**Revision:** 1 (draft for the human design gate)
**Author:** CTO
**Date:** 2026-10-20
**Status:** Awaiting human design approval. No production code is produced by this document.

## 0. Grounding and verified inputs

Every authoritative input was re-hashed on disk before design work. `PRD_HASHES.md` is treated as authoritative where a value differs from an older task body.

| Input | Rev | sha256 (measured 2026-10-20) | Matches |
|---|---|---|---|
| `PRD.md` | 2.3 | `f9a4d48e86c5677328ee8fadd66fb3653b650a10a7ac371750d96d0c725038f9` | yes |
| `BACKLOG.md` | 2.2 | `ced1e2abddbe11dc44cd25d7dcea32cfbf0ce8698d3aaa6a827e5c0832debb66` | yes |
| `UX_SPEC.md` | 1.0 | `93aeb482bccfe08eb89a6c869906c93c31aba43c3803e1b68a869e5045ebbda5` | yes |
| `UI_SPEC.md` | 1.0 | `ed62f12281bf77994f218378ca5562b3b77586ef9b039b919579a63af97d74c0` | yes |
| `QUALIFICATION_RESULTS.md` | 1.0 | `36b75edf8189c893bd95f81f6894e6e38207f97d5df5e37d9f01f3990514b807` | yes |
| `APPROVAL.md` | 2.3 | `106eec8042daa27de23706593be5fc74a79c9eb8d1c111e0dc23b1c0d94ecd40` | yes |
| `RULINGS.md` | — | `8b07dcd0904582fe546696dae71853d805f849f469dd9fc2d17569f86f1cd23a` | yes (no entry in `PRD_HASHES.md`) |

Bindings applied throughout: owner decisions D1–D13 (`APPROVAL.md`), the five design rulings C-1…C-5 (`RULINGS.md`), and the measured provider behaviour in `QUALIFICATION_RESULTS.md` (image 768×1376 @1K at ~17 s/call; TTS 11.4 s and 1,311 credits per 75 s; narration pace 3.035 words/s; DeepSeek search precision 1-of-5 above the 1.5 rerank threshold).

### 0.1 Repository finding (greenfield)

The remote `https://github.com/wong-johnathan/reels-generator.git` was inspected read-only on 2026-10-20. It is **empty** ("This repository is empty", no commits, no files). The local project directory is a plain directory, not a git checkout.

Greenfield constraints that follow, and that are NOT assumed away:
- There is no language, framework, monorepo layout, CI, or lint/test baseline to extend. This design selects all of them (§2.1).
- `.gitignore` must exist from the first commit and must ignore `.env` and any local secrets (APPROVAL.md, R-015-5, "repo is public").
- The first code commit will establish the directory layout, toolchain pinning (`.nvmrc`/`.tool-versions`), and the migration baseline; nothing is inherited.
- No secret may ever be committed; only `.env.example` ships (names only, no values).

### 0.2 Cross-cutting decisions (read first)

| # | Decision | Trace |
|---|---|---|
| X-1 | **Single application language: TypeScript on Node.js 20 LTS** for web, content worker, render worker and the migration job, shared from one repository. Python/FastAPI was the considered alternative; equal complexity but a second runtime toolchain with no compensating benefit. The state machine is the highest-risk code and benefits from a single strict type system. | — |
| X-2 | **Server-rendered HTML + progressive enhancement**, no SPA framework. The UI is forms, links and tables; a client framework is not required and would put focus management (AX-06/07) and native semantics at risk. | UI_SPEC §10.2 #8 |
| X-3 | **Postgres is the system of record for all state.** Redis/BullMQ is a *transport and lease* layer only. Resumability across worker AND Redis restart is reconciled from Postgres, never from Redis memory. | R-011-1, R-023 |
| X-4 | The DB table named `project` **is** what the UX/PRD calls a "video" (R-002-4 uses "project" for the same object). One `project` row = one reel. | R-002-4 |
| X-5 | Stage codes are the 11 UX canonical codes: `T RS SC SB IM NA TC RE QC FA EX` (FA and EX are gates, not producing stages). | UX §0.2, IP-03 |
| X-6 | All three providers today expose **no honoured client idempotency key**. Every billable stage is therefore recorded `idempotency-unprotected` (R-012-2), and the ≤1-billable guarantee is delivered by a *pending-attempt-never-auto-reissued* rule (§5.4), not by provider idempotency. | R-012-2/3/4 |
| X-7 | Render, QC and export run in one **render-worker**; all provider-bound stages run in one **content-worker**. The split is resource-shaped (CPU/RAM-bound vs network/rate-limit-bound), not provider-shaped. | §2 |
| X-8 | A `project` carries **one pin per stage** (the version in effect when the stage last started), stored on `video_stage.series_version_id`; generated assets additionally record their own version on `asset.series_version_id`. | R-002-2/4, D1, OQ-6 |

---

> **Hash authority (LEAD_PLAN C-5):** the hashes quoted in §0 are the ones verified at authoring time (PRD 2.3 / BACKLOG 2.2). After the design gate the artifacts moved to PRD rev 2.4 / BACKLOG rev 2.4; **`PRD_HASHES.md` is the single authoritative hash source** for all downstream work.

## 1. Architecture overview

### 1.1 Diagram

```
                          ┌─────────────────────────────────────────────────────────────┐
                          │                     DS923+ (x86_64, 20 GB, no GPU)          │
                          │                    single Docker Compose project            │
                          │                                                             │
   Operator (LAN browser) │   :8080 (the ONLY published host port)                      │
        │                 │      │                                                      │
        ▼                 │      ▼                                                      │
   ┌─────────┐            │  ┌──────────────┐                                           │
   │ Browser │─── HTTPS?──┼─▶│  web (app)   │── SSE feed ──▶ browser (progress)         │
   └─────────┘ (http LAN) │  │  SSR UI +    │                                           │
                          │  │  JSON API +  │                                           │
                          │  │  session     │                                           │
                          │  └──┬───┬───┬───┘                                           │
                          │     │   │   │                                               │
              private     │     │   │   └──────────────▶ ┌────────────┐                 │
              network     │     │   │       read/write   │  minio     │  (assets,      │
              only ───────┼─────┼───┼────────────────────▶│  S3 object │   derivatives, │
                          │     │   │                    │  store     │   exports)     │
                          │     │   │                    └────────────┘                 │
                          │     │   │                                                    │
                          │     ▼   ▼                                                    │
                          │  ┌──────────────┐     jobs/leases     ┌──────────────┐       │
                          │  │  postgres    │◀───────────────────▶│    redis     │       │
                          │  │  (record)    │                     │  (BullMQ +   │       │
                          │  │  16          │                     │   pub/sub +  │       │
                          │  └──────────────┘                     │   semaphore) │       │
                          │        ▲                              └──────┬───────┘       │
                          │        │ state (only worker writes      │ enqueue/claim    │
                          │        │ generation_run/attempts)      │                   │
                          │        │                                │                   │
                          │  ┌─────┴──────────────┐        ┌────────┴──────────┐        │
                          │  │  content-worker    │        │  render-worker    │        │
                          │  │  (provider stages) │        │  (render+QC+exp)  │        │
                          │  │  T RS SC SB IM NA  │        │  RE QC EX +       │        │
                          │  │  TC (local timing) │        │  reframe check    │        │
                          │  └───┬────┬────┬──────┘        └───────┬───────────┘        │
                          │      │    │    │                       │ FFmpeg/ffprobe    │
                          └──────┼────┼────┼───────────────────────┘                   │
                                 │    │    │                                           │
                  DeepSeek       │    │    └─────────────▶ ElevenLabs (TTS)            │
                  (chat/search/  │    └──────────────────▶ Gemini nano-banana-2.1     │
                   fetch) ◀──────┘                        (images 768×1376 @1K)        │
                          ┌─────────────────────────────────────────────────────────────┘
                          │  one-shot: migrate (runs migrations, exits 0; profile-gated)
                          └  one-shot: backup (pg_dump + minio mirror; profile-gated)
```

### 1.2 Request path narrative (browser to rendered file)

1. The operator logs in on the LAN at the published web port. `web` verifies the argon2id password, sets an httpOnly session cookie (R-015-2), and every subsequent route (except `/login`) requires that session (R-015-4).
2. The operator creates a batch from a series (S-07). `web` opens one transaction that: (a) asserts the series is `active` (R-001-3), (b) validates `target_count ∈ 1..30` (R-019-1), (c) INSERTs one `batch` row recording the series version id (R-019-2), (d) INSERTs `target_count` `project` rows and 11 `video_stage` rows per project (all `not_run`). **This is the only code path that creates a batch** — there is no scheduler, no cron, no timer code anywhere (R-019-4; verified by a test that asserts no code path inserts `batch` except this endpoint).
3. The operator reviews the topic (S-09) and script (S-10). `web` runs schema validation (R-004), the 8-gram reference scan (R-003-2), and in `factual` mode the per-claim citation check (R-027). Approving the script (a `review_decision` row) is mandatory before any billable call (R-005-2).
4. On approval, `web` enqueues stage jobs into Redis (BullMQ): storyboard (SB), then one image job per scene (IM), narration (NA), then timing (TC, local). `web` never calls a provider.
5. `content-worker` claims a job, and for every provider call it (a) INSERTs a `generation_run` row and a `job_attempt` row and commits **before** the HTTP call (R-012-1), (b) invokes the adapter, (c) stores the returned asset in MinIO keyed by content hash (R-026), (d) marks the run billed/succeeded and advances the stage. TC derives word timings from the ElevenLabs character alignment locally (3.035 words/s grouping) and remaps scene spans.
6. `render-worker` claims the RE job (single render slot), runs FFmpeg, writes the MP4 + `.srt`/`.vtt` + poster to MinIO, and runs the QC probe (R-010). QC pass → FA gate opens.
7. On final approval (FA, a `review_decision`), `web` enqueues EX; `render-worker` builds the per-video package and (for a batch) the ZIP + `manifest.csv` (R-014).
8. `web` serves downloads via short-lived MinIO presigned URLs and streams progress over SSE (Redis pub/sub fan-out), so the 30-row table updates within 5 s of any state change (R-022-1).
9. The operator records posting in `publication_log` (R-014-4). The system never publishes (D8).

Every process writes only through its declared boundary: `web` = UI/API/auth/enqueue + *reads* of state; `content-worker` = provider stages + `generation_run`/`job_attempt` writes + asset writes; `render-worker` = render/QC/export + asset writes; `migrate` = schema; `backup` = pg_dump + MinIO mirror.

---

## 2. Service decomposition

### 2.1 Services and responsibilities

| Service | Image | Responsibility | Published | RAM budget | Restart |
|---|---|---|---|---|---|
| `web` | `web` | SSR UI + JSON API, session auth, enqueue, SSE origin, presigned-download issuance, degraded-startup handling (R-018) | **yes** (`8080`) | 512 MB | `unless-stopped` |
| `content-worker` | `worker` | Claims content-stage jobs; DeepSeek/Gemini/ElevenLabs adapters; writes `generation_run` before calls; derives word timings; stores assets | no | 512 MB | `unless-stopped` |
| `render-worker` | `worker` | Claims render/QC/export jobs; FFmpeg/ffprobe; single-render-slot semaphore; reframe check | no | 2 GB (cap) | `unless-stopped` |
| `postgres` | `postgres:16-…` (amd64) | System of record | no | 2 GB | `unless-stopped` |
| `redis` | `redis:7-…` (amd64) | BullMQ queues, distributed leases, pub/sub, rate-limit buckets | no | 256 MB | `unless-stopped` |
| `minio` | `minio-…` (amd64) | S3-compatible object store (assets, derivatives, exports, backups mirror target) | no | 512 MB | `unless-stopped` |
| `migrate` (profile) | `worker` | Runs pending migrations once, exits 0 | no | 512 MB | one-shot |
| `backup` (profile) | `ops` | `pg_dump` + `mc mirror` to a host bind mount, exits 0 | no | 512 MB | one-shot |

`web` and both workers share one codebase (`worker` image = same build, different `CMD` + `ENTRYPOINT`). `content-worker` and `render-worker` are the same binary started with a `ROLE=content|render` switch; they differ only in which queues they consume and the memory cap applied.

### 2.2 Justification of boundaries

- **web vs workers** — the request/response UI must stay responsive and is never allowed to make a long provider or FFmpeg call; workers are the only spend/CPU boundary. Degraded startup (R-018) means `web` must serve "service not ready" while workers are down, which requires them to be separate.
- **content-worker vs render-worker** — content is network-bound and rate-limited (10 req/min/provider, R-008-2); render is CPU/RAM-bound and must hold at most one render slot (R-104, default 1). If a render OOMs or spins the CPU, provider calls must not be starved, and vice-versa. Their memory budgets and scaling rules differ (render is the only service with a 2 GB cap and a 1-slot semaphore).
- **postgres / redis / minio** — one store per role: durable truth (Postgres), transport/leases (Redis), blobs (MinIO). This is the smallest decomposition that still satisfies R-016-3 (only web published; the rest private) and R-026 (content-addressed blobs in one store).
- **migrate one-shot** — migrations run once per deployment via a profile-gated one-shot service, never in every worker (R-017-2).

### 2.3 What is deliberately collapsed (and why)

- **API into web** — the UI is server-rendered; the JSON endpoints and the HTML renderer share one process and one session layer. A separate API service would add a network hop and a duplicated auth surface for zero benefit at single-operator scale.
- **QC and export into render-worker** — they are CPU/disk-bound local operations like render and use the same FFmpeg/ffprobe tooling; a third worker would be a mostly-idle process. The single-slot semaphore is applied to render only; export/QC run at their own (low) concurrency.
- **Timing/captions (TC) into content-worker** — word-timing derivation is a cheap local transform of the ElevenLabs alignment, not a provider stage; it belongs to the worker that already holds the alignment payload.
- **The per-stage pin store into `video_stage`** — a stage has exactly one current pin, so a separate pin table would be a 1:1 shadow of `video_stage` (see §3).

### 2.4 Compose `profiles:`

```yaml
# compose.yaml (skeleton)
services:
  web:        { profiles: [""],  image: ".../web:1.0.0@sha256:..." }   # always
  content-worker: { profiles: [""], image: ".../worker:1.0.0@..." }
  render-worker:  { profiles: [""], image: ".../worker:1.0.0@..." }
  postgres:   { profiles: [""], image: "postgres:16-alpine@..." }
  redis:      { profiles: [""], image: "redis:7-alpine@..." }
  minio:      { profiles: [""], image: "minio/minio:RELEASE...@..." }
  migrate:    { profiles: ["migrate"],  image: ".../worker:1.0.0@..." }   # one-shot
  backup:     { profiles: ["backup"],   image: ".../ops:1.0.0@..." }      # one-shot
```

`profiles: [""]` means "always up with `docker compose up`". `migrate` and `backup` are explicit: `docker compose --profile migrate run --rm migrate` and `docker compose --profile backup run --rm backup`. This keeps the steady-state footprint to six always-on services.

---

## 3. Data model

Conventions: Postgres 16. Primary keys are `uuid` (`gen_random_uuid()`). All state columns are `text` with a `CHECK` constraint (not a Postgres enum) so the value set can grow with a backward-compatible migration (D11/R-017-3). `timestamptz` everywhere. `jsonb` for versioned payloads and versioned provider schemas. Two extensions: `pgcrypto` (UUIDs) and `pgvector` (topic-dedupe cosine search, R-020).

### 3.1 Required tables (13)

#### `series` — a series profile
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `name` | text not null | |
| `slug` | text not null unique | URL/filename-safe |
| `niche` | jsonb not null | subject, audience, boundaries, language, location, prohibited_topics, preferred_sources |
| `script_style` | jsonb | tone, structure hints |
| `voice_config` | jsonb | voice_id, speed, style (D5) |
| `art_style` | jsonb | preset, palette, recurring_protagonist bool, protagonist refs |
| `default_aspect_ratio` | text not null default '9:16' | D13 |
| `target_duration_s` | int not null default 75 | R-009-1 |
| `narration_language` | text | |
| `captions_preset` | jsonb | |
| `music_config` | jsonb | null = silence (Q2 default) |
| `image_resolution` | text not null default '1K' | 768×1376 (D10) |
| `mode` | text not null check (`mode` in ('factual','creative')) | R-027-1 |
| `status` | text not null check (`status` in ('active','archived')) | R-001-3 |
| `current_version_id` | uuid FK → series_version | denormalized latest |
| `revision` | int not null default 1 | optimistic lock (R-024) |
| `created_at`/`updated_at` | timestamptz | |

Indexes: `unique(slug)`; `idx_series_status(status)`.
Invariant: a `series` always has ≥1 `series_version`; `current_version_id` points to the max version; an `archived` series accepts no new batch/topic (enforced in the service layer, asserted by test); editing a series never mutates an existing `project` (R-001-4).

#### `series_version` — immutable snapshot of a series edit
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `series_id` | uuid FK → series (on delete restrict) | |
| `version` | int not null | strictly increasing per series (R-002-1) |
| `snapshot` | jsonb not null | the full profile at this version (immutable) |
| `mode` | text not null | denormalized for cheap filter (R-027) |
| `target_duration_s` | int not null | denormalized |
| `voice_id` | text | denormalized |
| `art_preset` | text | denormalized |
| `created_by` | uuid FK → operator | |
| `created_at` | timestamptz | |

Indexes: `unique(series_id, version)`; `idx_sv_series(series_id)`.
Invariant: `version` is minted monotonically (service holds a per-series lock); rows are immutable (UPDATE revoked to app role); `snapshot` is the single source for "what the profile looked like at vN" (R-002-1). A duplicate (R-001-2) copies `snapshot` into a new `series`, and does not copy history.

#### `project` — one video
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `batch_id` | uuid FK → batch (nullable) | null only for the Milestone A single-video slice |
| `series_id` | uuid FK → series not null | |
| `topic_id` | uuid FK → topic (nullable) | set after topic stage |
| `position_in_batch` | int | posting-order default = creation order (R-014-2) |
| `target_duration_s` | int nullable | per-video override; null = inherit series (R-009-1) |
| `status` | text check in ('NOT_STARTED','RUNNING','NEEDS_ATTENTION','COMPLETE','CANCELLED') | §4 |
| `current_stage` | text check in 11 stage codes | denormalized for the batch table (UI §10.2 #1) |
| `storyboard_revision` | int not null default 1 | optimistic lock for reorder (R-024) |
| `lead_s` / `trail_s` | real not null default 0.5 / 0.5 | render pad |
| `created_at`/`updated_at` | timestamptz | |

Indexes: `idx_project_batch(batch_id)`; `idx_project_series(series_id)`; `unique(batch_id, position_in_batch)`; `idx_project_status(status)`.
Invariant: one topic per project; positions unique within a batch; `current_stage` always equals the single non-terminal stage (asserted on write).

#### `batch` — one explicit owner request
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `series_id` | uuid FK not null | |
| `series_version_id` | uuid FK → series_version not null | version at creation (R-019-2) |
| `target_count` | int check (1..30) not null | R-019-1 |
| `status` | text check in ('ACTIVE','COMPLETE','CANCELLED') | §4 |
| `created_by` | uuid FK → operator | |
| `created_at`/`cancelled_at` | timestamptz | |

Indexes: `idx_batch_series(series_id)`; `idx_batch_status(status)`.
Invariant: created **only** by the explicit owner endpoint (no scheduler code path exists — R-019-4); `target_count` enforced by CHECK; `completed_count` is computed live via a partial index on `project.status` (30 rows ⇒ trivial), satisfying R-022-1's 5 s freshness without a denormalized counter to drift.

#### `topic` — proposed topic (one per project)
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid FK → project not null | |
| `title` | text | |
| `description` | text | |
| `normalized_text` | text not null | dedupe key, R-020-1 |
| `embedding` | vector(1536) | pgvector, cosine (R-020-1) |
| `rationale` | text | |
| `source_links` | jsonb | workflow step 1 |
| `dedupe_status` | text check in ('none','rejected','overridden') | |
| `dedupe_match_topic_id` | uuid FK → topic (nullable) | the surfaced match (R-020-3) |
| `status` | text check in ('proposed','approved','rejected') | |
| `revision` | int not null default 1 | optimistic lock (R-024) |
| `created_at` | timestamptz | |

Indexes: `idx_topic_project(project_id)`; `idx_topic_norm(normalized_text)`; `hnsw(topic_embedding vector_cosine_ops)`.
Invariant: within a batch no two topics share identical `normalized_text` or cosine ≥0.85; the last N=10 projects of the series are checked with the same rule (R-020-2); a rejection surfaces `dedupe_match_topic_id` for confirm/override (R-020-3).

#### `source` — captured research source
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid FK → project not null | |
| `url` | text not null | |
| `title` | text | |
| `snippet` | text | |
| `summary` | text | 600–800 char model-oriented summary |
| `content` | text | page body when fetched |
| `domain` | text | |
| `published_at` | timestamptz | RFC3339, nullable (sparse) |
| `retrieved_at` | timestamptz not null | R-014-1 |
| `rerank_score` | real | acceptance threshold ≥1.5 |
| `status` | text check in ('accepted','rejected') | |
| `created_at` | timestamptz | |

Indexes: `idx_source_project(project_id)`; `idx_source_url(url)`.
Invariant: an `accepted` source has `rerank_score ≥ 1.5` and a non-empty `url`; only accepted sources are offered in the claim source picker (R-008-3 threshold, UC-20).

#### `script_revision` — versioned script document
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid FK → project not null | |
| `revision` | int not null default 1 | the script document revision: monotonic per project AND the optimistic-lock token (R-024-1) |
| `content` | jsonb not null | hook, narration, ending, title, description, hashtags, claim refs (versioned schema) |
| `schema_version` | text not null | R-004 |
| `word_count` | int | |
| `estimated_runtime_s` | real | `word_count / 3.035` |
| `eight_gram_scan_pass` | bool | R-003-2 |
| `eight_gram_violations` | jsonb | failing 8-gram runs (nullable) |
| `status` | text check in ('draft','approved','rejected') | |
| `approved_by` / `approved_at` | uuid FK / timestamptz | |

Indexes: `unique(project_id, revision)`; `idx_sr_project(project_id)`.
Invariant: only the latest revision is editable; approval requires `eight_gram_scan_pass` and (factual mode) all claims resolved (R-005-2, R-027-3). Note: `script_revision.revision` is the *document* revision for locking (R-024-1); the `revision` integer column name is overloaded but kept as the PRD names it.

#### `scene` — one storyboard scene
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid FK → project not null | |
| `scene_no` | text not null | stable id `S01…S17`, never changes on replace/reorder (R-007-2) |
| `position` | int not null | current order; reorder changes only this |
| `narration_start_ms` / `narration_end_ms` | int | span from approved narration |
| `image_prompt` | text | |
| `camera_move` | text | Ken Burns preset (zoom_in/zoom_out/pan_l/pan_r/static) |
| `caption_emphasis` | text | |
| `fallback_text` | text | |
| `uses_protagonist` | bool | |
| `asset_id` | uuid FK → asset (nullable) | current image |
| `revision` | int not null default 1 | optimistic lock for prompt edits (R-024) |
| `created_at` | timestamptz | |

Indexes: `idx_scene_project_pos(project_id, position)`; `unique(project_id, scene_no)`.
Invariant: `scene_no` is stable across replace and reorder; reorder touches `position` only, never `scene_no` or `asset_id` (R-006-3, R-007-2/3); captions remap via `position`.

#### `asset` — content-addressed blob + provenance
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid FK → project (nullable) | owning project (null for shared music) |
| `stage` | text check in ('IM','NA','RE','QC','EX','MUSIC','POSTER','DERIV','REF') | |
| `scene_id` | uuid FK → scene (nullable) | |
| `kind` | text | image/audio/video/caption/sidecar/zip/derivative |
| `content_sha256` | text not null | the dedupe key (R-026) |
| `object_key` | text not null | MinIO key = `sha256:<content_sha256>` (content-addressed) |
| `object_size_bytes` | bigint | |
| `mime_type` | text | |
| `width` / `height` | int | images/video |
| `series_version_id` | uuid FK → series_version | version in effect at generation (R-002-2, R-013-1) |
| `provider` / `model` | text | R-013-1 |
| `seed` / `provider_request_id` | text | R-013-1, R-008-4 |
| `prompt_hash` | text | |
| `prompt_text` | text | provenance (R-013-1) |
| `rights_metadata` | jsonb | voice/licence context (R-013-1, §10) |
| `generation_run_id` | uuid FK → generation_run (nullable) | the call that produced it |
| `retention_eligible_at` | timestamptz | `created_at + retention_days` (R-025-1) |
| `created_at` | timestamptz | |

Indexes: `unique(content_sha256)`; `idx_asset_project(project_id)`; `idx_asset_retention(retention_eligible_at)`.
Invariant (R-026): one row per unique content hash; `object_key` is a pure function of `content_sha256`; object-store object count therefore equals unique-hash count (R-026-2). Shared music across series is modelled by the M:N link `asset_ref` (§3.2), never by duplicating the blob.

#### `generation_run` — one provider call (debug cost row)
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | written **before** the call (R-012-1) |
| `job_attempt_id` | uuid FK → job_attempt not null | |
| `project_id` | uuid FK → project not null | |
| `stage` | text check in provider stages ('T','RS','SC','SB','IM','NA') | render/QC/export never appear here (X-7) |
| `scene_id` | uuid FK → scene (nullable) | image calls |
| `provider` / `model` | text | D2/R-012 |
| `prompt_hash` | text not null | |
| `schema_version` | text | for text stages |
| `provider_request_id` | text | |
| `idempotency_key` | text | null where unsupported |
| `idempotency_protected` | bool not null default false | R-012-2 (false for all three providers today) |
| `billed_units` | numeric | debug only (D2) |
| `charge_status` | text check in ('pending','billed','unbilled','unknown') | 'unknown' = may have billed (R-012-4) |
| `status` | text check in ('pending','succeeded','failed','timed_out','unknown') | |
| `error_class` | text | transient / non_retryable |
| `http_status` | int | |
| `attempt_no` | int | 1..3 (R-011-2) |
| `series_version_id` | uuid FK → series_version | |
| `asset_id` | uuid FK → asset (nullable) | |
| `created_at`/`started_at`/`ended_at` | timestamptz | |

Indexes: `idx_gr_project(project_id)`; `idx_gr_job_attempt(job_attempt_id)`; `idx_gr_charge(charge_status)`.
Invariant: **one row per provider call**; the row exists and is committed before the HTTP call is issued (structural, §5.4); `billed_units > 0` only when `charge_status='billed'`; a timeout that may have billed is `charge_status='unknown'`, never `unbilled` (R-012-4). No ledger UI, no caps, no totals are computed over this table (D2).

#### `job_attempt` — one queue execution of a job (retry ledger)
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `job_id` | uuid FK → job not null | |
| `attempt_no` | int not null | 1..3 |
| `status` | text check in ('pending','running','succeeded','failed','timed_out','unknown_charge','cancelled') | |
| `worker_id` | text | |
| `started_at`/`heartbeat_at`/`finished_at` | timestamptz | |
| `error_class` | text | transient / non_retryable (R-011-2) |
| `error_message` | text | |
| `http_status` | int | |
| `backoff_s` | int | 1 / 4 / 16 (R-011-2) |
| `created_at` | timestamptz | |

Indexes: `unique(job_id, attempt_no)`; `idx_ja_job(job_id)`.
Invariant: attempts are strictly sequential per job; `backoff_s` for transient retries is exactly {1,4,16} for attempts 1,2,3; non-retryable failures never create a further attempt (R-011-2).

#### `review_decision` — operator gate / staleness ledger
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid FK → project not null | |
| `stage` | text check in ('SC','SB','IM','FA','STALE') | gate or staleness-accept |
| `decision` | text check in ('approve','reject','accept_staleness','acknowledge_unsourced') | |
| `target_stage` | text | the named return stage on reject (R-005-4) |
| `reason` | text | required on reject |
| `revision_at_decision` | int | the document revision judged |
| `decided_by` / `decided_at` | uuid FK / timestamptz | |

Indexes: `idx_rd_project(project_id, stage)`.
Invariant: script approval (SC/approve) is recorded before any IM/NA job may enqueue (R-005-2); final approval (FA/approve) before EX (R-005-3); a reject records `target_stage` and fires no downstream billable call (R-005-4); `accept_staleness` is the only non-regeneration path that clears a stale flag.

#### `publication_log` — manual posting record
| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `project_id` | uuid FK → project not null | |
| `platform` | text not null | |
| `posted_at` | timestamptz not null | ISO-8601 UTC (R-014-4) |
| `url` | text | |
| `posted_flag` | bool not null default false | R-014-4 |
| `posted_by` | uuid FK → operator | |
| `created_at` | timestamptz | |

Indexes: `idx_pl_project(project_id)`; `idx_pl_posted(posted_flag)`.
Invariant: setting `posted_flag=true` flows into the next export's `manifest.csv` `posted_flag` column (R-014-4). Posting is manual-only (D8); no code path writes this table except the operator's "mark posted" action.

### 3.2 Supporting tables (8)

| Table | Purpose | Key columns / invariant |
|---|---|---|
| `job` | the queue's durable mirror (unit of work = stage or scene-image) | `id`, `project_id`, `stage`, `scene_id?`, `status`, `priority`, `retry_scope jsonb` (computed and stored **before** run, R-022-2). The reconciler re-enqueues any `running`/`queued` job with no live lease on worker start (R-023). |
| `video_stage` | per-stage state + the **per-stage pin** (R-002-2/4) | `id`, `project_id`, `stage`, `state` (8 values), `series_version_id?` (the pin, set when the stage starts), `stale bool`, `stale_cause`, `stale_revision`, `stale_at`, `last_event_at`, `last_event`, `progress_current`, `progress_total`. `unique(project_id, stage)`. 11 rows minted per project at creation. |
| `claim` | per-video factual claims (R-027) | `id`, `project_id`, `script_revision_id`, `text`, `is_factual`, `status` ('sourced','url_unreachable','unsourced','acknowledged_unsourced','non_factual'), `source_id?`, `acknowledged_by?`, `acknowledged_at?`, `url_status`, `url_reachable_at`. |
| `reference` | series references for the 8-gram scan (R-003) | `id`, `series_id`, `title`, `source_text` (stored, never sent to providers — R-003-3), `extracted_style_summary` (editable), `rights_note` (R-003-4). |
| `operator` | the single seeded operator (D3) | `id`, `username unique`, `password_hash` (argon2id), `created_at`. Seeded at first migration; no registration/reset path. |
| `session` | httpOnly session (R-015-2) | `id`, `operator_id`, `token_hash` (server stores the hash of the cookie value), `expires_at`, `created_at`. |
| `invalidation_rule` | the invalidation matrix **as data** (R-006 in one place) | `edit_kind` PK, `invalidated_stages text[]`, `survives text[]`, `image_calls int`, `tts_calls int`, `render_passes int`, `text_action text`, `conditional_check text?`, `description`. Seeded by migration; see §4.3 for the exact rows. |
| `asset_ref` | M:N asset↔project link for shared content (music across series, R-026) | `asset_id`, `project_id`, `role`. Dedupe stays invisible (US-007). |
| `provider_qualification` | recorded adapter qualification (R-008-3) | `provider`, `adapter`, `passed bool`, `details jsonb`, `run_at`. The worker refuses a billable call when the adapter's latest record is not `passed`. |

Table count: **13 required + 9 supporting = 22 tables**. *(Corrected: the §3.2 enumeration lists nine supporting tables; the earlier "8 supporting / 21 total" was a miscount — LEAD_PLAN contradiction C-1.)*

### 3.3 Optimistic locking and the 409 (R-024)

- Editable documents carry a monotonic `revision` int: `series` (profile), `topic`, `script_revision`, `scene` (prompt), and `project.storyboard_revision` (reorder order).
- Save is a single conditional `UPDATE ... SET ..., revision = revision + 1 WHERE id = $1 AND revision = $2`. If 0 rows are affected, the service reads the current row and returns **HTTP 409** with `{ document, current_revision, your_revision }` and no lost update (R-024-2). The UI renders IP-09 (compare / keep-my-text / discard).
- Storyboard locking is satisfied by `scene.revision` for per-scene prompt edits plus `project.storyboard_revision` for reorder, so a concurrent reorder and prompt edit conflict deterministically.

### 3.4 Content-hash dedupe (R-026)

- The write path hashes bytes (`sha256`) **before** the object exists; `object_key = 'sha256:' || content_sha256`; the INSERT into `asset` uses `unique(content_sha256)`. A duplicate (same music, same prompt+seed image) hits the unique index, the row is reused, and the new reference is recorded via `asset_ref`/`scene.asset_id` with no second blob. Object-store object count therefore equals unique-hash count (R-026-2). A DB↔MinIO reconciliation job (in the `backup` profile) verifies this equality.

### 3.5 Structural guarantee for "attempt row before provider call" (R-012-1)

The provider adapter interface has a single entry point `execute(run: GenerationRun): Promise<Result>` that takes an **already-persisted** `generation_run.id`. The worker flow is: (1) `INSERT generation_run` (status `pending`, charge `pending`) + `INSERT job_attempt` in one transaction and `COMMIT`; (2) call `adapter.execute(run)` — the only place an HTTP client exists; (3) update the row. Because the adapter cannot receive a prompt without a persisted run id, and every provider HTTP client is constructed inside an adapter, there is no code path that issues a provider call without a committed `generation_run` row. This is enforced by a test that instantiates the adapters and asserts the run id is non-null and committed (visible to a second connection) before the socket opens.

---

## 4. Workflow state machine

This is the highest-risk area. The state machine is implemented as a pure, typed module (`src/domain/state-machine.ts`) that is the single source of truth for every legal transition; the `invalidation_rule` table is the single source of truth for *what an edit invalidates* (R-006 lives in one place, as data). All transitions are guarded and asserted in tests.

### 4.1 Stage codes and stage states

Codes (11): `T` topic, `RS` research/sources, `SC` script, `SB` storyboard, `IM` images, `NA` narration, `TC` timing/captions, `RE` render, `QC` quality check, `FA` final approval (gate), `EX` export (gate).

Stage states (8): `not_run`, `running`, `done`, `awaiting_approval`, `stale`, `failed`, `blocked`, `cancelled` (UX §6 / UI §3.1).

### 4.2 Legal stage transitions

| From | To | Trigger | generation_run? |
|---|---|---|---|
| `not_run` | `running` | job claimed | no (the call happens *inside* `running`) |
| `not_run` | `blocked` | precondition unmet (IM/NA before SC approval; EX before FA; provider down) | no |
| `blocked` | `not_run` | precondition cleared | no |
| `running` | `done` | stage success (assets persisted) | written by the adapter during `running` |
| `running` | `failed` | non-retryable error, or transient retries exhausted (3) | written per attempt |
| `running` | `awaiting_approval` | gate stage reached (SC reached, IM first-three checkpoint, FA reached) | no |
| `awaiting_approval` | `done` | operator approves | no |
| `awaiting_approval` | `awaiting_approval` | operator rejects WITHOUT an edit — returns to the gate for re-review; invalidates nothing (OQ-3) | no (R-005-4) |
| `awaiting_approval` | `stale` | an edit is applied (either a reject-with-edit, or an edit made while the gate is open) — the edit's invalidation rule marks target + downstream stale | no (the edit's rule applies) |
| `done` | `stale` | an edit invalidates this stage (R-006) | no |
| `stale` | `running` | operator regenerates (explicit, post IP-01 preview) | written when the stage re-runs |
| `stale` | `done` | operator "accepts staleness" (recorded) | no |
| `failed` | `running` | manual retry, or auto retry while transient attempts remain | written per new attempt |
| `*` | `cancelled` | batch cancelled (terminal) | no |

Rules that hold everywhere:
- A stage may transition to `running` only from `not_run`, `failed`, `stale`, `blocked` — never from `done` or `awaiting_approval` without the explicit regenerate path (editing and regenerating are separate commits, DI-03).
- `stale` is never auto-cleared (IP-01/UC-05). It clears only on re-run success or recorded `accept_staleness`.
- `blocked` always carries a named precondition (UC-03/UC-04 "blocked" rule); `failed` always carries `error_class`, `http_status`, and attempt count (AX-25).
- Rejection semantics (R-005-4, OQ-3): a reject records the named `target_stage`. A reject WITHOUT an edit re-opens the gate for re-review and invalidates nothing; a reject WITH an edit applies that edit's invalidation rule (target + downstream become `stale`); a reject naming an upstream producing stage without an edit sets that stage to `not_run` (a deliberate, spend-visible re-run still routed through IP-01).

### 4.3 The invalidation matrix as data (R-006-2/3, D12)

Seeded rows in `invalidation_rule` (edit_kind → invalidated/survives/calls). `calls` are the count shown in IP-01 and the "what a regeneration would run" panel.

| edit_kind | invalidated_stages | survives | image_calls | tts_calls | render_passes | text_action | conditional |
|---|---|---|---|---|---|---|---|
| `script_wording` | SB, NA, TC, RE | IM | 0 | 1 | 1 | re-derive 17 scene prompts | — |
| `duration` | SC, SB, NA, TC, RE | IM | 0 | 1 | 1 | re-derive script + storyboard | — |
| `aspect_ratio` | RE | IM | 0* | 0 | 1 | — | `reframe` (17 image calls only if reframe fails) |
| `image_replace` | IM(scene), RE | other IM, NA | 1 | 0 | 1 | — | — |
| `captions_music` | RE | IM, NA | 0 | 0 | 1 | — | — |
| `voice_speed` | NA, TC, RE | IM | 0 | 1 | 1 | — | — |
| `topic_after_research` | SC, SB, NA, TC, RE (and RS/IM downstream) | none downstream | 0 | 1 | 1 | re-derive script + storyboard | — |
| `reorder` | TC, RE | IM, NA | 0 | 0 | 1 | captions remap to new order | — |

The matrix is loaded from a versioned seed file into the `invalidation_rule` table at migration. Changing the matrix is a data change (a migration), not a code change, so R-006 is editable in one place and versioned.

### 4.4 Staleness propagation algorithm

On a committed project edit (after the IP-01 preview is computed and the operator chooses *Apply edit* or *Apply and regenerate now*):

1. Resolve `edit_kind` from the changed field(s).
2. Load the `invalidation_rule` row.
3. If `conditional_check = 'reframe'` (aspect-ratio): enqueue a local **reframe check** job first. Outcome (a) reframable → only `RE` marked stale; (b) not reframable → `IM` + `RE` marked stale (17 image calls). Until the check resolves, the regenerate action stays disabled and the panel shows "pending reframe check" (IP-01/UC-06/C-05). The check is local and cheap (image geometry + subject-bounds heuristic via ffprobe/ffmpeg), never a provider call (UI §10.2 #4).
4. For each stage in `invalidated_stages`, set `video_stage.stale=true`, `stale_cause='<edit_kind>: <doc> rev <n>'`, `stale_at=now`. Surviving stages are untouched. This produces the stale ribbon (`NA ⚠ stale · TC ⚠ stale · RE ⚠ stale`).
5. Commit the edit with the optimistic-lock conditional UPDATE (409 on conflict, R-024).
6. The IP-01 preview itself is computed **server-side** from the rule + current `video_stage` states + asset counts, with **no provider call** (UI §10.2 #2). It lists: what changes, what becomes stale (stage + quantity), what survives (asset counts + pins), and the call counts. If the preview cannot be computed, both buttons are disabled (C-07).
7. Regeneration (only reachable via *Apply and regenerate now*): enqueue jobs for stale stages in topological order `SC→SB→IM→NA→TC→RE→QC→FA→EX`. Each successful stage clears its own `stale`, updates its pin (`series_version_id` = newest at start, X-8/OQ-6) and `last_event`. `done` stages are never re-run.
8. Reorder (`edit_kind=reorder`): rewrite `scene.position` only, remap captions from the new order (local), mark `TC`+`RE` stale; zero image/TTS calls (R-006-3, D12). `scene_no` and `scene.asset_id` are unchanged.

### 4.5 Video-level states

`project.status` (5): `NOT_STARTED`, `RUNNING`, `NEEDS_ATTENTION`, `COMPLETE`, `CANCELLED`.

Transitions (each driven by a stage transition, applied in the same transaction):

| From | To | Driver |
|---|---|---|
| `NOT_STARTED` | `RUNNING` | first stage job claimed |
| `RUNNING` | `NEEDS_ATTENTION` | a mandatory gate opens (`SC` awaiting, `IM` first-three checkpoint, `FA` awaiting), a stage `failed`, or a `blocked` precondition (unsourced claims, duplicate topic) |
| `RUNNING` | `COMPLETE` | `FA` approved |
| `NEEDS_ATTENTION` | `RUNNING` | approve / retry / clear block |
| `NEEDS_ATTENTION` | `COMPLETE` | `FA` approved |
| `COMPLETE` | `NEEDS_ATTENTION` | an edit/regenerate after completion (reopens) |
| any non-terminal | `CANCELLED` | batch cancelled |

`current_stage` = the single active (running/awaiting/failed/blocked) stage, else the next `not_run` stage, else `EX`. The batch table's "state" chip is `current_stage`'s stage state; the "attention reason" column is derived from the same vocabulary as UX IP-05 (`script approval`, `image review`, `final approval`, `failed: <stage>`, `blocked: <n> unsourced claims`, `blocked: duplicate topic`, `waiting: render slot`, `waiting: rate limit`, `resumed after restart`). `waiting:*` sorts into "Running", never "Needs attention" (UI §3.4).

### 4.6 Batch states

`batch.status` (3): `ACTIVE`, `COMPLETE`, `CANCELLED`.

- `ACTIVE → COMPLETE` when `completed_count == target_count` (all projects `COMPLETE`).
- `ACTIVE → CANCELLED` on owner cancel (typed confirm, IP-14/OQ-4): stops scheduling new stages, cannot abort an already-issued provider call, keeps completed assets, marks remaining projects `CANCELLED`, excludes them from export (S-17).
- `COMPLETE → ACTIVE` if a completed video is edited/regenerated.
- `CANCELLED` is terminal.

### 4.7 Which transitions write `generation_run` rows

- **Write a `generation_run` row** (before the call): only the six provider stages — `T` (text), `RS` (search/fetch, up to N requests), `SC` (text), `SB` (text), `IM` (one image per scene), `NA` (TTS). Each provider request = one row; a stage attempt may emit several (RS emits one per search/fetch; IM emits one per scene).
- **Never write a `generation_run` row** (free/local): `TC` (local word-timing derivation), `RE` (CPU render — R-005-4's "billable render" wording is loose; render is a gated stage with no provider and no cost, per BACKLOG §8), `QC`, `FA`, `EX`, reorder, reframe check, and all `blocked`/`stale`/approval transitions.

### 4.8 Gate preconditions (encoded in the enqueue guard, asserted in tests)

| Stage | Precondition to run |
|---|---|
| T | series `active` (R-001-3) |
| RS | topic approved (creative mode skips, records mode, R-027-4) |
| SC | topic approved |
| SB | script approved |
| IM | script approved (mandatory, R-005-2); if protagonist: first-three checkpoint (PRD §10) |
| NA | script approved |
| TC | narration done |
| RE | images done + narration done + timing done |
| QC | render done |
| FA | QC all pass |
| EX | FA approved (mandatory, R-005-3) |

---

## 5. Provider adapter contracts

One interface per category. Each adapter carries: configurable model id, credentials, timeout (R-008-1), a per-key rate limiter (default 10 req/min, configurable; below provider QPS — R-008-2), a recorded `provider_qualification` gate (R-008-3), and an idempotency declaration (R-012-2). Every adapter is constructed inside the content worker and cannot be invoked without a persisted `generation_run.id` (§3.5).

### 5.1 Text adapter — DeepSeek chat

```
interface TextAdapter {
  generate(req: { model; messages; response_format: JsonSchema; temperature?; max_tokens? },
           run: GenerationRun): Promise<{ content: T; raw; provider_request_id }>;
}
```
- Timeout **60 s** (configurable). Retry classification: 429/5xx/network ⇒ `transient`; other 4xx and auth ⇒ `non_retryable` (R-011-2). Backoff 1 s/4 s/16 s, 3 attempts.
- Idempotency: **unprotected** (no honoured key) — recorded `idempotency_protected=false`.
- Used for topic (T), script (SC), storyboard (SB), each validated against a versioned JSON schema (R-004).

### 5.2 Research adapter — DeepSeek Search & Fetch

```
interface ResearchAdapter {
  search(req: { query; count?; need_content?; operators? }, run): Promise<{ results: SourceResult[] }>;
  fetch(req: { url }, run): Promise<{ title; content_markdown }>;
}
interface SourceResult { url; title; snippet; summary; content?; date?; rerank_score: number; }
```
- Timeouts **30 s** each (R-008-1). `count` default 5. Billed only on HTTP 200 with a result (failed/empty/timeout not billed). Retry classification as above.
- Acceptance threshold **`rerank_score ≥ 1.5`** (QUALIFICATION §3); only accepted sources are offered to the script generator and the claim picker.
- Idempotency: **unprotected** (cheap, success-billed) — recorded.
- **Fallback boundary:** `GeminiGroundingAdapter implements ResearchAdapter` (same interface) is a documented, config-selectable fallback when DeepSeek's index is thin (D7). It is not the default and requires the Gemini key. Selecting it is a config change, not a code change.

### 5.3 Image adapter — Gemini `gemini-nano-banana-2.1`

```
interface ImageAdapter {
  generate(req: { prompt; reference_images: inlineData[] (≤14); image_size: '1K'|'2K';
                  aspect_ratio: '9:16' }, run): Promise<{ image_bytes: Uint8Array; provider_request_id; seed? }>;
}
```
- Output **768×1376** (1K, JPEG). Timeout **60 s** (26 s first / ~17 s typical). Retry classification as above.
- Reference images passed as `inlineData` alongside the text prompt (no text/lettering instruction) — QUALIFICATION §1.
- Escalation boundary (P1, R-101): `gemini-3-pro-image` is a second implementation of the same interface, selectable per series; escalation is logged. Not in MVP default path.
- Idempotency: **unprotected** — recorded. The ≤1-billable guarantee is the pending-attempt rule (§5.4).

### 5.4 TTS adapter — ElevenLabs `convert-with-timestamps`

```
interface TtsAdapter {
  convert(req: { text; voice_id; model_id: 'eleven_multilingual_v2' }, run):
    Promise<{ audio: Uint8Array; alignment: CharacterAlignment; duration_s: number; provider_request_id }>;
}
interface CharacterAlignment { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[]; }
```
- Timeout **120 s** (R-008-1). Retry classification as above.
- Word timings are derived by grouping `characters` (whitespace boundaries) at the measured **3.035 words/s** calibration; validation requires **≥99% word coverage** and **monotonic** timestamps (R-008-3, QUALIFICATION §2). A miss returns the video to script/voice review (R-009-4), never time-stretches.
- Idempotency: **unprotected** — recorded.

### 5.5 Idempotency and the ≤1-billable guarantee (R-012-2/3/4)

None of the three providers honours a client idempotency key today. Therefore **every billable stage is recorded `idempotency_protected=false`** (R-012-2's "or recorded as unprotected" branch), and the ≤1-billable guarantee is structural:

1. `generation_run` is committed `pending` **before** the call (§3.5).
2. On a forced kill between the call and asset persistence, the resume path finds a `pending`/`running` run. It does **not** auto-reissue the call. It marks the run `charge_status='unknown'` and the stage `failed` with reason `unknown charge`, and surfaces the IP-06 "unknown charge" panel (R-012-4).
3. The operator then decides (R-011-3). A reissued call is a **new** `generation_run` (a new provider call), which is correct cost accounting.
4. Result: the killed stage produced **at most 1 billable request**, verified against the provider usage report in the forced-kill test (R-012-3).

The trade-off (one manual operator action after a mid-call crash) is acceptable for a single operator and is the honest consequence of no provider idempotency; it is documented, not hidden.

### 5.6 Qualification gate (R-008-3)

Each adapter exposes `qualify(): Promise<{ passed; details }>` that runs the PRD thresholds and writes a `provider_qualification` row (pass/fail + date). The content worker refuses to issue a billable call when the adapter's latest record is not `passed`. Thresholds: image — reference preserved across ≥3 scenes; TTS — character alignment on a ≥60 s sample with ≥99% word coverage and monotonic timestamps; text — schema-conformant response per schema; research — ≥3 of 5 enumerated factual claims receiving a resolvable URL. This retires the §4 residual unknowns before any billable stage (US-012 is the hard prerequisite before US-019/US-021).

### 5.7 Rate limiting (R-008-2)

Per-provider-key token bucket, default **10 requests/min**, configurable, enforced inside each adapter (and mirrored by a Redis bucket so a worker restart does not reset the window). Bucket size and refill are set below the documented QPS (DeepSeek search 100 QPS, fetch 25 QPS; Gemini/ElevenLabs API limits respected). Exceeding the bucket queues the job (`waiting: rate limit`), never drops it.

---

## 6. Render pipeline (FFmpeg)

### 6.1 Inputs and the upscale step

Per scene: a 768×1376 JPEG (provider output). Note: 768×1376 is 9:16.13, not exactly 9:16, so a uniform 1.406× (width ratio) scale to 1080×1920 would be 1080×1935. The pipeline therefore uses cover-scale-then-center-crop, which preserves geometry with no squash and trims ~7.5 px top/bottom:

```
scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,
crop=1080:1920:(iw-1080)/2:(ih-1920)/2
```

Scaling kernel **lanczos** (best quality for a 1.406× upscale of a flat-comic style), followed by light conservative sharpening `unsharp=5:5:0.5:5:5:0.0`. No AI upscaler (no GPU, no host installs — R-016).

### 6.2 Per-scene Ken Burns motion

Each upscaled still is animated with `zoompan` at the scene's exact frame count `d = round(scene_duration_s × 30)`, output 1080×1920 @30 fps:

- zoom-in:  `zoompan=z='min(zoom+0.0006,1.20)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=N:s=1080x1920:fps=30`
- zoom-out: `zoompan=z='if(eq(on,0),1.20,max(zoom-0.0006,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=N:s=1080x1920:fps=30`
- pan-L/R and static: corresponding `x`/`y` expressions or a fixed `z='1.05'` with a linear `x` ramp.

The `camera_move` preset comes from `scene.camera_move`; motion amplitude is capped (≤1.2×) so the caption safe area never clips the subject, and `prefers-reduced-motion` renders use the `static` preset (AX-16).

### 6.3 Scene assembly and transitions

The 17 per-scene clips are joined with `xfade` (crossfade) in a single `filter_complex` chain; transition duration default **0.3 s**. Offsets are computed from cumulative scene durations. If a scene is short (<0.6 s), its transition is downgraded to a hard cut to avoid negative offsets (a render-time assertion, not a silent change).

### 6.4 Caption burn-in from word timings

Word timings (derived from ElevenLabs character alignment) are grouped into caption lines (≤ 2 lines, ≤ ~42 chars/line) and emitted as an ASS subtitle file with per-line `\fad` fade. The ASS is authored so the caption text box is **inside the 9:16 caption safe area by construction**: margins force `x ∈ [54, 1026]`, `y ∈ [96, 1824]` (5% inset = 54 px L/R, 96 px top/bottom — R-010-6, D13). Burn-in: `subtitles=filename=captions.ass:force_style='...'`. The same ASS source produces the deliverable `.srt`/`.vtt` (converted, §8).

### 6.5 Audio mix

MVP music is silence (Q2 default). Audio track = narration trimmed to scene spans + `adelay` lead/trail (0.5 s each) + `apad`, upmixed mono→stereo, encoded **AAC 128 kbps**. The music slot is a muted `anullsrc` mixed via `amix` so the graph is shaped for a real track later without rework (D10/Q2).

### 6.6 Encoder and output

```
-c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -r 30 -s 1080x1920
-c:a aac -b:a 128k -ac 2 -movflags +faststart
```

Duration = actual narration + lead + trail (R-009-3). Final audio duration must land within **±5%** of target, clamped to **±1 s…±5 s**; a miss returns the video to script/voice review rather than time-stretching (R-009-4).

### 6.7 QC assertions (R-010)

| Check | Method | Pass threshold |
|---|---|---|
| Geometry | `ffprobe` | width=1080, height=1920 (±0 px); r_frame_rate=30 (±1 fps) (R-010-2) |
| Audio | `ffprobe` | audio stream present; audio duration within ±0.5 s of video duration (R-010-3) |
| Blank/white frames | `signalstats` pass → per-frame `YAVG` scan | 0 frames with mean luminance <16 or >240 (R-010-4) |
| Scene presence | render manifest + `ffprobe` chapter/frame ranges | every scene visible ≥ (narration span − 0.2 s) (R-010-5) |
| Caption safe area | by-construction ASS margins + text-pixel scan outside `[54,1026]×[96,1824]` on caption frames | 0 glyph pixels outside the inset rectangle (R-010-6) |
| Duration | §6.6 | meets R-009-3 (R-010-7) |

Honest limitation: full per-glyph OCR is too heavy for the NAS; the safe-area guarantee is enforced by deterministic ASS margins plus a text-pixel-outside-safe-area scan, not per-glyph OCR. This is stated as an assumption in §12.

### 6.8 Wall-time and RAM budgets

- Expected render wall-time for a 75 s video: **~5 min ± 3 min** on the DS923+ CPU (x264 medium 1080p30 + zoompan). This is a **budget, not a benchmark** — the Milestone A benchmark retires it (PRD §11).
- Peak RAM per render: **≤ 2 GB** budget. The render-worker is capped at `mem_limit: 2g` and runs **one render slot** (Redis semaphore) by default (R-104 default 1). R-104 later raises N such that `N × peak_RAM ≤ 16 GB` (i.e. N ≤ 8 at 2 GB, gated on the Milestone C benchmark).
- The render job has a hard runtime ceiling (default **15 min**) after which the worker kills the FFmpeg process and marks the attempt failed (R-023's forced-kill contract reuses this path).

---

## 7. Batch execution design

### 7.1 Queue topology

BullMQ (Redis) queues:

| Queue | Consumed by | Concurrency | Contents |
|---|---|---|---|
| `content` | content-worker | 4 (rate limiter is the real governor) | T, RS, SC, SB, IM (per scene), NA, TC |
| `render` | render-worker | **1** (semaphore) | RE |
| `export` | render-worker | 1 | EX, per-video package, ZIP |
| `misc` | render-worker | 2 | QC, reframe check, derivative generation |

Priorities: manual retries and "resume after restart" > new work > reframe checks. Retry is BullMQ `attempts: 3` with attempt-specific backoff {1,4,16} s applied to `transient` errors; `non_retryable` errors fail the job immediately (no requeue) (R-011-2).

### 7.2 Per-video independence (R-021)

A batch fans out into N independent project pipelines. There is no batch-level job and no barrier: one project `failed` never touches the other N−1. Image generation is one job per scene, so a single scene failure fails only that scene, not the video's other scenes (R-007-1). The batch table groups by derived state (Needs attention → Running → Not started → Complete) with no cross-video locking.

### 7.3 Retry scope computation (R-022-2, IP-06)

Before any retry (manual or resume), the worker computes the scope from persisted state and **stores it on `job.retry_scope` before the job runs**, and the API returns it for the IP-06 panel:

- **will re-run** = the failed stage + every downstream stage whose state ∈ {`stale`, `not_run`, `failed`}, with call counts from the invalidation rule.
- **will not re-run** = every stage with state `done` (and not `stale`) plus its stored assets, listed with counts and pins.

The guarantee string (IP-06) is true by construction: re-running reuses stored assets, so a completed stage produces **0 new `generation_run` rows with `billed_units > 0`** (R-022-2). The test asserts this by diffing `generation_run` before/after a failed-video retry.

### 7.4 Resumability (R-023, R-011-1)

Postgres is the source of truth; Redis is transport. On worker start, a **reconciler**:
1. Scans `job` for `status IN (queued, running)` with no live lease (`heartbeat_at` older than lease TTL).
2. For `running` jobs whose `job_attempt` is mid-call: finds any `pending` `generation_run` and marks it `unknown` (never reissues — §5.5).
3. Re-enqueues the job from its last persisted stage; `done` stages are never re-run.
4. Marks `job_attempt` `unknown_charge`/`timed_out` where the call may have billed (R-012-4).

This guarantees a worker restart mid-batch resumes the in-flight video at its last persisted stage with **no duplicate `generation_run` rows** (R-023-2, verified by the kill-at-random-point test).

### 7.5 Forced-kill contract (R-023, R-012-3)

- **Mid-provider-call kill:** the `generation_run` is `pending`; resume does not reissue; ≤1 billable request; surfaced as `unknown charge` (R-012-3/4).
- **Mid-render kill:** FFmpeg is a child process; the render worker kills it on the runtime ceiling and on SIGTERM; the partial output is discarded; the render stage re-runs from stored images/narration (no provider, no cost). Completed scenes are never regenerated.
- **Heartbeat:** every job_attempt heartbeats the lease (`heartbeat_at`) at ≤ 5 s; a stalled lease is how the reconciler detects a killed worker.

---

## 8. Export package

### 8.1 Per-video package (R-014-1)

One directory per video containing: MP4 (1080×1920), `.srt` and `.vtt` (converted from the word-timing ASS), `metadata.json` (title, description, hashtags), and `sources.json` (the source manifest).

### 8.2 Source manifest (R-014-1, R-027-5)

One row per factual claim (from `claim`), columns: `claim_text`, `url`, `retrieved_at`, `status`, `acknowledged_by`, `acknowledged_at`. A claim the operator acknowledged as unsourced carries `url=""`, `retrieved_at=null`, `status="acknowledged-unsourced"`, plus operator and UTC time (rev 2.3 erratum / OQ-1). Creative mode records `mode="creative"` and applies no citation rows (R-027-4). Non-factual reworded claims are excluded.

### 8.3 Batch ZIP and `manifest.csv` (R-014-2/3)

ZIP contains all per-video files plus `manifest.csv` with exactly the columns `posting_order, filename, title, srt, vtt, sidecar, duration_s, posted_flag`. Integrity is asserted before download (UC-16): exactly one row per video, `posting_order` unique integers 1..N, filenames unique, every referenced file present, and the secret-denylist scan = 0 matches (R-015-5). A failure blocks the download and names the failing row (C-23). Filename scheme: `<series-slug>-<batch8>-<pos2>-<video-slug>.<ext>` (unique by construction). `posted_flag` reflects `publication_log` (R-014-4). `posting_order` is operator-editable at S-17 (drag/`Alt+↑↓`), defaulting to batch order, with the integrity check re-run on every change (OQ-5 default).

### 8.4 Denylist scan on logs and exports (R-015-5)

A redaction module holds a denylist of secret patterns (`sk-…`, `AIza…`, the ElevenLabs key shape, DB passwords). It runs (a) in the structured-logging serializer (redact in-place) and (b) as a pass over every export ZIP before download. The CI/ops `backup` job re-runs the scan over logs and the export bucket; **0 matches** is the release gate (R-015-5).

---

## 9. Deployment & operations

### 9.1 compose.yaml topology (R-016)

Six always-on services + two profile-gated one-shots (§2.4). Only `web` publishes a host port (`8080:8080`); postgres/redis/minio live on a private network with no published port (R-016-3). All images pinned by digest and `platform: linux/amd64` (R-016-1). Volumes: `pgdata`, `redisdata`, `miniodata`, plus a host bind mount `./backups` for the backup profile and `./config` (read-only) for non-secret config. `.env` is gitignored and mounted read-only as the secret source.

### 9.2 Startup ordering and health checks (R-017-1)

- `postgres`, `redis`, `minio` expose healthchecks (pg_isready; redis-cli ping; `mc ready`/minio `/minio/health/live`).
- `migrate` runs first (`depends_on: postgres: condition: service_healthy`), applies migrations, exits 0; `web` and both workers `depends_on` migrate + their stores `service_healthy`.
- Workers do not consume jobs before DB/queue are ready (R-017-1). `web` readiness returns **503** and rejects new batches with "service not ready" while a dependency is down, then self-heals within 30 s of the dependency's readiness returning OK (R-018-1/2). If MinIO is down, media-needing jobs queue/retry rather than write to a non-ready store (R-018-3).
- A missing required env var causes startup to fail with an error naming the key (R-016-5): an env-validator runs in each service's entrypoint and lists every missing key before any work.

### 9.3 Migration service (R-017-2)

`migrate` is a one-shot (`docker compose --profile migrate run --rm migrate`) using a numbered, forward-only migration set (e.g. `node-pg-migrate`). It runs exactly once per deployment, not in every worker (R-017-2). A migration that fails partway fails closed: the migration runs in a transaction where the DDL supports it, the previous image keeps running on the unchanged schema, and the health endpoint reports `migration failed` (R-017-4).

### 9.4 Upgrade and rollback (R-017-3, D11)

- Within a release line, migrations are **backward-compatible** (additive columns/tables, no destructive ALTER; new code tolerates old schema). An image-tag rollback is therefore valid (D11).
- A structural (breaking) migration is documented as **restore-from-backup**, not image rollback (R-017-3).
- Rollback = `docker compose pull <old tag>` + restart; data and in-flight jobs persist (volumes) (R-016-4: `down` keeps data; the guide warns against `down -v`).

### 9.5 Backup/restore (R-017-5)

`backup` (profile) runs `pg_dump` (custom format) + `mc mirror` of the MinIO bucket + a copy of `.env`/config to `./backups/<timestamp>/`. Restore is documented and tested: restore DB + media + config, then re-export a prior video (R-017-5). Retention of backups is separate from asset retention (R-025).

### 9.6 `.env.example` (names only — no values)

`APP_PORT`, `APP_BASE_URL`, `SESSION_SECRET`, `SESSION_TTL_HOURS`, `OPERATOR_USERNAME`, `OPERATOR_PASSWORD` (hashed to argon2id at seed), `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `REDIS_URL`, `MINIO_ENDPOINT`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_BUCKET`, `MINIO_PUBLIC_ENDPOINT`, `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`, `GEMINI_API_KEY`, `GEMINI_IMAGE_MODEL`, `GEMINI_IMAGE_SIZE`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`, `PROVIDER_RATE_LIMIT_PER_MIN`, `PROVIDER_TIMEOUT_IMAGE_S`, `PROVIDER_TIMEOUT_TTS_S`, `PROVIDER_TIMEOUT_SEARCH_S`, `RETENTION_DAYS`, `MAX_RENDER_CONCURRENCY`, `RENDER_MEM_LIMIT_MB`, `RENDER_TIMEOUT_MIN`, `LOG_LEVEL`, `TZ`.

### 9.7 amd64 pinning (R-016)

Every image is `linux/amd64` and pinned by tag **and** digest (DS923+ is x86_64). Images are built off-NAS in CI and pulled by digest; there is no NAS-side build and no host application install (R-016-2). `ffmpeg`/`ffprobe` are baked into the `worker` image (static build), not installed on the host.

---

## 10. Security

- **Auth (R-015, D3).** Single seeded `operator`; password stored as **argon2id** (`m=19456, t=2, p=1`, memory-appropriate for a NAS). Login sets an **httpOnly** + `SameSite=Lax` session cookie (Secure omitted because the app is LAN-only HTTP; documented). **No registration endpoint and no password-reset flow** (R-015-3). Every dashboard/API route except `/login` requires the session (R-015-4). CSRF protection on all state-changing routes (synchronizer token, httpOnly cookie). Auth on by default (R-015-6). A small login backoff (exponential) mitigates LAN brute force without a "reset" surface.
- **Secrets.** Provider keys live only in the server environment (`.env` mounted read-only), never in client responses, prompts, logs or exports (R-015-5). The redaction denylist (§8.4) plus a `gitleaks`-style CI scan enforce this; `.env` is gitignored from the first commit (repo is public).
- **Deliberately out of scope (LAN-only, single operator):** TLS termination (the operator may front with a reverse proxy if desired), MFA, role-based access, audit trails beyond `review_decision`/`publication_log`, and multi-tenant isolation (D3). These are named exclusions, not oversights.
- **Least privilege.** The DB app role lacks DDL and `DROP`; MinIO uses a scoped bucket policy; workers run as non-root in the images.

---

## 11. Test strategy

Providers are **never called in tests**. Three fake layers replace them: `FakeTextAdapter`, `FakeResearchAdapter`, `FakeImageAdapter`, `FakeTtsAdapter` (deterministic, in-memory, honouring the same interfaces and `generation_run` contract), a fake FFmpeg (`ffmpeg`/`ffprobe` wrapper that writes a minimal valid MP4 + probe JSON), and a fake object store (in-memory, content-addressed). Integration tests run against a throwaway Postgres + Redis (testcontainers) with MinIO faked.

### 11.1 Unit (state machine + invalidation + retry scope — the highest-risk modules)

- **State machine:** 100% transition coverage — every legal transition in §4.2 fires; every illegal transition is rejected (a transition matrix table-driven test). This is the single most important unit suite.
- **Invalidation:** every `invalidation_rule` row applied to a fixture project produces the exact `video_stage.stale` set + call counts (R-006-2/3); the aspect-ratio conditional resolves both reframe outcomes (R-006-2).
- **Retry scope:** for each failure stage, `job.retry_scope` is exactly {failed stage + downstream non-done stages} and "will not re-run" lists the done assets (R-022-2).
- **Word timing:** character→word grouping is monotonic and ≥99% coverage on the qualification fixture (R-008-3).
- **8-gram scan:** a planted 8-word run is detected; a 7-word run is not (R-003-2).
- **Optimistic lock:** the conditional UPDATE returns 409 with the current revision on a lost-update race (R-024).

### 11.2 Integration

- **Attempt-row-before-call:** the adapter cannot be invoked without a committed `generation_run` (asserted across two DB connections) (R-012-1).
- **Retry/backoff:** a fake 503 series produces exactly 3 attempts at 1 s/4 s/16 s then `failed`; a 401 fails fast with no requeue (R-011-2).
- **Dedupe:** two identical blobs → one `asset` row, one object, two references (R-026-2).
- **Schema validation:** a malformed LLM payload retries 3× then surfaces the failing field + schema version + retry count (R-004-2).
- **Migration safety:** a failing migration leaves the previous schema intact and the health endpoint reports failure (R-017-4).

### 11.3 End-to-end (the five named cases)

1. **Forced-kill mid-call (R-012-3):** SIGKILL the content worker between the fake provider's "received request" and "asset persisted"; resume; assert exactly **1** billable request (fake provider counts calls) and the attempt is `unknown charge`.
2. **Mid-batch restart (R-023-2):** kill the worker at a random point in a 5-video batch; restart; assert the batch completes with **0 duplicate `generation_run` rows** and completed videos stay APPROVED/EXPORTED.
3. **Reorder (R-006-3, R-007-3):** reorder two scenes; assert **0 image and 0 TTS calls**, captions remap, `scene_no` unchanged.
4. **Two-tab 409 (R-024-3):** two sessions save one script; one succeeds, one gets HTTP 409 with the current revision, no lost update.
5. **Degraded startup (R-018):** start with Postgres down; assert 503 on readiness and "service not ready" on batch create; bring Postgres up; assert self-heal within 30 s and normal batch creation.

Additional e2e: export ZIP integrity (correct `manifest.csv`, both `.srt`/`.vtt`, all files present — R-014-3), the denylist scan finds 0 matches (R-015-5), and citation enforcement blocks approval on an unsourced claim (R-027-2/3).

### 11.4 Coverage expectation

- **100%** transition coverage on the state machine and invalidation matrix (the highest-risk modules).
- **≥85%** line/branch on the domain layer (`state-machine`, `invalidation`, `retry-scope`, `word-timing`, `manifest`).
- **≥70%** overall, with the render/FFmpeg and adapter HTTP layers covered by the fakes rather than line-by-line. The forced-kill and restart e2e tests are release-blocking (PRD §11 release tests).

---

## 12. Risks and open technical questions (ranked)

| # | Risk / open question | Recommended answer | Cost of being wrong |
|---|---|---|---|
| 1 | **Character drift across 17 scenes** (unretired §4 residual). 3-scene qualification passed; 17-scene drift is unknown. | Ship the first-three-scene checkpoint (PRD §10) + per-scene replace; run the Milestone A 17-scene eyeball before batch mode is trusted. | Batch-scale rework of ~510 image calls; the escalation path (R-101) becomes urgent rather than optional. |
| 2 | **FFmpeg render wall-time and peak RAM on the DS923+** are unbenchmarked (my ~5 min / ≤2 GB figures are budgets). | Milestone A benchmark retires it before any concurrency tuning (R-104). | The 30-video batch wall-clock and the R-104 concurrency ceiling are wrong; the single-slot default holds regardless. |
| 3 | **All providers are idempotency-unprotected** → the ≤1-billable guarantee rests entirely on the pending-never-reissue rule. | Accept one manual operator action after a mid-call crash (§5.5). If a provider later adds an idempotency key, flip `idempotency_protected` and enable safe auto-reissue. | A bug in the reconciler would double-bill; mitigated by the forced-kill e2e test + usage-report verification. |
| 4 | **Topic-dedupe embedding model is unspecified by the PRD.** R-020-1 needs an embedding of the description; the three selected providers do not clearly provide one. | Bundle a small CPU-only sentence-transformer in the content worker (no GPU, no 4th key) sized for ~30×N topics. | Dedupe's cosine check cannot ship as specified; see proposed change §13 #1. |
| 5 | **Reframe-check feasibility** (aspect-ratio conditional, R-006-2). Detecting "can a 9:16 image be reframed to 4:5 without losing the subject" is image analysis, not a metadata lookup. | Conservative default: centre-crop + subject-bounds heuristic; if uncertain, always require regen (fail-safe). | The only conditional matrix row degrades to "always regen" (safe but not free) or "never regen" (unsafe). |
| 6 | **Caption legibility at 1K-upscaled-1.406×** (unretired §4 residual). | Milestone A eyeball: 1K-upscaled vs 2K-downscaled; the per-series `image_resolution` switch already exists. | Burn-in captions look soft on photoreal 2K content; flat-comic style (the default) is the safer case. |
| 7 | **DeepSeek research precision (1-of-5 above 1.5).** | 2–3 refined searches + fetches per topic, `site:`/`after:` operators, keep the Gemini-grounding fallback real (§5.2). | The factual channel's citation coverage (R-027) drops; more fetch calls per video (~$0.004/video, acceptable). |
| 8 | **Full per-glyph caption safe-area QC is impractical on the NAS** (§6.7). | By-construction ASS margins + text-pixel scan; document the limitation. | A pathological long word could overflow the safe area; the scan catches the pixel overflow, the margin math prevents the common case. |
| 9 | **Batch cancel semantics are implied, not specified** (R-001-3 mentions cancel; OQ-4). | Adopt UX OQ-4 default; see proposed change §13 #2. | Cancel behaviour is undefined without a ruling. |
| 10 | **Language/runtime choice (Node/TS, X-1)** is a decision I made with no owner input. | Keep unless the lead objects; Python/FastAPI is the drop-in alternative with equal complexity. | A late language swap costs a re-write of the state-machine module only (it is framework-agnostic by design). |

Resolved-here open questions from the UI designer (§10.3), answered as decisions: **feed transport = SSE** (Redis pub/sub fan-out, ≤2 s polling fallback); **image URL contract =** `web` endpoint `/asset/:id/:variant` proxying presigned MinIO URLs (thumb 168×298, detail 360×640, full 1080×1920); **mixed-failure summary =** "`5 videos failed: 3 at narration, 2 at render`"; **reduced-motion poster =** always-store a scene-1 poster, reduced-motion preview = poster still; **attempt-row pagination =** per video, newest first, last 50; **pin summary =** `v13 ×5 · v14 ×3` oldest-first, bare `v13` when all equal (C-3 ruling).

---

## 13. Requirement changes — APPROVED at the design gate, 2026-10-20

All three were approved by the owner and folded into **PRD rev 2.4**: D-B → R-020-4, D-C → new R-028, D-D → R-005-4 erratum. **D-A** (Node.js + TypeScript) was confirmed. The design below already implements all of them, so no design change was required. Retained as the record of what was raised and why.

1. **R-020-1 requires an embedding model not covered by the three selected providers.** Propose adding a clause: the topic-dedupe embedding is produced by a bundled, CPU-only, local embedding model (no additional API key, no GPU) sized for ≤ ~40 topics per batch, or by an owner-approved embedding API. Justification: the PRD specifies cosine-similarity dedupe but no embedding source; the "three keys total" note (APPROVAL.md) conflicts with adding an embedding provider.
2. **Batch cancellation has no requirement.** R-001-3 and UX OQ-4 imply "explicitly cancelled by the owner" but no R-### defines semantics. Propose a new `R-028` (batch cancel): cancel stops scheduling new stages, cannot abort an already-issued provider call (and says so), keeps completed assets, marks remaining videos CANCELLED, excludes them from export. Justification: without it, cancel is undefined and the S-08/S-17 states and IP-14 typed-confirm copy have no requirement to cite.
3. **R-005-4 lists "render" as a gated *billable* stage, but render is CPU-local with no provider and no cost.** Propose an erratum: render is a *gated* stage but not a *billable* one; the gated-billable set is image generation and TTS (text/research are billable but not gated). Justification: BACKLOG §8 already flags this; no behaviour changes, only wording. (No design impact either way — render still never writes a `generation_run` row.)

Non-changes (flagged, not proposed): the `1.406× upscale` figure is the width ratio (768→1080); the height ratio is 1.395×, so the design cover-scales-and-crops (§6.1) rather than assuming a clean 1.406× uniform scale. This is a factual clarification, not a requirement change.

---

## 14. Completion report

- **Service count:** 6 always-on (`web`, `content-worker`, `render-worker`, `postgres`, `redis`, `minio`) + 2 profile-gated one-shots (`migrate`, `backup`) = **8 total, 6 steady-state**.
- **Table count:** **13 required + 9 supporting = 22** (required set exactly as specified, plus `job`, `video_stage`, `claim`, `reference`, `operator`, `session`, `invalidation_rule`, `asset_ref`, `provider_qualification`).
- **Riskiest area:** the **stage/state machine + invalidation + staleness propagation** (§4). It is the only module where a wrong transition, a mis-cleared stale flag, or a retry scope that re-runs a `done` stage directly produces duplicate billable calls (R-012/R-022) or silently wrong output (R-006). It is mitigated by making the invalidation matrix *data*, making every transition a guarded typed function, and requiring 100% transition coverage + the forced-kill/restart e2e tests.
- **Proposed requirement changes:** 3 (§13), all surfaced, none assumed.
- **Open technical questions:** ranked in §12; the top three by risk are character drift at 17 scenes, the unbenchmarked render wall-time/RAM, and the all-providers-idempotency-unprotected reality.
