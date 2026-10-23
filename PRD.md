# Product requirements — Multi-series faceless reels factory (rev 2)

**Status:** Draft rev 2.4 — rev 2.3 plus the four decisions approved by the owner at the design gate on 2026-10-20: **D-A** Node.js + TypeScript; **D-B** bundled CPU-only local embedding model for topic dedupe (R-020-4); **D-C** new R-028 batch cancellation; **D-D** R-005-4 erratum. Rev 2.3 added the R-027-5 erratum raised by UX spec OQ-1: the manifest now permits an acknowledged-unsourced row instead of requiring a URL, matching R-027-3. Resolves rev-1 blockers B1–B6, absorbs owner decisions D1–D13, the D7 amendment (research via DeepSeek Search & Fetch, not Gemini grounding), and the two rev-2.2 additions approved by the owner in Telegram on 2026-10-20: **PA-1** per-video citation enforcement (new R-027) and **PA-2** auth moved into Milestone A.
**Owner:** Johnathan Wong
**Date:** 20 October 2026
**Supersedes:** PRD.md rev 1 (sha256 `809415319f1b3fc6321f8a49def0f7f9a5c84a07afa3a8584a545a68a28ac327`)
**Product type:** Private, single-tenant, self-hosted, LAN-only content-production application.
**Reference:** owner-provided 75.24-second, 1080×1920, 30 fps comic-style reel — an example of composition and pacing, not a required template.

---

## 0. Change log (v1 → v2)

Every v1 requirement is traced here. "Dropped" means the owner removed the scope; "demoted" means moved to a lower priority; "split" means re-cut into finer requirements.

| v1 ID | v2 ID | Disposition |
| --- | --- | --- |
| P0-01 | R-001 (+ R-002) | Split. Profiles in R-001; versioning extracted to R-002 (D1). Archive behavior added. |
| P0-02 | R-003 | Verbatim threshold made numeric (8-gram scan). |
| P0-03 | R-004 | Retry ceiling fixed at 3; "actionable failure" defined. |
| P0-04 | R-005 (+ R-006) | Gates enumerated; the invalidation model extracted to R-006. |
| P0-05 | R-008 | Per-provider pass/fail qualification added (B1). |
| P0-06 | R-007 | Reorder semantics added (B5/D12). |
| P0-07 | R-009 | Alignment mechanism fixed (D5); duration per D10. |
| P0-08 | R-010 | 9:16 @ 1080×1920 default (D10); QC thresholds numeric. |
| P0-09 | R-011 | Retry/backoff numbers made explicit. |
| P0-10 | **dropped** | D2 — billing out of MVP. No caps/ledger/estimate/override. |
| P0-11 | R-013 (+ R-014) | Provenance kept; export package expanded (D8/D10). |
| P0-12 | R-015 | Auth = username+password (D3). |
| P0-13 | R-016 | Unchanged (amd64 pin note added). |
| P0-14 | R-017 | Rollback policy per D11; migration-failure AC added. |
| P1-01 | R-201 | Demoted to P2 optional "keep the pipeline topped up" prompt (D9). |
| P1-02 | R-101 | Model routing + escalation (D4 escalation model). |
| P1-03 | R-102 | Character/style asset library; reference-passing is now native (D4). |
| P1-04 | R-103 | Analytics; "cost/video" becomes billed-units (D2). |
| P1-05 | **dropped** | D8 — no platform publishing in MVP. |
| P2 (list) | R-202…R-207 | Scope unchanged. |

**New in v2 (no v1 equivalent):** R-002 versioning & stage pins (D1/B3); R-006 invalidation model (explicit); R-012 attempt-row-before-provider-call (B6); R-014 export package & posting log (D8/D10); R-018 degraded startup (unstated req #4); R-019–R-023 batch mode (D9); R-024 optimistic locking (unstated req #3); R-025 retention & cleanup preview (unstated req #5); R-026 asset dedupe (unstated req #8); **R-027 per-video citation enforcement in factual mode (PA-1, rev 2.2)**.

---

## 1. Executive brief

Build one production system that generates narrated, faceless vertical videos in a **batch** for independently configured **series**. The Synology DS923+ (20 GB RAM; no GPU) hosts the application, orchestration, database, queue, asset storage, and CPU rendering. External providers perform text, image, speech, and research inference. Hermes is used by the owner to **develop** this product; it is not a runtime dependency.

The primary flow (D9): the owner requests a batch (for example 30 videos) for a series; the system generates them end-to-end; the owner downloads a package and posts manually. Scheduling is demoted to an optional "keep the pipeline topped up" prompt (P2), never a cron job, and no automation may trigger a surprise batch.

**Non-negotiable deployment requirement:** the entire runtime is containerized and orchestrated with a single, understandable Docker Compose project. Deploying on the NAS must not require installing application dependencies on the host or building images on the NAS.

**Explicitly out of MVP:** billing/cost-control features (D2), direct platform publishing (D8), and multi-tenant concerns. The app is single-tenant, LAN-only, private (D3).

---

## 2. Goals and measures

| Goal | Release acceptance measure |
| --- | --- |
| Match the reference production pattern | Produce a narrated, illustrated vertical video with scene changes, motion, timed captions, music, and a final MP4 at 1080×1920. |
| Batch-first production | Create a batch for one series with a target count; generate, review, regenerate per-video, and export as a ZIP with a posting-order manifest. |
| Support multiple series | ≥5 series profiles with distinct niche, script, voice, art preset, and output coexist and run through one pipeline. |
| Keep production editable | Approve/edit script before media generation; regenerate one scene, narration, or render without repeating unaffected paid calls; reorder scenes without regenerating images/narration. |
| Make failures recoverable | A worker restart, provider timeout, or single-video failure leaves a resumable batch; completed assets remain reusable. |
| Make deployment simple | A checked-in Compose file and instructions bring up the full app from versioned images on a clean DS923+; persistent data survives `down` and container replacement. |
| Credible operations | After setup the owner creates series and batches, reviews, revises, downloads, and inspects failures from the dashboard without shell commands. |

Operational targets for the first release: one 75 s video end-to-end, then a 5-video batch, then a 30-video batch. One NAS render at a time by default (R-104 tunes this after benchmarking). No duplicate billable request on ordinary resume where an output is already stored (R-012). These are capacity targets, not guaranteed external-provider SLAs.

---

## 3. Users, boundaries, and exclusions

**Primary user:** the owner/operator, managing one or more series and their content.

**In scope for MVP:** series profiles; batch creation with target count; topic dedupe; source capture; structured script/storyboard; approval gates; image and TTS generation; character-level captions; music upload/reuse; CPU assembly; per-scene edits and reorder; review/download; export package (MP4, .srt, .vtt, metadata sidecar, source manifest); batch ZIP with `manifest.csv`; manual posting log; a debug-only `generation_run` row per provider call; provenance tracking; username+password auth.

**Later (P1/P2):** model routing/escalation, reusable character/style asset library, series analytics, render-concurrency tuning, the optional "keep topped up" prompt, platform performance import, A/B variants, motion clips, custom styles, collaboration, automated fact-check assistance.

**Explicit exclusions:** running text/image/voice models on local GPU; Hermes runtime integration; generating a continuous minute of AI video; promises of monetization or viral performance; unauthorized use of third-party copyrighted footage, music, characters, or voices; any billing/ledger/cap/override UI or workflow (D2); any platform publishing adapter or OAuth app (D8); multi-tenant auth or roles (D3).

---

## 4. Verified capabilities (replaces rev-1 hedges)

These are facts as of **2026-10-20**, sourced from provider documentation. They replace every "where supported" / "verify when selecting" hedge in rev 1. Residual unknowns are stated and are retired by Milestone A benchmarks.

### D4 — Image generation: `gemini-nano-banana-2.1` (Google Gemini API)

**Verified 2026-10-20 (ai.google.dev):**
- Accepts **up to 14 reference images** per request; supports **multi-turn character consistency**.
- 9:16 output sizes: 1K = 768×1376, 2K = 1536×2752, 4K = 3072×5504.
- Price: $0.0336/1K, $0.0504/2K, $0.113/4K; **batch tier is half price**.
- `gemini-2.5-flash-image` was shut down 2026-10-02; Imagen is discontinued. Neither is referenced in this PRD.

**Escalation:** if character drift appears, `gemini-3-pro-image` at $0.134 (1K/2K).

**Residual unknown:** real-world character-drift rate across a 17-scene video (reference capability is documented; consistency across many scenes is not). Retired by the Milestone A eyeball benchmark: generate 17 scenes with the recurring protagonist reference set and count visually-off-model scenes.

### D5 — TTS: ElevenLabs `convert-with-timestamps`

**Verified 2026-10-20 (elevenlabs.io docs):**
- Returns **character-level** `alignment` (plus `normalized_alignment`) with per-character start/end times.
- Word timings are **derived by grouping characters** — no external aligner, no on-NAS Whisper.
- Commercial licence is included from **Starter ($6/mo, 30k credits)**; **Creator $22/mo, 121k credits**.

**Residual unknown:** alignment accuracy on unusual proper nouns, jargon, and non-English words. Retired by the Milestone A benchmark: run a 75 s script containing ≥10 proper nouns/jargon terms and measure word-coverage % and monotonicity of derived word timings.

### D6 — Text LLM: DeepSeek

Key already held. Residual unknown: schema-adherence rate against the versioned topic/script/storyboard schemas (bounds R-004's 3-retry ceiling) and per-niche tone/style match.

### D7 — Web research: DeepSeek Search & Fetch API

**Verified 2026-10-20** from `api-docs.deepseek.com`:
- **Search:** `POST https://api.deepseek.com/v1/tools/search` — query (1–128 chars, supports `site:`, `-site:`, `"exact phrase"`, `lang:`, `after:`, `before:`), `count` 1–50 (default 10), `need_content` to return page body. Returns per result: `url`, `title`, `snippet`, `summary` (600–800 chars, model-oriented), `content` (when requested), `date` (RFC 3339 UTC), `rerank_score` (0–3, ≥1.5 = high quality).
- **Fetch:** `POST https://api.deepseek.com/v1/tools/fetch` — a URL in, page title + Markdown content out.
- **Price:** **$0.75 per 1,000 successful requests** for each of Search and Fetch. Billed only on HTTP 200 with a result — failed requests, empty result sets, and timeouts are **not** billed. `count` does not affect price.
- **Rate limits:** Search 100 QPS, Fetch 25 QPS (account-level; Fetch also per-domain).

**Why this replaces Gemini grounding:** one vendor for both research and scriptwriting, so the writer sees the exact sources it is asked to cite; roughly 18× cheaper per request than Gemini grounding; and no monthly free-tier cliff.

**Residual unknown:** index coverage/authority for narrow factual niches versus Google. Mitigated by the adapter boundary — Gemini grounding remains a documented fallback adapter if DeepSeek's index proves thin. Retired by the Milestone A benchmark on the factual channel (measure % of claims that receive a citation URL, and the mean `rerank_score` of accepted sources).

---

## 5. Series profile and versioning model (D1)

A series profile holds: name, niche (subject, audience, boundaries, language, location, prohibited topics/claims, preferred sources), example scripts (1–5), voice style, art style, visual identity, default aspect ratio (9:16), target duration, narration language, captions preset, sound/music, and intermediate image resolution (per-series; default 1K, see D10).

**Versioning:** every edit to a series profile **mints a new immutable version** (monotonic integer). A project does **not** hold a single snapshot; it records **the series-version id used at each stage** (a per-stage pin). A series edited mid-project mints a new version: **later (not-yet-executed) stages adopt the newest version when they start; already-generated assets keep their original pin.** No already-generated asset is regenerated solely because the series version changed. This is encoded as R-002.

**Profile-vs-project edits (B3):** editing the *series profile* bumps the series version and never mutates existing projects. Editing a *project's own generated script/topic* is project-scoped and governed by the invalidation model (R-006).

---

## 6. End-to-end workflow (batch-oriented)

Per video in a batch:

1. **Topic proposal (dedupe).** Propose a topic for the series; reject near-duplicates within the batch and against the last N projects of the series (R-020). Show rationale and source links where applicable.
2. **Research.** Collect source URLs, titles, retrieval times, and excerpts. Require a human-readable evidence list for factual scripts; permit an explicitly marked creative/storytelling mode. Never present unverified model output as a verified fact. (DeepSeek Search/Fetch supplies URLs, dates and page content, D7.)
3. **Script draft.** Generate hook, narration, ending, title, description, optional hashtags using the series profile. Produce planned word count, estimated runtime, and claim→source mapping. Operator edits and approves before media calls.
4. **Storyboard.** Split approved narration into ordered scenes (count adapts to duration; the reference uses ~17 over 75 s). Each scene has narration span, intended visual action, image prompt, recurring-character references, camera move, caption emphasis, fallback text.
5. **Visual generation.** One image per scene via `gemini-nano-banana-2.1` with the approved reference images (up to 14). Store prompt, model, seed if available, provider response ID, rights metadata. Regenerate/replace/**reorder** per scene. No captions in image prompts.
6. **Narration.** ElevenLabs `convert-with-timestamps` on the approved script; store voice config, audio, request ID.
7. **Timing and captions.** Derive word timings from the returned character-level `alignment` by grouping characters. Validate coverage and monotonicity. Recalculate scene durations from actual narration.
8. **Render.** FFmpeg assembles images into an H.264/AAC MP4 at 1080×1920, 30 fps, with Ken Burns motion, transitions, caption animation, narration, licensed music. CPU-only, one concurrent render initially.
9. **Quality and review.** Automated checks (R-010) then owner review: approve or return to a specific stage.
10. **Export.** Per-video package (MP4, .srt, .vtt, metadata sidecar, source manifest); batch ZIP with `manifest.csv`; manual posting log (R-014).

**Invalidation (R-006):** approvals are checkpoints, not one-way gates. The matrix is in R-006, including reorder (D12). The UI must show expected invalidation **before** any regeneration.

**Batch control:** a batch is a set of videos sharing a series and a target count. Each video progresses independently; one failure does not kill the batch (R-021). Batch-level progress, cost-free retry, and restart-resumability are R-022/R-023.

---

## 7. Product requirements with acceptance criteria

Priorities: **P0 = MVP**, **P1 = after the first 30-video batch proves out**, **P2 = exploratory**. IDs are stable (`R-###`). ACs are numbered (`R-###-n`) and numeric.

### 7.1 P0 — required for first usable release

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| **R-001** | Series profiles & lifecycle | (1) Owner can create, edit, archive, and duplicate ≥5 coexisting series profiles, each with distinct niche/script/voice/art/aspect/duration. (2) Duplicating a profile copies the current version's field values and creates a new profile; it does not copy version history. (3) Archiving a series with an in-flight batch does not interrupt it: the batch runs to completion or is explicitly cancelled by the owner; no new batch or topic may be created for an archived series. (4) Editing a profile mints a new version (see R-002) and never mutates existing projects. |
| **R-002** | Series versioning & per-stage pins (D1) | (1) Every series edit creates a new version with a strictly increasing integer id; old versions remain immutable. (2) Every generated asset (image, narration, render) records the series-version id in effect when it was generated. (3) Editing a series mid-project then running a not-yet-executed stage produces output tagged with the new version id, while previously generated assets retain their original version ids; no previously generated asset is regenerated solely because the version changed. (4) The per-stage pin set of any project is inspectable in the UI. |
| **R-003** | Script reference handling | (1) App stores 1–5 references and an editable extracted style summary. (2) No contiguous run of **≥8 words** from any stored reference appears verbatim in generated script or narration, verified by an automated 8-gram substring scan over all final generated text; the gram length is configurable (default 8). (3) Provider requests contain only the extracted style summary, never reference source text. (4) Origin/rights notes are stored per reference. |
| **R-004** | Structured outputs & schema validation | (1) LLM topic/script/storyboard outputs validate against versioned schemas. (2) Invalid output is retried **at most 3 times**; on the 3rd consecutive failure the job stops before any billable stage and surfaces in the UI the failing field name, the schema version, and the retry count. |
| **R-005** | Review & edit gates | (1) Owner can approve or edit topic, script, individual visuals, audio, and final render. (2) **Script approval is mandatory** before any image/TTS billable call for that video. (3) **Final approval is mandatory** before export. (4) The gated billable stages are exactly: image generation and TTS. *(Rev 2.4 erratum, D-D: render is a gated stage but is CPU-local with no provider and no cost, so it is not billable. Text and research are billable but not gated. No behaviour change — render never writes a `generation_run` row.)* A rejected gate returns the video to the named stage and no billable call fires downstream of the rejection. |
| **R-006** | Invalidation model | (1) The UI shows expected invalidation **before** any regeneration. (2) Matrix: script edit → invalidates scene prompts, speech, alignment, render (images survive a wording-only edit); duration edit → invalidates script, storyboard, speech, alignment, render; aspect-ratio edit → invalidates composition and render (and requires new images only if the originals cannot be reframed to the new ratio); one image replaced → invalidates that scene's visual and the render only; captions or music edit → invalidates render only; voice/speed change → invalidates speech, alignment, render (not images); topic edit after research → invalidates script and everything downstream. (3) **Reorder (D12):** reordering scenes invalidates captions, alignment, and render only; images and narration survive; scene IDs stay stable and captions remap to the new order. |
| **R-007** | Per-scene media & stable scene IDs | (1) Owner can view and replace one image without replacing other media. (2) Scene IDs are stable across replace and reorder; each scene keeps its relationship to narration and captions. (3) Reordering scenes triggers no image or narration call (R-006-3). |
| **R-008** | Provider isolation & qualification (B1) | (1) Text and research (DeepSeek chat + `v1/tools/search` + `v1/tools/fetch`), image (`gemini-nano-banana-2.1`), and TTS (ElevenLabs `convert-with-timestamps`) are invoked through adapters with configurable model IDs, credentials, and timeouts (default 60 s/image call, 120 s/TTS call, 30 s/search call). (2) Each adapter has a per-provider-key request rate limit (default 10 requests/min, configurable; must stay below the provider's documented QPS). (3) Each adapter has a recorded qualification check with a pass/fail result and date, run before integration: image adapter demonstrates a reference image preserved across ≥3 scenes; TTS adapter demonstrates character-level alignment on a ≥60 s sample with **≥99% word coverage** and **monotonic word timestamps**; text adapter demonstrates a schema-conformant response for each schema; research adapter demonstrates ≥3 of 5 enumerated factual claims receiving a resolvable citation URL from Search/Fetch. (4) Provider request IDs and idempotency keys are passed where the provider supports them (see R-012). |
| **R-009** | Duration & speech-led timing | (1) Target duration is per-series, editable per-video, range **10–180 s**; recommended ceiling **≤90 s** (D10), **180 s** hard cap; default target **75 s**. (2) Script length and scene count adapt to target (a 10 s video may need 1–3 scenes; the 75 s reference uses ~17). (3) Render duration derives from actual narration + lead/trail; final audio duration is within **±5%** of target, clamped to min **±1 s** and max **±5 s**. (4) If narration misses tolerance, the video returns to script/voice review rather than silently time-stretching speech. |
| **R-010** | Aspect ratio, render & QC | (1) Default aspect **9:16**; output resolution **1080×1920**, frame rate 30 fps, H.264 video + AAC audio. (2) Automated probe asserts width=1080 and height=1920 (±0 px) and frame rate 30 (±1 fps). (3) Audio stream present with duration within **±0.5 s** of video duration. (4) QC flags any frame whose mean luminance is **<16** or **>240** (blank/white detection); the flagged-frame count must be **0**. (5) Every scene is present and its visible duration is ≥ (its narration span − 0.2 s). (6) 100% of caption glyph bounding boxes fall inside the caption safe area (a rectangle inset **5%** from each edge for 9:16 — one generic safe area per aspect ratio, D13). (7) Rendered duration meets R-009-3. |
| **R-011** | Recoverability & retry | (1) Jobs and batches persist state; after a worker restart completed media is reused and only the in-flight stage re-runs. (2) Transient provider errors (HTTP 429/5xx, network) retry **up to 3 attempts** with backoff **1 s, 4 s, 16 s**; non-retryable errors (4xx except 429, auth failures) fail fast and surface. (3) Owner can retry a failed stage manually. |
| **R-012** | Attempt-row-before-provider-call (B6) | (1) A `generation_run` attempt row (provider, model, prompt hash, provider request id, billed units) is persisted **before** the provider call is issued. (2) For each billable provider, the adapter either passes an idempotency key the provider honors, or the stage is recorded as idempotency-unprotected. (3) AC (forced-kill test): a forced kill between provider call and asset persistence, followed by resume, produces **at most 1 billable request** for that stage, verified against the provider's usage report. (4) A timeout that may still have billed is recorded as "unknown charge" on the attempt row — never claimed as unbilled. |
| **R-013** | Asset provenance recording | (1) Each asset records: prompt, model + version, seed if available, provider request id, series-version id, and rights/license metadata. (2) Each generated image, narration, and render is traceable back to its generating project and stage. |
| **R-014** | Export package & posting log | (1) Per-video export contains: MP4 (1080×1920), captions in **both .srt and .vtt**, a metadata sidecar (JSON: title, description, hashtags), and a source manifest (source URLs, retrieval timestamps, claim→source mapping). (2) Batch export is a ZIP containing all per-video files plus `manifest.csv` with columns `posting_order`, `filename`, `title`, `srt`, `vtt`, `sidecar`, `duration_s`, `posted_flag`. (3) `manifest.csv` has exactly one row per video, `posting_order` unique integers 1..N, filenames unique, and every referenced file present in the ZIP. (4) Owner can mark a video posted with platform, ISO-8601 UTC timestamp, and URL; a marked video sets `posted_flag=1` in a re-export. |
| **R-015** | Authentication (D3) | (1) Single seeded operator account, password stored as **argon2id** hash. (2) Login sets an **httpOnly** session cookie. (3) No registration endpoint and no password-reset flow. (4) All dashboard/API routes require the session except the login route. (5) Secrets (API keys) never appear in client responses, logs, or exports; a denylist pattern scan of logs and exports finds 0 matches. (6) Authentication is on by default. |
| **R-016** | Containerized Compose deployment | (1) Repo includes `compose.yaml`, `.env.example`, pinned image tags/digests (amd64, DS923+ is x86_64), health checks, restart policies, persistent volumes/bind mounts, and a deployment guide. (2) A clean DS923+ can pull and start all services with Docker Compose with no host app installs and no NAS-side image build. (3) Only the web entrypoint is published to the host; DB/queue/object-store stay on a private Compose network. (4) `docker compose down` does not delete data; the guide warns against `down -v`. (5) Startup validates missing required config values and prints an actionable error naming the missing key. |
| **R-017** | Deploy/upgrade/rollback & migration safety (D11) | (1) Safe startup order and dependency readiness prevent workers consuming jobs before DB/queue are ready. (2) Migrations run once per deployment via a documented command or one-shot service, not in every worker. (3) Within a release line, migrations are **backward-compatible** so an image-tag rollback is valid; any structural (breaking) migration is documented as **restore-from-backup** instead of image rollback. (4) AC (mid-migration-failure): a migration that fails partway leaves the previous version running on an unchanged schema, or fails closed with a documented recovery, and the stack reports the failure on the health endpoint. (5) A test restore of database, media, and configuration succeeds and can re-export a prior video. |
| **R-018** | Degraded startup | (1) If DB or queue is unreachable at startup, the app starts degraded: it rejects new batches with a "service not ready" error and returns HTTP **503** on readiness. (2) When the dependency becomes reachable, the app self-heals to full operation without manual restart within **30 s** of the dependency's readiness endpoint returning OK. (3) If the asset store is unavailable, jobs that need it queue/retry rather than writing to a non-ready store. |
| **R-019** | Batch creation (D9) | (1) Owner creates a batch by selecting a series and a target count (integer **1–30** for MVP). (2) Creation records batch id, series-version id, target count, and per-video status. (3) Batch progress is visible as completed_count/target_count. (4) **No cron/timer may create a batch**; batches are created only by an explicit owner action with a target count, so no automation can cause an unbilled surprise batch. |
| **R-020** | Topic dedupe | (1) Within a batch, no two videos share a topic whose normalized topic text is identical or whose embedded description is **≥0.85** cosine-similar. (2) A proposed topic is rejected if it matches (same rule) any topic in the **last N=10** projects of that series (N configurable). (3) Rejection surfaces the matching existing topic so the owner can confirm or override manually. (4) *(Rev 2.4, D-B)* The description embedding is produced by a **bundled CPU-only local model** (ONNX MiniLM class, ~80 MB) running inside the content worker: no GPU, no additional API key, no per-call cost. It is sized for ≤40 topic descriptions per batch; no provider call is used for dedupe. |
| **R-021** | Batch per-video independence | (1) A batch of N videos progresses video-by-video; one video entering FAILED does not block or cancel the remaining N−1 videos. (2) Each video is independently reviewable and regeneratable without affecting other videos in the batch. (3) Retrying a failed video does not re-run or re-bill any completed video (see R-022). |
| **R-022** | Batch progress & cost-free retry | (1) Batch progress (completed/target) updates within **5 s** of any video state change. (2) Retrying a FAILED video re-runs only that video's uncompleted stages and reuses stored completed assets; verified by **0 new generation_run rows with billed_units > 0** for already-completed stages. |
| **R-023** | Batch resumability | (1) A worker restart mid-batch resumes the batch: completed videos remain APPROVED/EXPORTED, the in-flight video resumes at its last persisted stage, and no completed stage re-executes. (2) Verified by killing the worker at a random point in a 5-video batch and confirming the batch completes with no duplicate `generation_run` rows. |
| **R-024** | Concurrency / optimistic locking | (1) Editable documents (script, storyboard, topic, profile) carry a monotonically increasing revision. (2) Two concurrent saves of the same document: one succeeds; the other receives a version-conflict error (HTTP **409**) showing the current revision, with no lost update. (3) Verified by a two-session simultaneous-save test. |
| **R-025** | Retention & cleanup preview | (1) Default retention: originals and renders kept ≥**365 days** (configurable). (2) A cleanup preview lists exactly which assets would be deleted — count and total bytes — before any deletion. (3) Deletion requires owner confirmation and never deletes an asset referenced by an un-posted project or an in-flight batch. |
| **R-026** | Asset dedupe | (1) Identical content (sha256-equal) is stored once and referenced by multiple projects (same music track for two series; same image prompt+seed result). (2) Verified: object-store object count equals the count of unique content hashes. |
| **R-027** | Per-video citation enforcement in factual mode (PA-1) | (1) A series is marked `factual` or `creative` at profile level. (2) In factual mode, **100% of factual claims** in the approved script resolve to a source entry containing a non-empty URL, and each recorded URL is HTTP-reachable (2xx or 3xx) at generation time. (3) A claim with no resolvable source is surfaced to the owner with the claim text; the video **cannot** pass script approval until each such claim is either sourced, reworded as non-factual, or explicitly owner-acknowledged as unsourced. (4) In creative mode this requirement does not apply, and the project records that creative mode was chosen. (5) The export source manifest lists one row per factual claim; rows for claims the owner acknowledged as unsourced carry an empty `url`, a null retrieval timestamp, and `status="acknowledged-unsourced"` with the acknowledging operator and UTC time. *(Amended in rev 2.3: an earlier draft required a URL on every row, contradicting AC 3. UX spec OQ-1 resolved in favour of AC 3.)* |
| **R-028** | Batch cancellation (D-C) | (1) The owner can explicitly cancel a running or queued batch. (2) Cancel stops the scheduling of any further stage for videos in that batch; stages already completed keep their assets. (3) Cancel **cannot** abort a provider call already issued; the confirm dialog states this in words before committing, and any in-flight call is recorded and its result stored normally. (4) Remaining videos are marked `CANCELLED` with a timestamp and the acting operator; cancelled batches do not resume after a worker restart. (5) Cancelled videos are excluded from the export ZIP and from batch completion counts stated as "packaged". (6) Cancel requires an explicit typed confirmation (UX IP-14) and is distinct from deleting a batch. |

### 7.2 P1 — after the first 30-video batch proves out

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| **R-101** | Model routing & escalation | (1) Per-series provider/model preference with a fallback. (2) Fallback occurs only within an explicit cost ceiling and logs its reason. (3) Image escalation: a series may opt to escalate to `gemini-3-pro-image` when character drift is detected, with the escalation logged. |
| **R-102** | Reusable character/style asset library | (1) Approved character sheets and palettes attach to a profile. (2) A character sheet is passed as a reference image to `gemini-nano-banana-2.1` (within the 14-reference-image limit) for scenes using that character. |
| **R-103** | Series analytics | (1) Track per series: videos generated, approvals, failure rate, provider billed-units total (from `generation_run`), and operator revision counts. (2) Report is viewable from the dashboard with no billing/ledger UI (debug/ad-hoc only). |
| **R-104** | Render concurrency tuning | (1) After Milestone C benchmark, raise render concurrency above the default 1 to a configured value. (2) The configured value must not exceed the concurrency at which a single 75 s 9:16 render's peak RAM × N ≤ **16 GB** on the DS923+. |

### 7.3 P2 — exploratory

| ID | Requirement |
| --- | --- |
| **R-201** | Optional "keep the pipeline topped up" prompt (demoted from v1 P1-01): a manual owner nudge to top up a series to a queue depth, never a cron, never unbilled-automatic. |
| **R-202** | Platform performance import. |
| **R-203** | A/B variants. |
| **R-204** | Provider-generated motion clips for selected scenes. |
| **R-205** | Custom trained styles. |
| **R-206** | Collaboration. |
| **R-207** | Automatic fact-check assistance with source verification. |

---

## 8. Resolved blockers (B1–B6)

| Blocker | Resolution | Where encoded |
| --- | --- | --- |
| **B1** — P0 silently required unverified capabilities (word alignment, image-reference, voice licence) | Providers are now fixed and verified 2026-10-20: D5 answers word timing (ElevenLabs character-level `alignment`, no external aligner/Whisper); D4 answers image-reference (up to 14 reference images, multi-turn consistency); commercial voice licence is covered by ElevenLabs commercial plans. Qualification pass/fail checks with numeric thresholds remain a gate (R-008-3). Residual unknowns are benchmarks (R-009/R-008, §4). | §4, R-008, R-009 |
| **B2** — P0-10 cost control had no pricing data source | Resolved by D2: billing is out of MVP, so P0-10 is dropped. The `generation_run` row (provider, model, prompt hash, request id, billed units) is retained for debugging only, with no UI, caps, ledger, estimate, or override. | §0, §9, R-013/R-103 |
| **B3** — profile-versioning semantics undefined | Resolved by D1: plural per-stage pins, edit-mints-new-version, later stages adopt, generated assets keep pin. Project-scoped script edits are governed by the invalidation matrix, not the version model. | R-002, R-006, §5 |
| **B4** — "rollback to previous image tags" conflicts with forward migration | Resolved by D11: migrations are backward-compatible within a release line (image-tag rollback valid); structural migrations are restore-from-backup, documented; mid-migration-failure AC added. | R-017 |
| **B5** — invalidation matrix incomplete (reorder unmodeled) | Resolved by D12: reorder invalidates captions/alignment/render only; images and narration survive; scene IDs stable; captions remap. | R-006-3, R-007 |
| **B6** — "no duplicate billable request on resume" not guaranteed | Resolved by attempt-row-before-provider-call plus idempotency-key-as-selection-criterion; forced-kill AC verifies ≤1 billable request against the provider usage report; "timeouts may bill" honesty preserved. | R-012 |

---

## 9. Cost model (reference only — not a control feature)

Per D2 there are **no caps, no ledger UI, no estimate-before-run gate, no reconciliation workflow, no override**. This section is reference budgeting only. The sole persisted cost artifact is the `generation_run` row's `billed_units` field (R-012/R-013), used for debugging and occasional ad-hoc queries.

Planning figures (17 scenes per 75 s video; batch of 30), computed:

| Item | Unit cost | Per video | Per 30-video batch |
| --- | --- | --- | --- |
| Image — `gemini-nano-banana-2.1` @1K (768×1376) | $0.0336/image | $0.57 | $17.14 |
| Image — NB 2.1 @2K (1536×2752) | $0.0504/image | $0.86 | $25.70 |
| Image — NB 2.1 @2K **batch tier** (half price) | $0.0252/image | $0.43 | $12.85 |
| Image — `gemini-3-pro-image` @2K (escalation) | $0.134/image | $2.28 | $68.34 |
| TTS — ElevenLabs | ~1,311 credits/video (measured) | — | ~39,330 credits |
| Text — DeepSeek | negligible | — | — |
| Research — DeepSeek Search & Fetch | $0.75 per 1,000 requests each (billed only on success) | ~$0.008 | ~$0.25 |

Notes:
- The 30-video batch needs ~31,500 TTS credits, which exceeds Starter's 30k — **ElevenLabs Creator ($22/mo, 121k credits) is the floor for batch mode.**
- Intermediate image resolution is a per-series setting; the Milestone A eyeball benchmark decides 1K-upscaled-1.4× vs 2K-downscaled. 1K upscaled 1.4× is ~$0.29/video cheaper than 2K downscaled, and flat comic/painted styles survive upscaling better than photoreal (D10).

Honesty preserved from rev 1: a timeout may still bill; record "unknown charge" on the attempt row and never claim a timeout was unbilled (R-012-4).

---

## 10. Quality, safety, and operating constraints

- **Visual consistency:** store approved character/reference images; enforce review of the **first 3 scenes** before generating the remaining scenes where the series uses a recurring protagonist. Do not promise pixel-perfect identity.
- **Source integrity:** factual scripts need links and claim→source mapping; a search snippet or an unsupported model assertion is insufficient for a factual claim. The product surfaces uncertainty for human review. (DeepSeek Search/Fetch returns URLs, publication dates and full page content, D7.)
- **Copyright and style:** presets describe visual characteristics; do not instruct models to reproduce a named studio's or living artist's signature style. Uploaded examples and music require owner-confirmed rights. No generated artwork copies card art, logos, or characters unless the owner has rights.
- **Voice rights:** selected synthetic voices must be licensed for intended commercial use (ElevenLabs commercial plans, D5). Record voice ID and licence context.
- **Caption safe area:** one generic caption safe area per aspect ratio (D13). Platform overlay layouts are the owner's problem at post time; the product does not adapt to any platform's UI overlays.
- **Security:** authenticated UI (R-015); per-provider secrets in server environment/secret store; least-privilege credentials; no credentials in client responses, prompts, logs, or exports. Back up DB, media, and configuration and test restore.
- **Resources:** NAS is orchestrator/storage/CPU renderer. One concurrent render by default (R-104 tunes later); enforce temporary-disk ceilings, asset retention with preview-before-delete (R-025), and graceful disk-full handling.
- **No automation can trigger spend:** batch creation is manual-only (R-019-4); no cron, no scheduling, no "keep topped up" automation in MVP.

---

## 11. Milestone plan — solo builder, weekends

Recut for one person building on weekends; each milestone is a demonstrable slice, not a feature checklist.

**Milestone A — one 75 s 9:16 video end-to-end (thin slice).**
Bring up the Compose stack on the NAS from prebuilt images. Auth (R-015) is **in Milestone A** per PA-2: the dashboard is never reachable unauthenticated, even on the LAN. One psychology/comic series; manual topic; approved original script; ~17 scenes via `gemini-nano-banana-2.1` @1K with the recurring-protagonist reference set; ElevenLabs narration via `convert-with-timestamps`; word timings from character alignment; FFmpeg render to 1080×1920 @30 fps; export MP4 + .srt + .vtt + metadata + source manifest. Benchmarks run here: render wall-time and peak RAM; character-drift count across 17 scenes (D4 residual unknown); word-coverage % and monotonicity on a script with ≥10 proper nouns (D5 residual unknown); citation-coverage % on a factual sample (D7 residual unknown); the **1K-upscaled-1.4× vs 2K-downscaled eyeball** (D10). This retires every residual unknown in §4 before anything scales.

**Milestone B — 5-video batch.**
Add batch creation (R-019), topic dedupe (R-020), per-video review/regeneration and independence (R-021), batch progress + cost-free retry (R-022), restart resumability (R-023), the full export ZIP + `manifest.csv` + posting log (R-014), optimistic locking (R-024), retention preview (R-025), asset dedupe (R-026), degraded startup (R-018), and migration safety (R-017). Auth (R-015) is not here — it moved to Milestone A per PA-2. Verify: an interrupted 5-video batch resumes with no duplicate `generation_run` rows, and a failed video retries without re-billing completed ones.

**Milestone C — 30-video batch.**
Run a full 30-video batch for one series (then optionally a second). Measure: total image cost (~$17.14 at 1K), TTS credit consumption vs the Creator tier, per-video wall time, failure rate, and operator revision count. This is the gate that "proves out" before any P1 work. P1 (R-101…R-104) begins only after a 30-video batch is exported and reviewed end-to-end.

**Release tests (subset that changed):**
1. A forced image-provider timeout and a worker restart do not discard completed scenes or create an endless retry loop (R-011, R-012).
2. Reordering scenes causes no image/narration call and remaps captions (R-006-3).
3. A script, aspect-ratio, or duration edit warns of invalidated assets before any new charge (R-006-1).
4. A forced kill between provider call and asset persistence yields ≤1 billable request for that stage (R-012-3).
5. A 5-video batch with one forced FAILED video completes the other four and retries the failed one without re-billing completed videos (R-021, R-022).
6. A worker restart mid-batch resumes with no duplicate `generation_run` rows (R-023).
7. Export ZIP contains a correct `manifest.csv` (posting order, unique filenames, all files present) and both .srt and .vtt per video (R-014).
8. Two simultaneous saves of one script: one succeeds, one gets a 409 with no lost update (R-024).
9. On a clean DS923+, follow the README to pull images, migrate, start, upgrade, and roll back a release-line image tag; data and in-flight jobs persist (R-016, R-017).

---

## 12. Open questions for the owner (at most 5 — confirm the default or answer)

1. **Launch niches.** Which 2–3 series/niches launch first? *Default:* psychology (#1, matches the reference pacing) + one factual/news channel (#2, to exercise source-capture and claim→source mapping).
2. **Music rights.** Which licensed catalog or personally owned tracks may be reused? *Default:* one licensed catalog subscription + owner-uploaded tracks with recorded per-track rights; silence as the fallback.
3. **Target duration.** Is ≤90 s the real operating target, or is 180 s actually needed? *Default:* 75 s default target, 90 s recommended ceiling, 180 s hard cap (per D10).
4. **Art style & protagonist.** Flat comic/painted style with a recurring protagonist (best for 1K upscaling and exercising the 14-reference-image capability), or photoreal without a recurring character? *Default:* flat comic/painted with a recurring protagonist, matching the reference.
5. **ElevenLabs voice and tier.** Which voice(s) per series, and confirm the **Creator ($22/mo, 121k credits)** subscription — a 30-video batch consumes **~39,330 credits measured** (1,311 per video; see `QUALIFICATION_RESULTS.md`), so Starter's 30k cannot complete a single batch. *Default:* one licensed voice per series, Creator tier.

---

## 13. Requirement count summary

- P0 (MVP): 28 (R-001 … R-028)
- P1 (post-30-batch): 4 (R-101 … R-104)
- P2 (exploratory): 7 (R-201 … R-207)
- **Total: 39**
