# UX specification — reels-generator

**Revision:** 1 (draft for UI design and technical design)
**Date:** 2026-10-20
**Author:** UX designer
**Status:** Complete for handoff. No blocking questions; six interpretation questions are listed in §10 with the default assumed, so UI and technical design can proceed without waiting.

**Grounded in these artifacts, all re-hashed on disk before writing (2026-10-20):**

| Input | Rev | sha256 (verified) |
|---|---|---|
| `PRD.md` | 2.2 | `ecb3841d2d8f526847b577b761efbe2100560d6cdddf08d6aed71ed66798743a` |
| `BACKLOG.md` | 2.2 | `ced1e2abddbe11dc44cd25d7dcea32cfbf0ce8698d3aaa6a827e5c0832debb66` |
| `QUALIFICATION_RESULTS.md` | 1.0 | `36b75edf8189c893bd95f81f6894e6e38207f97d5df5e37d9f01f3990514b807` |
| `APPROVAL.md` | 2.2 | `106eec8042daa27de23706593be5fc74a79c9eb8d1c111e0dc23b1c0d94ecd40` |

All four match `PRD_HASHES.md`. No decision in `APPROVAL.md` (D1–D13) is re-opened here.

**Scope of this document.** User flows, information architecture, interaction patterns, low-fidelity wireframes, screen states, usability and accessibility requirements, operator-facing copy. It is the "how it flows and feels" layer.

**Not in this document** (by design): colour, type, spacing tokens, components (UI designer), data model, API routes, state-machine implementation, job queue design (CTO/tech lead). Route strings below are IA handles, not an API contract.

---

## 0. Conventions, vocabulary, and guardrails

### 0.1 Traceability rule

Every flow step, screen, interaction and state carries the id it satisfies — `US-###` (story) and/or `R-###-n` (acceptance criterion). Where a rule comes from the PRD body rather than a numbered criterion (for example the first-three-scenes consistency rule in PRD §10), the section is cited explicitly. Nothing here invents a requirement.

### 0.2 Canonical vocabulary (used verbatim throughout this spec)

| Term | Meaning |
|---|---|
| **Video** | One reel: one topic through to one approved MP4 plus its package (US-032, R-019-2). |
| **Batch** | An explicit owner request for 1–30 videos on one series at one series version (R-019-1, R-019-2). |
| **Stage** | One producing step of a video. Codes: `T` topic, `RS` research/sources, `SC` script, `SB` storyboard, `IM` images (per scene), `NA` narration, `TC` timing/captions, `RE` render, `QC` quality check, `EX` export. `FA` (final approval) is a gate, not a producing stage. |
| **Gate** | A mandatory or optional owner sign-off. Mandatory: script approval before any image/TTS call (R-005-2); final approval before export (R-005-3); in factual mode, per-claim citation resolution before script approval (R-027-3). |
| **Invalidated** / **stale** | An artefact is marked out of date by an edit but **remains stored and downloadable**. Regeneration is a separate, explicit, spend-incurring action (R-006-1, R-006-2). Staleness is never silently resolved. |
| **Pin** | The series-version id recorded on a generated asset or a stage (R-002-2, R-002-4). Plural per stage, not one snapshot (D1). |
| **Call** | One provider request. Counts are shown as **image calls / TTS calls / render passes** only. Render is CPU-local and has no provider (noted in BACKLOG §8). |
| **Attention** | A video that is `AWAITING_*` (a gate is open), `FAILED`, or `BLOCKED_*`. This is the single definition used by every screen. |
| **Reuse** | An already-stored asset is used again with **no** new provider call (R-022-2, R-011-1). |

### 0.3 Non-negotiable guardrails

1. **Nothing spends money without a second, explicit action.** Editing is always separable from regenerating (R-006-1, R-005-2).
2. **No currency, no credit totals, no caps, no ledger, no estimate gate, no override** (D2). Warnings count provider *calls* and *what survives*; they never price anything. `billed_units` appears only as a per-row debug field in Health (§4 IP-08) with no sum, average or total anywhere.
3. **No publishing, scheduling or automation.** No publish buttons, no platform OAuth, no cron/timer-created batches (D8, D9, R-019-4, R-201 is out of MVP).
4. **No account surface beyond one seeded operator.** No signup, no invitation, no password reset, no roles, no profile-management affordances (R-015-3, D3). Login is the only way in and the only place account words appear.
5. **No platform-specific UI.** One generic caption safe area per aspect ratio (D13). No per-platform overlay previews.
6. **Failures are normal and are shown, not smoothed over.** A timeout that may have billed is labelled "unknown charge" (R-012-4); an adapter without idempotency is labelled (R-012-2).
7. **Desktop-first.** Review is 17 images plus a 1080×1920 frame (US-020, US-025). The phone view is a monitoring surface only (§7 AX-22).
8. **Every count shown to the operator is computed from the current document**, not estimated. If the count cannot be computed, the UI says so and blocks the spending action.

### 0.4 Reference numbers used in copy and layout

These come from the approved inputs and are the only numbers this spec relies on:

| Quantity | Value | Source |
|---|---|---|
| Reference scene count for a 75 s video | ~17 (scene count adapts to target) | PRD §6 step 4, R-009-2 |
| Measured narration pace | 3.035 words/s (182 wpm) | QUALIFICATION §2 |
| Word budget at 75 s | 228 words nominal; 216–239 = ±5% band (3.75 s, inside the ±1…±5 s clamp) | QUALIFICATION §2, R-009-3 |
| Image call latency | ~17 s each; 26 s first call; 60 s timeout | QUALIFICATION §1, R-008-1 |
| TTS call latency | 11.4 s for 79 s of audio; 120 s timeout | QUALIFICATION §2, R-008-1 |
| Search call latency / timeout | ~0.4 s measured; 30 s timeout | QUALIFICATION §3, R-008-1 |
| Research acceptance threshold | `rerank_score ≥ 1.5`; ~1 of 5 results passes | QUALIFICATION §3 |
| 30-video batch volume | 510 image calls, 30 TTS calls, 30 render passes | 17 × 30, computed |
| Retry schedule | 3 attempts, backoff 1 s, 4 s, 16 s | R-011-2 |
| Progress freshness | within 5 s of any state change | R-022-1 |
| Caption safe area | inset 5% per edge = 54 px L/R, 96 px top/bottom at 1080×1920 | R-010-6, D13 |
| Duration limits | default 75 s, recommended ≤90 s, hard cap 180 s, min 10 s | R-009-1, D10 |
| Dedupe window | last N = 10 projects, similarity ≥ 0.85 | R-020-2 |

Indicative timing the UI may show (explicitly labelled **measured on the dev box, not a NAS benchmark**): 17 image calls ≈ 5 min per video; 30 videos × 17 images ≈ 510 calls ≈ 2.4 h of image generation at the measured latency. Never present these as promises.

---

## 1. Personas and jobs

One person. One tenant. A LAN. There is no second persona and no role model (D3). What varies is **mode**, and each mode has a different tolerance for interruption and a different failure cost.

### 1.1 The operator — three modes

| Mode | When | Frequency | What success feels like | Failure cost |
|---|---|---|---|---|
| **M1 Commissioning** | Setting up or revising a series; starting a batch | Low (weekly) | "I described the series once, and starting 30 videos was two clicks with no surprises." | A bad series version quietly poisons a whole batch. |
| **M2 Reviewing** | The daily loop: topic → script → 17 images → narration → render → approve → export | High (the product's centre of gravity) | "I can see in five seconds which of 30 videos needs me, and fixing one scene costs one image call." | Wasted provider calls and re-work; approving a bad reel. |
| **M3 Repairing** | A provider timed out, one video failed, the worker restarted, disk is filling | Interrupt-driven, often late and tired | "It told me exactly what broke, what survived, and what a retry will re-run — before I pressed it." | Re-billing completed work (R-022-2), or a stuck batch nobody notices. |

**Design centre: M2 and M3, in that order.** M1 is a form; M2 and M3 are the product. A commissioning form that is merely adequate is acceptable; a review loop that hides staleness or a retry that hides its scope is not.

### 1.2 Jobs to be done

| # | Job | Mode | Primary screens | Trace |
|---|---|---|---|---|
| J-1 | "Tell me what needs me right now, across every batch." | M2/M3 | S-02, S-08 | R-005, R-019-3, R-022-1 |
| J-2 | "Let me read the script and the claims before anything billable runs." | M2 | S-10 | R-005-2, R-027-3, R-003-2 |
| J-3 | "Show me 17 scenes and let me fix only the one that is wrong." | M2 | S-12, S-13 | R-007-1, R-007-2, R-006-2 |
| J-4 | "Before I change anything, tell me what it costs in calls and what survives." | M2 | IP-01 panel on S-10/S-11/S-12/S-13 | R-006-1, R-006-2 |
| J-5 | "Tell me which of 30 videos failed and whether the other 29 are fine." | M2/M3 | S-08 | R-021-1, R-021-2 |
| J-6 | "Tell me what a retry re-runs — and prove it will not re-bill what is done." | M3 | IP-06 on S-08/S-15 | R-022-2, R-011-2, R-011-3 |
| J-7 | "Let me edit the series without disturbing what is already made." | M1 | S-04, IP-02 | R-002-3, R-001-4 |
| J-8 | "Show me every stage's series pin so I can trust what I am exporting." | M2 | S-16 provenance panel | R-002-4, R-013-1 |
| J-9 | "Give me one ZIP in posting order and let me mark what I posted." | M2 | S-17, S-18 | R-014-2, R-014-3, R-014-4 |
| J-10 | "If a provider is down or the disk is filling, say so and tell me what still works." | M3 | S-19, IP-07 | R-018-1…3, R-025-1 |
| J-11 | "Do not let me approve a factual script with an unsourced claim." | M2 | S-10, IP-10 | R-027-2, R-027-3 |

### 1.3 Design consequences of the persona

1. **Attention-first, not menu-first.** The landing screen is the attention queue, not a dashboard of charts (S-02). Charts are P1 analytics (R-103) and are excluded.
2. **Counts before prose.** Every warning leads with numbers and asset names ("17 image calls; 17 stored images survive").
3. **The expensive action is never the default focus.** The default keyboard target after any edit is the no-spend action.
4. **State survives everything.** Review position, filters, and unsaved edit text survive navigation, refresh, and session expiry (IP-09, AX-21). A worker restart is invisible to the UI except as resumption (R-023-1).
5. **Nothing is auto-approved.** A "success" the operator did not sign is not a success (R-005-1…4).

### 1.4 Anti-personas (explicitly not designed for)

| Not designed for | Why / guardrail |
|---|---|
| A second operator or a reviewer role | Single tenant, one seeded account (D3, R-015-1). No sharing, assignment or "requested by" fields. |
| A client/tenant viewing anything | LAN-only, single tenant (D3). No share links. |
| A public signup funnel | No registration endpoint (R-015-3). |
| A marketing/analytics consumer | Series analytics is P1 (R-103); no charts in this spec. |
| A phone user doing final approval | Monitoring only (§7 AX-22). |

---

## 2. Information architecture

### 2.1 Route map

```
/login                                        S-01 Login
/                                             S-02 Overview — what needs attention
/series                                       S-03 Series list
/series/:seriesId                             S-04 Series editor (current version + "new version" commit)
/series/:seriesId/versions                    S-05 Version history
/series/:seriesId/versions/:versionId         S-06 Version detail (immutable snapshot + diff)
/series/:seriesId/batches/new                 S-07 Batch create
/batches/:batchId                             S-08 Batch detail / progress
/videos/:videoId                              S-09 Video workspace — Topic & research
/videos/:videoId/script                       S-10 Script review & approval
/videos/:videoId/storyboard                   S-11 Storyboard
/videos/:videoId/scenes                       S-12 Scene grid
/videos/:videoId/scenes/:sceneId              S-13 Scene detail
/videos/:videoId/audio                        S-14 Narration & timing
/videos/:videoId/render                       S-15 Render & QC review
/videos/:videoId/export                       S-16 Export & provenance (per video)
/batches/:batchId/export                      S-17 Batch export (ZIP)
/posting                                      S-18 Posting log
/health                                       S-19 Failures & health
/data                                         S-20 Data & cleanup
/settings                                     S-21 Settings (key status only)
```

S-09…S-16 are one **video workspace** with a persistent stage rail and eight tabs (§5 W-04). Counted as 8 screens because each has its own states and gates, but they share the shell, the header and the stage rail.

**System surfaces** (not in navigation): SY-1 Startup blocked (config/readiness error naming the missing key, R-016-5), SY-2 Session expired (re-login with draft preserved), SY-3 Not found / no access. A **409 version conflict** is an inline banner + dialog, never a page (IP-09, R-024-2).

The **trash icon appears nowhere on a producing stage.** Deletes exist only on Data & cleanup (S-20) and on an explicitly discarded draft topic (IP-14).

### 2.2 Navigation model

- **Persistent left rail:** Overview · Series · Batches · Posting · Health. An attention badge on Overview shows the count of videos needing attention across all batches (J-1).
- **Breadcrumb** on every non-root screen: `Overview / Quiet Mind / Batch 2026-10-20-a / Video 7 of 30`.
- **Global status strip** (top): service readiness (R-018-1), degraded dependencies (IP-07), and a count of in-flight jobs. It never hides a degraded state behind a hover.
- **No global "New batch".** A batch is always created *from a series* because it must record the series-version id (R-019-2). The only creation entries are S-03 (row action) and S-04 (header action).
- **Settings has exactly one job:** show whether each of the three provider keys is present and whether its qualification record passed. No key values, no editing of secrets in the UI (R-015-5).

### 2.3 Screen table

Every screen: purpose, entry points, primary action, and what it must **never** hide.

| ID | Screen | Purpose | Entry points | Primary action | Must never hide | Milestone | Trace |
|---|---|---|---|---|---|---|---|
| S-01 | Login | Authenticate the single seeded operator | Any unauthenticated route (SY-2) | Sign in | That there is no registration and no reset; that this is LAN-only | A | R-015-1…4, US-004 |
| S-02 | Overview | Answer "what needs me now" across all batches | Post-login landing; rail | Open the next item needing attention | Per-video attention reason, batch progress, degraded banner, videos stuck past their retry budget | A (single video) / B (batches) | R-005, R-019-3, R-022-1, R-018-1 |
| S-03 | Series list | See all series, their current version, archive state, in-flight batches | Rail | Open a series / start a batch | Version number of each series; archive state; that an archived series accepts no new batch or topic (R-001-3) | A (list) / B (duplicate, archive) | R-001-1…3, US-008, US-009 |
| S-04 | Series editor | Edit the profile; commit as a new immutable version | S-03 row, S-02 | Save as new version | That saving mints a **new version** and that existing projects/assets are untouched (R-002-3); which fields changed | A | R-001-4, R-002-1, US-008, US-010 |
| S-05 | Version history | List versions with author-time, changed fields, in-use counts | S-04, S-03 | Open a version | Which projects/stages still pin older versions | B (A: minimal list) | R-002-1, R-002-4, US-010 |
| S-06 | Version detail | Inspect one immutable version; diff against another | S-05 | Compare / copy field values | That the version is immutable; which stages of which projects use it | B | R-002-1, R-002-3, US-010 |
| S-07 | Batch create | Create a batch: series + count + per-video duration | S-03, S-04 | Create batch | Target must be 1–30; the series version being pinned; that no schedule/timer exists (R-019-4) | B | R-019-1…4, US-032 |
| S-08 | Batch detail / progress | Per-video state at a glance, with attention triage | S-02, S-03, S-07 | Open the video needing attention | completed/target within 5 s; which videos FAILED; that one failure did not stop the rest; failed-video retry scope | B | R-019-3, R-021-1…3, R-022-1, US-034, US-035 |
| S-09 | Video · Topic & research | Review the topic (with dedupe outcome) and the source evidence list | S-08, S-02 | Approve topic / proceed | Dedupe match and override (R-020-3); accepted vs rejected sources and `rerank_score` (QUALIFICATION §3); that research is skipped in creative mode (R-027-4) | A (manual topic) / B (proposal, dedupe) | US-015, US-016, US-033, R-027-4 |
| S-10 | Video · Script | Read/edit/approve the script; resolve claims; see word budget | Stage rail | **Approve script** (mandatory, unlocks image + TTS) | Word budget vs target (228 / 216–239 at 75 s); unresolved claims (R-027-3); 8-gram scan result (R-003-2); that approving unlocks 17 image calls + 1 TTS call | A | R-005-2, R-003-2, R-009-3, US-017, US-028, US-037 |
| S-11 | Video · Storyboard | Inspect scene split, narration spans, prompts, references | Stage rail, S-10 approval | Approve storyboard (optional gate) | Scene count vs target; which scenes use the recurring protagonist reference; that editing a prompt affects one scene only | A | R-009-2, R-004-1, US-018 |
| S-12 | Video · Scene grid | All scene images; replace one; reorder; see staleness | Stage rail | Replace the selected scene / reorder | Per-scene state and call cost; first-three-scene checkpoint (PRD §10); that reorder costs 0 image and 0 TTS calls (R-006-3) | A (replace) / B (reorder) | R-007-1…3, R-006-3, US-020, US-030 |
| S-13 | Video · Scene detail | One scene: image, prompt, narration span, provenance, versions | S-12 | Replace image (1 call) / edit prompt | Series-version pin of this asset; previous attempts and their provenance; effect on render | A | R-013-1, R-013-2, R-007-1, US-019, US-020 |
| S-14 | Video · Narration & timing | Audio, derived word timings, duration vs target band | Stage rail | Re-run narration (1 call) / accept timing | Actual duration vs the ±5% band and the clamp (R-009-3); that a miss returns the video to script/voice review rather than time-stretching (R-009-4) | A | US-021, US-022, R-009-3, R-009-4 |
| S-15 | Video · Render & QC | The 1080×1920 output, QC results, final approval | Stage rail | **Approve final** (mandatory before export) | Every QC check with its number (R-010-2…7); render pass count; that approval enables export and nothing else | A | R-005-3, R-010, US-024, US-025 |
| S-16 | Video · Export & provenance | Download the per-video package; inspect all pins | Stage rail, S-15 approval | Download package | Package contents (MP4, .srt, .vtt, sidecar, source manifest) and per-stage series pins (R-002-4, R-014-1) | A | R-014-1, R-002-4, US-026 |
| S-17 | Batch export | Build and download the ZIP with `manifest.csv`; see integrity checks | S-08, S-02 | Download ZIP | Integrity result (rows = videos, posting_order 1..N unique, files present), exclusions and why (R-014-3) | B | R-014-2, R-014-3, US-027 |
| S-18 | Posting log | Record what was posted and when | Rail, S-17 | Mark video posted (platform, timestamp, URL) | Which videos are unposted; that `posted_flag` changes on re-export (R-014-4); that posting is manual | B | R-014-4, US-026 |
| S-19 | Failures & health | Provider/queue/disk status, degraded reasons, attempt rows, qualification records | Rail, global status strip, any failure link | Retry a failed stage (with scope preview) | Error class, attempt n/3, next backoff, "unknown charge" rows, idempotency-unprotected stages, disk headroom | A (provider + attempts) / B (full) | R-011-2, R-012-2, R-012-4, R-018-1…3, R-008-3 |
| S-20 | Data & cleanup | Retention setting and preview-before-delete | Rail, S-19 disk warning | Delete after confirmation | Exact asset count and bytes; how many are protected because a project is unposted or a batch is in flight (R-025-2, R-025-3) | B | R-025-1…3, US-006 |
| S-21 | Settings | Key presence and qualification status only | Rail | None (read-only) | Present/absent per provider, qualification pass/fail + date; that key values are never read back | A | R-008-3, R-015-5, US-004, US-012 |

**Screen count: 21 routed screens** (S-09…S-16 share one workspace shell), **plus 3 system surfaces** (SY-1, SY-2, SY-3) and 1 inline pattern (409 conflict).

### 2.4 IA decisions and rationale

| # | Decision | Rationale | Trace |
|---|---|---|---|
| DI-01 | Landing screen is an attention queue (S-02), not a chart dashboard | The daily loop is "which video needs me"; analytics is P1 | R-005, R-103 (P1, excluded) |
| DI-02 | Invalidation is an always-visible inline panel inside the edit surface, never a modal or a toast | R-006-1 requires the consequence *before* the action; a modal is dismissible and a toast is after the fact. This is the product's most important interaction, so it gets permanent real estate | R-006-1, R-006-2 |
| DI-03 | Editing and regenerating are two separate commits | Prevents "save and spend" bundles; matches R-005-4 (a rejection fires no downstream call) and D2 (no surprise spend) | R-006-1, R-005-4, R-019-4 |
| DI-04 | Series edit ≠ project edit, and the UI says so in different words | R-002-3 (new version, nothing regenerated) and R-006-2 (project edit, things invalidated) have opposite consequences; conflating them would teach the operator the wrong mental model | R-002-3, R-006-2, D1 |
| DI-05 | Staleness is a first-class visible state on the stage rail and inside the batch grid | "Invalidated" must be visible after the edit too, not only before it; otherwise the operator forgets what died | R-006-1, R-021-2 |
| DI-06 | Pins are inspected inside the video (S-16) and summarised in S-08, not in a separate admin area | R-002-4 requires per-stage pin inspection *of a project*, in context | R-002-4 |
| DI-07 | Batch export (S-17) is separate from per-video export (S-16) | Per-video export exists in Milestone A; the ZIP + `manifest.csv` arrives in B (BACKLOG §4). Separate routes let A ship without a fake ZIP button | R-014-1…3, US-026, US-027 |
| DI-08 | Settings is keys-status only; retention/cleanup lives in S-20 and provider/queue/disk health in S-19 | Keeps "settings" from becoming a dumping ground, and puts destructive and diagnostic controls where they are explained | R-015-5, R-025-2, R-018-1 |
| DI-09 | Phone view is monitoring-only and offers no approval | Approving 1080×1920 output and 17 scene images from a small screen risks uninspected approvals (R-005-1). Read-only is honest about capability | R-005-1, §7 AX-22 |
| DI-10 | The first-three-scene checkpoint is a stop in the image stage, not a policy page | PRD §10 requires reviewing the first three scenes before the remaining scenes when a recurring protagonist is used; the stop must be where the images are | PRD §10, R-007-1, US-019 |

### 2.5 Never-present inventory

These must not appear anywhere in the UI: registration, password reset, invite, role/permission, tenant switcher, billing/credits/dollar figures or totals, "upgrade", publish/post-to-platform buttons, OAuth connections, scheduler/cron controls, per-platform safe-area selectors, A/B variant controls, collaboration/comment threads, video-generation-as-a-service ("generate a minute of AI video") affordances. (D2, D3, D8, D9, D13, R-015-3; R-201…R-207 are out of MVP.)

---

## 3. User flows

Five flows. Each step names its screen. Steps that spend money are marked **[SPEND]**; steps that are gates are marked **[GATE]**.

### 3.1 F-A — First run to first exported video (Milestone A)

Persona mode: M1 then M2. Trace: US-001…US-004, US-008, US-010, US-011…US-014, US-017…US-019, US-021…US-026, US-028, US-029, US-031.

| # | Step | Screen | What the operator sees | Trace |
|---|---|---|---|---|
| A-1 | Stack starts from pinned images on the NAS | SY-1 (only if startup fails) | On success: nothing (redirect to login). On a missing config key: a blocked page naming the key | R-016-2, R-016-5, US-001 |
| A-2 | Open the LAN URL | S-01 | Login form only; no registration or reset link | R-015-2…4, US-004 |
| A-3 | Sign in | S-01 → S-02 | Overview in its **first-run empty** state: "No series yet. No batches yet." with one primary action, Create series | US-008 |
| A-4 | Create the first series | S-04 | Empty form grouped in five blocks (S-04, §2.3): identity & niche, voice & narration, art & references, output, mode (factual/creative) | R-001-1, R-027-1, US-008 |
| A-5 | Save | S-04 | "Saved as version v1" and the version chip appears. No project exists, so nothing is invalidated | R-002-1, US-010 |
| A-6 | Confirm provider readiness before spending | S-21, S-19 | Three keys "present"; qualification records "passed, 2026-10-20"; TTS voice selected for this series (Q5 default applied) | R-008-3, US-012 |
| A-7 | Start the first video | S-04 → S-07 | In A there is no batch UI yet: "Create video" is a 1-video batch with target 1 (same record, R-019-2) | R-019-1, US-032 |
| A-8 | Enter the topic manually | S-09 | Manual topic field (A defers topic proposal and dedupe to B); creative mode shows "research skipped, mode recorded" | BACKLOG §4, R-027-4 |
| A-9 | Approve topic | S-09 | Topic gate closes; script stage starts | R-005-1, US-028 |
| A-10 | Read the script | S-10 | Planned words 228 → ≈75 s at 3.035 w/s; band 216–239; hook/narration/ending/title/description/hashtags; 8-gram scan "no reference run ≥8 words found" | R-003-2, R-009-3, US-017 |
| A-11 | (If the script is malformed upstream) see the failure | S-10 blocking panel | Failing field name, schema version, retry count 3/3, stop before any billable stage | R-004-2, US-014 |
| A-12 | Edit wording, then look at the change-impact panel | S-10 | "These stages become stale: scene prompts 17, narration 1 TTS call, timing, render. Images survive: 0 stored." Two buttons: *Apply edit (no regeneration)* and *Apply and regenerate* | R-006-1, R-006-2, US-029 |
| A-13 | **[GATE]** Approve the script | S-10 | Approval confirmation states exactly what unlocks: "17 image calls and 1 TTS call will run." Blocked if claims unresolved | R-005-2, R-027-3 |
| A-14 | Watch storyboard + first three scenes | S-11 → S-12 | Storyboard ~17 scenes with narration spans; image stage runs scenes 1–3 only, then **stops** at AWAITING_IMAGE_REVIEW | R-009-2, PRD §10 |
| A-15 | **[GATE]** Check the protagonist across scenes 1–3, then release the rest | S-12 | "3 of 17 reviewed. Releasing the remaining 14 will spend 14 image calls." | PRD §10, US-019 |
| A-16 | Review the 17-scene grid | S-12 | Each tile: scene id, thumbnail, narration span, state; replace/reorder controls per §4 IP-04 | R-007-1, R-007-2 |
| A-17 | Replace one bad scene | S-13 | "Replacing scene 7: 1 image call. Scene 7's visual and the render become stale. Images 1–6 and 8–17 survive. Narration survives." | R-006-2 (one image replaced), US-020 |
| A-18 | Narration runs | S-14 | Audio player, 1 TTS call used, character alignment derived into word timings, duration vs band | US-021, US-022 |
| A-19 | Timing lands outside the band | S-14 | "Actual 79.1 s vs target 75 s = +5.5%, outside ±5%. The video returned to script review; speech was not time-stretched." | R-009-3, R-009-4, QUALIFICATION §2 |
| A-20 | Re-approve the tightened script, re-run narration | S-10 → S-14 | Invalidation panel again, honestly: images survive a wording-only edit; narration 1 call; render stale | R-006-2 |
| A-21 | Render | S-15 | "Render 1 of 1 running (single concurrent render)". Then QC results | R-010, US-024, R-104 default 1 |
| A-22 | Read QC | S-15 | 1080×1920 ±0 px, 30 fps ±1, audio within ±0.5 s, 0 flagged frames, all 17 scenes present, 100% captions inside the 5% safe area, duration in band | R-010-2…7, US-025 |
| A-23 | **[GATE]** Approve final | S-15 | Approval enables export; rejection returns to a named stage with no billable call | R-005-3, R-005-4 |
| A-24 | Export | S-16 | Package list: MP4, .srt, .vtt, metadata sidecar, source manifest; per-stage pins v1 | R-014-1, R-002-4 |
| A-25 | Download and post manually | S-16 | Download starts; no publish button exists | D8 |

Exit criterion: one 1080×1920 MP4 plus package downloaded, every stage pinned, nothing approved that the operator did not sign (PRD §11 Milestone A, Goal "match the reference production pattern").

### 3.2 F-B — A 30-video batch from creation to ZIP download (Milestone B/C)

Trace: US-032…US-036, US-027, US-026-4, R-019…R-023, R-014-2…4.

| # | Step | Screen | What the operator sees | Trace |
|---|---|---|---|---|
| B-1 | Open the series | S-03 | Row shows current version v13, 2 open batches, archive state | R-001-1, US-009 |
| B-2 | Start a batch | S-07 | Target count field (integer 1–30), per-video duration (default 75 s from series), the version being pinned, factual/creative mode, and the expected per-video volume (17 image, 1 TTS, 1 render — informational, not a cost estimate) | R-019-1, R-019-2, D2 |
| B-3 | Create | S-07 → S-08 | Batch created: "0 of 30 complete". A line states no timer can create or extend a batch | R-019-3, R-019-4 |
| B-4 | Topic proposal for video 1 | S-08 → S-09 | Proposed topic with rationale and source links | US-015 |
| B-5 | Dedupe rejects a topic | S-09 | "Rejected: 0.91 similar to video 4 in this batch — 'Why We Procrastinate'. [Confirm anyway] [Propose another]" | R-020-1, R-020-3, US-033 |
| B-6 | Review sources | S-09 | Accepted sources (`rerank_score` ≥1.5, with score and date) separated from rejected ones; every claim shows its source chip or "no source" | US-016, QUALIFICATION §3, R-027-2 |
| B-7 | Approve topic, approve script (video 1) | S-09 → S-10 | As F-A; each approval advances only video 1 | R-005-2, R-021-2 |
| B-8 | The batch fans out | S-08 | 30 rows; each video advances independently. Image stage respects the 10 req/min per-key limit; the queue shows "waiting on rate limit" as a benign state, not an error | R-008-2, R-021-1 |
| B-9 | Triage while it runs | S-08 / S-02 | "12 of 30 complete · 3 need attention · 15 running". Attention filter is one click. Progress refreshes without reload, within 5 s | R-019-3, R-022-1 |
| B-10 | Walk the script gates in bulk | S-10 (next/previous video controls) | Same layout per video; the operator can approve script 13, edit 14, skip 15 without leaving the workspace | R-005-1, R-005-2 |
| B-11 | One video fails | S-08 | Row turns FAILED with its stage; the batch keeps going; no modal interrupts | R-021-1, R-011-2 |
| B-12 | Review scenes for a video | S-12 | 17-scene grid, staleness badges, per-scene cost of replace | R-007-1, R-006-1 |
| B-13 | Render + QC per video | S-15 | One render at a time; queued renders show "waiting: render 1 of 1 in progress" | R-104 default, R-010 |
| B-14 | **[GATE]** Final-approve each video | S-15 | Approvals are per video; 30 approvals are 30 explicit acts, filterable to "awaiting final approval" | R-005-3 |
| B-15 | Open batch export | S-17 | Pre-download integrity panel: 29 videos eligible, 1 excluded (FAILED, retry or export without it), `manifest.csv` rows 1..29 unique, all files present, 0 missing | R-014-3, US-027 |
| B-16 | Export | S-17 | ZIP builds with progress; download link appears; a note states the manifest's posting order | R-014-2, R-014-3 |
| B-17 | Post manually, then record it | S-18 | Per video: platform, timestamp (ISO-8601 UTC), URL. Saving sets `posted_flag=1` for the next export | R-014-4, US-026 |
| B-18 | Re-export later | S-17 | Pre-download panel now shows `posted_flag=1` for posted rows, unchanged order for the rest | R-014-4 |

Exit criterion: a correct ZIP with `manifest.csv`, exactly one row per included video, unique posting order 1..N, unique filenames, every referenced file present (R-014-2, R-014-3).

### 3.3 F-C — One failed video retried without re-billing completed work

Trace: R-021-3, R-022-2, R-011-1…3, R-012-4, US-031, US-034, US-035.

| # | Step | Screen | What the operator sees | Trace |
|---|---|---|---|---|
| C-1 | Notice | S-02 / S-08 | "Video 7 failed at narration — 1 item needs attention". The other 29 keep running or stay complete | R-021-1, R-022-1 |
| C-2 | Open the failure | S-08 → S-15 (or the failing stage tab) | Failure panel: stage `NA`, error class **transient** (HTTP 503 from provider), attempts 3 of 3 used, backoff history 1 s / 4 s / 16 s, provider + model + request id | R-011-2, R-008-1 |
| C-3 | See what survived | same panel | "Completed and not re-run: topic, research, script (approved v13), storyboard, images 17 of 17. Assets are stored and reused." | R-011-1, R-022-2 |
| C-4 | Open retry scope | IP-06 panel | "Retry will re-run: narration (1 TTS call), timing, render. It will not re-run: 17 images, script, storyboard, research." | R-022-2, R-011-3 |
| C-5 | Confirm retry | same panel | Button reads "Retry narration — 1 TTS call, then re-render". Focus starts on Cancel, not on Retry | R-006-1 analogue, R-011-3 |
| C-6 | Watch it run | S-15 | Stage rail shows NA RUNNING → TC → RE; the badge counts from where it was | R-011-1 |
| C-7 | Timeout that may have billed | IP-08 row | Attempt row carries **unknown charge**; the UI never says "unbilled" for that attempt | R-012-4 |
| C-8 | Non-retryable case | IP-06 panel | "Not retryable: HTTP 401 from ElevenLabs. Retrying will fail the same way. Fix the key, then retry." Retry stays disabled until the key is present again | R-011-2, R-015-5 |
| C-9 | Worker restarted mid-batch | S-08 | Banner: "Worker restarted 14:02 UTC. Video 12 resumed at render. No completed stage re-ran." Completed videos stay APPROVED or EXPORTED | R-023-1, US-036 |
| C-10 | Verify the claim | S-19 | Attempt rows for video 7 show no new rows with billed units for image stages | R-022-2 (0 new rows with billed_units > 0) |

Exit criterion: the video reaches APPROVED with no duplicate provider calls for completed stages, and the operator was told the retry scope **before** pressing retry (R-006-1, R-022-2).

### 3.4 F-D — Mid-project series edit that pins later stages only

Trace: R-002-1…4, R-001-4, D1, US-010.

| # | Step | Screen | What the operator sees | Trace |
|---|---|---|---|---|
| D-1 | Open the series while a batch is running | S-04 | Header: "Quiet Mind · current version v13 · 1 open batch (30 videos) · stages currently pinned: v13" | R-002-4 |
| D-2 | Change the art style and voice speed | S-04 | Field-level "changed" marks; **no invalidation panel** — this is a profile edit, not a project edit | R-002-3, DI-04 |
| D-3 | Read the commit panel | S-04 | "Saving mints version v14. This does **not** change what exists: 30 in-flight videos keep their existing pins. Stages that have not started yet will use v14 when they start. No image, narration or render is regenerated." | R-002-3, R-002-1 |
| D-4 | Save | S-04 → S-05 | Version v14 created; v13 remains immutable | R-002-1 |
| D-5 | Inspect the effect | S-05 / S-06 | v14 detail lists which stages of which videos will now start on v14 (render-only for videos past images; narration + timing for videos not yet narrated) | R-002-3, R-002-4 |
| D-6 | Check a video's pins | S-16 provenance panel | Per stage: `T v13 · RS v13 · SC v13 · SB v13 · IM v13 · NA v14 · TC v14 · RE v14` | R-002-4, R-013-1 |
| D-7 | Existing assets stay put | S-12 / S-14 | Images still show their v13 pin; no staleness badge, no re-run offered | R-002-2, R-002-3 |
| D-8 | *(Counter-case)* The operator instead edits the **project's script** | S-10 | The invalidation matrix applies (not the version model): scene prompts, narration, timing, render become stale; images survive a wording-only edit | R-006-2, DI-04 |

Exit criterion: the operator can state, after the edit, which stages will use which version — and nothing was regenerated by the version change (R-002-3).

### 3.5 F-E — Factual-mode video blocked by an uncited claim (R-027)

Trace: US-037 / R-027-1…5; US-016; R-004-2.

| # | Step | Screen | What the operator sees | Trace |
|---|---|---|---|---|
| E-1 | Series is factual | S-04 | Mode = `factual`, stored on the version; the editor states what this enforces | R-027-1 |
| E-2 | Research runs | S-09 | Sources with `rerank_score`, date, URL; rejected sources below the 1.5 threshold are visible but not offered as citable | US-016, QUALIFICATION §3 |
| E-3 | Draft script arrives | S-10 | Two numbers at the top: "14 factual claims · 11 sourced · 3 unsourced" | R-027-2 |
| E-4 | Read the claims list | S-10 claims panel | Each claim row: claim text, source chip (domain + retrieval time), state `sourced` / `unsourced` / `URL unreachable` | R-027-2, R-027-3 |
| E-5 | Try to approve | S-10 | Approve is **disabled** with the precise reason: "Script approval is blocked: 3 of 14 factual claims have no resolvable source. Sourcing, rewording or acknowledging all 3 is required." | R-027-3 |
| E-6 | Attempt to attach a source | S-13-style source picker in S-10 | The picker offers only accepted (`≥1.5`) results, and shows an HTTP reachability check result (2xx/3xx required) | R-027-2 |
| E-7 | A URL is unreachable | claims panel | Row flips to `URL unreachable` with the status code and retrieval time — it does not count as sourced | R-027-2 |
| E-8 | Reword one claim as non-factual | S-10 editor | The claim exits the factual set; the count updates to "13 factual claims · 11 sourced · 2 unsourced" | R-027-3 |
| E-9 | Acknowledge the remaining two as unsourced | claims panel | Explicit per-claim acknowledgement with the claim text quoted; recorded against the video with the operator and time | R-027-3 |
| E-10 | Approve | S-10 | Approval now allowed; the acknowledgement is visible afterwards in S-16, not buried | R-027-3 |
| E-11 | Export | S-16 / S-17 | Source manifest has one row per factual claim with URL and retrieval timestamp; acknowledged-unsourced rows are marked (§10 OQ-1) | R-027-5 |
| E-12 | Creative-mode contrast | S-04 / S-09 | Mode `creative`: the citation check does not run, and the project records that creative mode was chosen | R-027-4 |

Exit criterion: no factual-mode video can reach script approval with an unresolved claim (R-027-3), and every factual claim in the export manifest has its URL and retrieval time or an explicit acknowledgement marker (R-027-5).

**Flow count: 5 (F-A…F-E).**

---

## 4. Interaction patterns

These carry the product. Each states the rule, the exact content shown, the interactive states, and the keyboard behaviour.

### IP-01 — Invalidation preview (the single most important interaction)

**Problem.** Every edit has a different price. Script wording costs narration + render but not images; replacing one image costs one image call; reorder costs neither images nor narration; voice speed costs narration but not images (R-006-2, R-006-3).

**Rule.** A change-impact panel is permanently present in the edit surface (not a modal), recomputed on every keystroke-commit, and it is the *only* place a spend-incurring regeneration can be launched.

**Content model — shown in this order, always:**

1. **What changes** — one sentence naming the field(s) and the document revision.
2. **What becomes stale** — a stage-by-stage list using the canonical stage codes, with quantities taken from the current document: `SC` (self), `SB`, `NA`, `TC`, `RE`, and per-scene `IM` only where the matrix says so.
3. **What survives** — assets with counts: "17 stored images survive (v13)"; "narration survives (1 file, 79.1 s)".
4. **What a regeneration would run** — call counts, and nothing else: `image calls: 0 · TTS calls: 1 · render passes: 1 · text calls: re-derive 17 scene prompts`. No currency, no credits, no totals (D2).
5. **Two commits**: `Apply edit (no regeneration)` and `Apply and regenerate now`. The second is only enabled after the panel has rendered.

**Exact matrix (verbatim from R-006-2 / R-006-3) and the panel's wording:**

| Edit | Panel says stale | Calls if regenerated | Survives | Trace |
|---|---|---|---|---|
| Script edit (wording) | scene prompts (17), narration, timing, render | 0 image · 1 TTS · 1 render · text: 17 prompts | 17 images | R-006-2 |
| Duration edit | script, storyboard, narration, timing, render | 0 image · 1 TTS · 1 render · text: script + storyboard | 17 images | R-006-2 |
| Aspect ratio edit | composition, render | **conditional**: image calls = 17 *only if* the reframe check fails; 1 render | 17 images (reframed) or 0 if reframe fails | R-006-2 |
| One image replaced | that scene's visual, render | 1 image · 0 TTS · 1 render | all other images, narration | R-006-2, R-007-1 |
| Captions or music edit | render | 0 image · 0 TTS · 1 render | images, narration | R-006-2 |
| Voice / speed change | narration, timing, render | 0 image · 1 TTS · 1 render | 17 images | R-006-2 |
| Topic edit after research | script and everything downstream | 0 image · 1 TTS · 1 render · text: script + storyboard | nothing downstream | R-006-2 |
| Scene reorder | timing/captions, render | **0 image · 0 TTS · 1 render** | 17 images, narration | R-006-3, R-007-3 |
| Series profile edit | **nothing** — new version instead | 0 · 0 · 0 | everything | R-002-3 (see IP-02) |

**Conditional rows are honest, not vague.** The aspect-ratio case runs a **local reframe check first** (no provider call). Until it completes the panel says: "Images: pending reframe check — 17 calls only if the current images cannot be reframed to 4:5." The regenerate button stays disabled until the check resolves, then the number becomes exact. This is the only conditional in the matrix and it is resolved before spending (DI-02).

**Persistence after commit.** The panel collapses to a **stale ribbon** on the stage rail: `NA ⚠ stale · TC ⚠ stale · RE ⚠ stale`, each with a tooltip naming the edit and revision that caused it ("stale: script rev 4, 14:12 UTC"). Ribbons clear only when the stage re-runs or the operator explicitly accepts the staleness. Staleness is never auto-cleared.

**Interaction states.**

| State | UI | Spend button |
|---|---|---|
| No changes | Panel hidden, one compact line: "No unsaved changes" | n/a |
| Preview computing | Skeleton rows + "computing impact"; the form is still editable | Disabled |
| Preview ready | Full list + counts | Enabled, but second in tab order |
| Preview failed | "Impact could not be computed. Editing is blocked until it can be — this prevents an unpriced regeneration." + Retry | Disabled |
| Nothing to invalidate (first draft, no assets) | "No assets exist yet — this edit costs nothing to apply." | Apply enabled, regenerate hidden |
| Reordering | Live preview while dragging: "moves scene 4 → 2; captions remap; 0 image, 0 TTS calls" | Commit on drop |

**Keyboard.** `Tab` order: field → panel → *Apply edit* → *Apply and regenerate*. `Enter` on *Apply edit* is the default commit. The spend action requires an explicit `Space`/`Enter` after focus moves there deliberately.

### IP-02 — Series version mint (profile edits are not invalidations)

**Rule.** Saving S-04 always mints a version (R-002-1). The commit panel states the consequence in profile terms, never in invalidation terms.

**Content:** "Saving mints **v14**. Nothing is regenerated. 30 in-flight videos keep their current pins. Stages that have not started will use v14 when they start. v13 stays immutable and inspectable." Plus a change summary (field → old → new).

**States:** unchanged form (Save disabled, "No changes"); changed (Save enabled "Save as v14"); concurrent edit conflict (IP-09); save success (version chip updates, a "v14" toast is *not* used — the chip on the page is the record); archived series (S-04 read-only, edit disabled with "Archived series cannot be edited or used for new batches" — R-001-3).

### IP-03 — Review gates and the stage rail

**Rail.** Always pinned at the top of the video workspace: `T · RS · SC · SB · IM · NA · TC · RE · QC · FA · EX`, each with state (`not run`, `running`, `done`, `awaiting approval`, `stale`, `failed`, `blocked`) and, where known, the pin (`v13`).

**Gate rules (visible, not implied).**

- Script approval is mandatory before any image or TTS call (R-005-2). Before approval, `IM` and `NA` show `blocked: script not approved` and offer no run button.
- Final approval is mandatory before export (R-005-3). `EX` shows `blocked: final approval required`.
- Rejecting a gate returns the video to the **named** stage and fires no downstream call (R-005-4). Rejection form: reason (required), target stage (select), "what this will invalidate" preview (IP-01) — because a rejection that comes with an edit is an edit.
- **Rejecting without editing invalidates nothing.** The panel says so: "Returning to script review without changing text leaves assets in place; the render stays current until you change something." (R-005-4, §10 OQ-3.)

**Optional gates.** Storyboard and individual visuals may be approved but do not block (R-005-1: "can approve or edit"). The rail distinguishes mandatory (SC, FA) from optional gates with a lock icon and the words "required" / "optional".

**Keyboard.** `g` then a stage letter jumps to that stage; `[` / `]` move between videos in the batch; `Shift+Enter` approves the current gate after a confirmation that restates the spend.

### IP-04 — The review loop: 17 scenes, replace one, reorder, and know what died

**Scene grid (S-12).**

- Tile content: scene id (stable, `S01`…`S17`), thumbnail, narration span (`3.4 s`), one-line action, state badge, pin (`v13`). No prompt text in the tile; prompts live in S-13 (density).
- **States per tile:** `ready`, `generating (14 of 17 done)`, `failed (attempt 3/3)`, `stale`, `needs review`, `selected`.
- **Selection and detail:** `Enter` or click opens S-13. Multi-select is deliberately absent — every action is per scene (R-007-1, R-021-2).
- **Replace:** from S-13, "Replace image" → IP-01 panel scoped to one scene ("1 image call; scene 7 visual and render become stale; 16 images and narration survive") → generate. The old image is retained as a previous version in S-13 ("attempt 2 of 3, 14:12 UTC, prompt hash abc123"), because provenance is required (R-013-1).
- **Reorder:** drag handle or `Alt+↑/↓`; a live strip shows the new order and the consequence ("captions remap to the new order; 0 image calls; 0 TTS calls; render stale"). Scene ids do not change (R-006-3, R-007-2). Committing reorder never calls a provider.
- **Prompt edit:** changes that one scene's prompt, treated as a replace for that scene (1 image call, that visual + render stale). Recorded as a UX interpretation, §10 OQ-2.
- **First-three checkpoint (PRD §10):** when the series uses a recurring protagonist, the image stage after script approval generates **scenes 1–3 only** and stops with `AWAITING_IMAGE_REVIEW`. S-12 shows a checkpoint banner: "3 of 17 generated. Check the protagonist before releasing the remaining 14 (14 image calls)." Actions: *Release remaining 14* or *Fix scene 1–3 first*. The rest of the grid is present but empty with explicit "not started" tiles, so the count is never a surprise. A series with no recurring character reference states "Protagonist checkpoint not applicable — this series has no recurring character" and generates all scenes in one pass.
- **Downstream death is stated at the moment of the action**, in the same words as IP-01, and then persists as the stale ribbon on the rail.

**Keyboard-only path for this loop** (testable, §7 AX-01): `j`/`k` move scene selection; `Enter` opens; `r` replace (opens IP-01, focus on preview); `Alt+↑/↓` reorder; `a` approve gate; `Esc` backs out without committing; the whole path is reachable without a pointer.

### IP-05 — Batch progress at 30 videos

**Rule.** The batch screen answers three questions in one glance: how far along, what needs me, and is anything stuck.

**Header:** `18 of 30 complete · 3 need attention · 9 running · 1 failed` with the completed/target count updating within 5 s without a reload (R-019-3, R-022-1). A "last update 2 s ago" ticker makes freshness visible; if the feed stalls >20 s the header says "progress feed delayed — last update 22 s ago" rather than showing a stale number as current.

**Per-video rows** (30 rows, no pagination needed at this scale): `# · title · current stage · state · attention reason · pin summary · last event (relative) · actions`.

**Grouping, in fixed order:** `Needs attention` (gate open / failed / blocked) → `Running` → `Not started` → `Complete`. Complete collapses to a count with an expander. This makes 30 rows cheap to scan and puts the operator's work at the top.

**Attention reason vocabulary** (single source, used in S-02, S-08, badges): `script approval`, `image review`, `final approval`, `failed: narration`, `blocked: 3 unsourced claims`, `blocked: duplicate topic`, `waiting: render slot`, `waiting: rate limit`, `resumed after restart`.

**Anti-noise rules.** Derived progress never interrupts with modals. Stage completions do not toast; only transitions to `Needs attention` or `FAILED` surface, and they surface in-place plus the Overview badge (R-022-1). A 30-video batch at 17 images each must not produce 510 notifications.

**Bulk affordance.** "Review next needing attention →" walks the attention queue without returning to S-08 (the daily loop, J-1, J-3).

### IP-06 — Failure recovery: retry scope stated before it runs

**Rule.** A retry button never appears without its scope. The scope is computed from persisted stage state, not from a guess (R-022-2).

**Scope panel content:**

1. **What failed** — stage, provider, model, HTTP status, error class `transient` / `non-retryable`, attempts `3 of 3`, backoff schedule already used (`1 s, 4 s, 16 s`) (R-011-2).
2. **What will re-run** — named stages with call counts: "narration (1 TTS call) → timing → render (1 pass)".
3. **What will not re-run** — named assets with counts and pins: "17 images (v13), approved script (rev 4), storyboard (17 scenes), research (5 sources)" (R-011-1, R-022-2).
4. **The guarantee, stated as a guarantee the operator can check:** "Retrying reuses every stored asset. No new provider call is made for a completed stage." And a link: "see attempt rows (S-19)".

**States:**

| Failure class | Panel | Retry control |
|---|---|---|
| Transient, attempts remaining | "attempt 2 of 3; next retry in 4 s (automatic)" | Manual "Retry now" available |
| Transient, exhausted | "3 of 3 attempts used at 16 s backoff" | "Retry now" (starts a new attempt sequence) |
| Non-retryable (4xx except 429, auth) | "Not retryable: HTTP 401. Retrying fails the same way." | Disabled, with the fix named ("key missing or rejected — check S-21") |
| Unknown-charge timeout | "Attempt 3 timed out at 60 s. This attempt may have been billed; it is recorded as **unknown charge**." | Retry enabled, and the copy does not promise that the timed-out call was free (R-012-4) |
| Idempotency-unprotected stage | "This stage does not support an idempotency key; a crash between call and save can duplicate one billable call." | Retry enabled with that caveat shown (R-012-2) |

**Restart, not retry.** A worker restart is a different panel: "Worker restarted at 14:02 UTC. 4 videos resumed at their last persisted stage. 0 completed stages re-ran. 0 duplicate attempt rows." (R-023-1, US-036.) The operator must be able to see the difference between "I asked for a retry" and "the system resumed".

### IP-07 — Degraded and blocked states

**Global banner taxonomy** (top strip, persistent while true, never colour-only, always with what still works and what does not).

| Condition | Banner copy (see §8 C-12…C-16) | Blocked | Still allowed | Trace |
|---|---|---|---|---|
| DB or queue unreachable at startup/at runtime | "Service not ready — database unreachable. New batches are rejected. Review and downloads of stored assets still work. Re-checking every 5 s; self-heals within 30 s of the database reporting ready." | New batches (HTTP 503, R-018-1) | Login, review, exports of existing assets | R-018-1, R-018-2 |
| Asset store unavailable | "Asset store unavailable. Stages that need to read or write media are queued; nothing is written to an unready store." | Image/narration/render/export | Topic/script editing | R-018-3 |
| Provider down (e.g. image) | "Image provider failing: 3 consecutive 503s since 14:02 UTC. 30 videos are paused at the image stage; other stages continue. Retries follow 1 s, 4 s, 16 s, then stop and need you." | That provider's stages | All other stages; review of stored assets | R-011-2, R-021-1 |
| Queue backed up | "Render queue: 6 waiting (1 concurrent render by default). Estimated wait shown as measured render time × 6, indicative only." | Nothing | Everything else | R-104, R-010 |
| Disk nearing limit | "Disk 91% full (1.8 GB free). New renders and image downloads will fail below the safety margin. Preview cleanup: 412 assets, 6.2 GB eligible." | New media writes at the margin | Review, export of already-stored assets | PRD §10, R-025-2 |
| Rate limit reached | Per-provider, informational: "Image rate limit reached (10/min). 8 calls queued; this is expected, not an error." | Nothing | Everything else | R-008-2 |
| Config/startup failure | SY-1 page: "Startup blocked: missing required config `ELEVENLABS_API_KEY`. Set it in `.env` and restart." | Everything | Nothing | R-016-5 |

**Rule.** A blocked state always names (a) the cause, (b) what is blocked, (c) what still works, (d) what the system is doing about it, (e) the exact next action for the operator. A degraded state never looks like a generic error.

### IP-08 — Cost and billing honesty (debug only)

- Attempt rows in S-19 are a **debug list**, one row per provider call: provider, model, prompt hash, provider request id, `billed_units`, idempotency (`protected` / `unprotected`), and charge status (`billed` / `unknown charge`) (R-012-1, R-012-2, R-012-4).
- **No sums, no totals, no averages, no currency, no charts, no export** of this list (D2). The list exists to answer "did this duplicate or possibly bill?", not "what did I spend".
- `billed_units` is labelled "billed units (debug)" and the screen states: "Not a cost report. No totals are computed (D2)."

### IP-09 — Optimistic-lock conflict (409)

- Precondition: two tabs editing the same document, second save loses (R-024-2).
- Inline, non-destructive: "This script was saved by another tab at 14:12 UTC (revision 5). Your revision 4 was not saved. Nothing was overwritten."
- Actions: *Compare* (field-level diff, read-only), *Keep my text* (re-apply on top of rev 5, producing rev 6 through the normal invalidation preview), *Discard mine*.
- The operator's typed text is never discarded automatically, and the tab keeps focus (R-024-2 "no lost update", §7 AX-21).
- Same pattern for series profile (`Draft v14` vs a newer `v15`), topic and storyboard.

### IP-10 — Citation arbitration (factual mode)

- The claims list is a table: claim text · state · source (domain + title + retrieval time) · actions.
- States: `sourced` (URL present and 2xx/3xx at generation time), `url unreachable` (with status code and when checked), `unsourced`, `acknowledged unsourced` (explicit, with operator + UTC time), `non-factual` (reworded out of the factual set).
- Actions per unsourced claim: *Attach source* (accepted sources only, `rerank_score ≥1.5`), *Reword as non-factual*, *Acknowledge as unsourced*.
- Acknowledge is a deliberate act: a dialog quoting the claim, the words "This claim will be exported as unsourced. The video will still be approved." and a confirm. It is recorded, not transient (R-027-3).
- Approve is disabled while any claim is `unsourced` or `url unreachable`, with the count and reason in the button's disabled-help text (R-027-3).
- Creative mode: the panel is absent and replaced by one line: "Creative mode — citation enforcement does not apply. The mode is recorded in the export manifest." (R-027-4.)

### IP-11 — Topic dedupe rejection and override

- Rejection is an inline result on S-09, not an error: "Rejected by dedupe: 0.91 similar to **video 4, 'Why We Procrastinate'** (threshold 0.85). Same rule applies to the last 10 videos of this series."
- The matched existing topic is shown in full, with its video link, so the operator can judge (R-020-3).
- Override requires a deliberate confirm ("Override dedupe and use this topic anyway") and is recorded on the video; the batch never blocks on a rejected topic (R-020-1, R-021-1).
- If the topic was proposed by the model, "Propose another" is the default action; override is secondary.

### IP-12 — Export integrity and posting

- S-17 shows an **eligibility table** before anything downloads: included videos (with reasons if excluded), `manifest.csv` row count, `posting_order` = unique integers 1..N, filenames unique, every referenced file present (R-014-3). Failures are listed by row, and the download button names the problem instead of producing a broken ZIP.
- `manifest.csv` columns shown as a preview: `posting_order, filename, title, srt, vtt, sidecar, duration_s, posted_flag` (R-014-2).
- Marking posted (S-18) requires platform, ISO-8601 UTC timestamp, URL; the form shows the timestamp it will store, e.g. `2026-10-20T16:04:00Z` (R-014-4).
- The words "publish", "post to", "connect account" never appear; the button is "Mark as posted (manual upload)" (D8).

### IP-13 — Cleanup preview

- S-20 states retention ("keep originals and renders ≥365 days") and computes the preview with **exact** numbers: asset count, total bytes, oldest/newest (R-025-1, R-025-2).
- Protected assets are counted separately and excluded with a reason: "412 eligible · 38 protected (unposted project) · 6 in-flight batch assets" (R-025-3).
- Deletion requires typing the count or the word `delete` plus confirm; the confirm restates count and bytes. After deletion, a receipt lists what was removed.

### IP-14 — Destructive confirmations

| Action | Confirmation class | Copy requirement |
|---|---|---|
| Delete assets (S-20) | Type-to-confirm (`delete`) | Exact count + bytes + protected count (IP-13) |
| Regenerate over an approved stage | Two-step: IP-01 preview, then confirm | Names the approved revision being replaced, the calls, and that the previous asset is retained |
| Delete a draft topic / discard an unsaved edit | Single confirm, focus on Cancel | What is lost, what survives |
| Archive a series | Single confirm | "The open batch keeps running. No new batch or topic can be created. Unarchive later." (R-001-3) |
| Cancel a batch | Two-step, typed `cancel batch` | "Stops scheduling new stages. In-flight provider calls cannot be aborted and may still bill. Completed assets are kept. Remaining videos become CANCELLED and are excluded from export." (§10 OQ-4) |

No destructive action is ever the default focus, and none is reachable by a single `Enter` from a list row.

---

## 5. Wireframes (low fidelity)

Structure, hierarchy and states only. No colour, type, spacing or component decisions (UI designer's job). Annotations name the required behaviour and its trace.

### W-01 — Overview / attention inbox (S-02)

```
+--------------------------------------------------------------------------------+
| reels-generator        [ Service: ready ]  [ 4 need attention ]   operator  v  |
+-------------+------------------------------------------------------------------+
| Overview  * |  Needs attention (4)                                             |
| Series      |  +------------------------------------------------------------+  |
| Batches     |  | Quiet Mind / batch 2026-10-20-a                            |  |
| Posting     |  |  #7   script approval      script rev 4       2 min ago    |  |
| Health      |  |  #12  image review         3 of 17 generated  14 min ago   |  |
|             |  |  #18  failed: narration    attempt 3/3        1 h ago      |  |
|             |  |  #22  blocked: 3 unsourced claims (factual)   3 h ago      |  |
|             |  +------------------------------------------------------------+  |
|             |                                                                  |
|             |  Running (9)         12 of 30 complete   [open batch]            |
|             |  Not started (5)                                                 |
|             |  Complete (9)        collapsed                                    |
+-------------+------------------------------------------------------------------+
```
Annotations: counts are live within 5 s (R-022-1); each row links straight to the gating tab (IP-03); the attention badge is the only global counter (J-1). First-run empty state: one sentence + **Create series** (no other action).

### W-02 — Batch create (S-07)

```
+--------------------------------------------------------------------------------+
| <- Quiet Mind                                          signed in: operator     |
+--------------------------------------------------------------------------------+
| New batch                                                                      |
|                                                                                |
|  Videos to produce        [ 30 ]      integer 1-30            (R-019-1)        |
|  Duration per video       [ 75 ] s    series default 75; 10-180, <=90 advised  |
|  Series version            v13        pinned at creation      (R-019-2)        |
|  Mode                      creative   (series setting, versioned)              |
|                                                                                |
|  Expected per video  (informational volume, not a cost estimate)               |
|    17 image calls . 1 TTS call . 1 render                                      |
|    text + research calls set by the authoring stage                            |
|  For 30 videos       510 image calls . 30 TTS calls . 30 renders               |
|                                                                                |
|  No schedule. No timer or automation can create a batch.   (R-019-4)           |
|                                                                                |
|                                        [ Cancel ]   [ Create batch ]           |
+--------------------------------------------------------------------------------+
```
Annotations: counts derive from the scene count of a 75 s target (17, R-009-2) and are labelled indicative; no currency (D2); creation is the only path and requires the explicit count (R-019-4).

### W-03 — Batch detail, 30 videos (S-08)

```
+--------------------------------------------------------------------------------+
| Overview / Quiet Mind / batch 2026-10-20-a                                     |
| 18 of 30 complete . 3 need attention . 9 running . 1 failed   upd 2 s ago      |
| [ Review next needing attention -> ]     [ filters: all | attention | failed ] |
+--------------------------------------------------------------------------------+
| NEEDS ATTENTION (3)                                                            |
|  #7   script approval    SC awaiting    rev 4      v13   2 min    [open]       |
|  #12  image review       3/17 generated v13      14 min    [open]              |
|  #18  failed: narration  NA failed 3/3  v13       1 h     [retry scope]        |
| RUNNING (9)                                                                    |
|  #4   images 11/17       IM running     v13       8 s     [open]               |
|  #5   waiting: render    RE waiting     v13      12 s     [open]               |
|  #6   waiting: rate lim  IM queued 10/m v13      12 s     [open]               |
| NOT STARTED (5)                                                                |
|  #25 .. #29                                                                    |
| COMPLETE (13, collapsed)  [show]                                                |
+--------------------------------------------------------------------------------+
| pins: all v13        links: [batch export] [health]                            |
+--------------------------------------------------------------------------------+
```
Annotations: fixed group order puts work at the top (IP-05); the failed row offers *retry scope*, never a bare retry (IP-06); "waiting: rate limit" is benign (R-008-2).

### W-04 — Video workspace shell (S-09…S-16)

```
+--------------------------------------------------------------------------------+
| Overview / Quiet Mind / batch a / video 7 of 30        [ < ] [ > ]  next video |
| "Why We Procrastinate"        status: AWAITING_SCRIPT_APPROVAL                 |
| T done . RS done . SC*await . SB . IM . NA . TC . RE . QC . FA . EX            |
|                    ^ you are here                stale: none                   |
+--------------------------------------------------------------------------------+
| Topic | Script | Storyboard | Scenes | Audio | Render | Export                 |
+--------------------------------------------------------------------------------+
| (tab content; the change-impact panel lives in the right column on edit tabs)   |
|                                              | CHANGE IMPACT                  |
|                                              | ...                            |
+--------------------------------------------------------------------------------+
| pins: T v13 RS v13 SC v13 . mode: creative . 1 TTS call used . 0 image calls   |
+--------------------------------------------------------------------------------+
```
Annotations: the rail is the navigation *and* the status (IP-03); pins footer is always present (R-002-4); `stale:` in the header is the persistent half of IP-01.

### W-05 — Script review + claims + change impact (S-10)

```
+--------------------------------------------------------------------------------+
| Script  rev 4 (unsaved changes)             [ approve script: BLOCKED ]        |
| 228 words -> 75.1 s @ 3.035 w/s    band 216-239 words (71.2-78.7 s)            |
| 8-gram scan: PASS  no run >= 8 words from 2 stored references                  |
+---------------------------------------------+----------------------------------+
| hook / narration / ending (editor)          | CHANGE IMPACT   (R-006-1)        |
|  ...                                        | becomes stale:                   |
|                                             |   scene prompts (17)             |
| title / description / hashtags              |   narration  (1 TTS call)        |
|  ...                                        |   timing & captions              |
|                                             |   render     (1 pass)            |
| CLAIMS (14 factual . 11 sourced . 3 unsourced)| survives:                       |
|  c1  "..."        nih.gov  2026-10-14  ok   |   17 images (v13)                |
|  c7  "..."        --        unsourced   !   | text calls: re-derive 17 prompts |
|  c9  "..."        404  url unreachable  !   |                                  |
|  c12 "..."        --        unsourced   !   | [ Apply edit (no regeneration) ] |
|  [ attach source ] [ reword ] [ acknowledge ]| [ Apply and regenerate now ]    |
+---------------------------------------------+----------------------------------+
```
Annotations: approval is blocked by the citation count, not by a modal (R-027-3, IP-10); word budget is numeric and comes from the measured pace (R-009-3, QUALIFICATION §2); the no-spend commit is first in reading and tab order (DI-03); the scan result is operator-visible only, never sent to a provider (R-003-2, R-003-3).

### W-06 — Scene grid, 17 scenes with the first-three checkpoint (S-12)

```
+--------------------------------------------------------------------------------+
| Scenes  IM: awaiting review (3 of 17 generated)        [ release remaining 14 ]|
| CHECKPOINT  comparing scenes 1-3 for the recurring protagonist  (PRD sec 10)   |
+--------------------------------------------------------------------------------+
| [S01 ready v13] [S02 ready v13] [S03 ready v13] [S04 not started] [S05 ...]    |
|  (thumb)         (thumb)         (thumb)         (empty)          (empty)       |
|  3.4 s . v13     2.9 s . v13     3.1 s . v13     --                             |
|                                                                                |
| [S06] [S07] [S08] [S09] [S10] [S11] [S12] [S13] [S14] [S15] [S16] [S17]       |
+--------------------------------------------------------------------------------+
| selected: S03 . actions: [open] [replace: 1 image call] [reorder: 0 calls]     |
| reorder moves captions + render to stale only (R-006-3)                        |
+--------------------------------------------------------------------------------+
```
Annotations: unimplemented scenes are shown, not hidden, so the 17 count is never ambiguous; per-tile state and pin (R-007-2, R-013-1); replace and reorder cost are labelled at the point of action (R-006-1, R-006-3); the checkpoint is a stop in the stage (DI-10).

### W-07 — Invalidation preview, conditional aspect-ratio case (IP-01)

```
+--------------------------------------------------------------------------------+
| Change aspect ratio  9:16 -> 4:5                              (unsaved)         |
+--------------------------------------------------------------------------------+
| becomes stale                                                                  |
|   composition (17 scenes)                                                      |
|   render (1 pass)                                                              |
| images                                                                         |
|   pending reframe check (local, no provider call) ............ [ checking ]    |
|   if reframeable:      0 image calls, 17 images survive (reframed)             |
|   if not reframeable:  17 image calls, 0 images survive                        |
| narration: survives (79.1 s)                                                   |
|                                                                                |
| [ Apply only (no regeneration) ]        [ Apply and regenerate ]  (disabled     |
|                                                          until check resolves)  |
+--------------------------------------------------------------------------------+
```
Annotations: the one conditional in the matrix is resolved *before* spending; the button is disabled while unresolved (R-006-2); nothing here prices anything (D2).

### W-08 — Failure recovery / retry scope (IP-06)

```
+--------------------------------------------------------------------------------+
| Video 18 . stage NA (narration) . FAILED                                       |
| ElevenLabs . eleven_multilingual_v2 . request id req_8f21 . HTTP 503           |
| class: transient . attempts 3 of 3 . backoff used 1 s, 4 s, 16 s   (R-011-2)   |
+--------------------------------------------------------------------------------+
| WILL RE-RUN                                                                    |
|   narration   1 TTS call                                                       |
|   timing      derived from new alignment                                       |
|   render      1 pass                                                           |
| WILL NOT RE-RUN (stored, reused)                                               |
|   17 images (v13) . script rev 4 approved . storyboard 17 scenes . 5 sources   |
|   guarantee: no new provider call for a completed stage   (R-022-2)            |
+--------------------------------------------------------------------------------+
| attempt rows: 3 . 1 recorded as UNKNOWN CHARGE (timeout at 60 s)  (R-012-4)     |
|                              [ Cancel ]   [ Retry narration - 1 TTS call ]     |
+--------------------------------------------------------------------------------+
```
Annotations: scope before action; asset reuse stated as a checkable guarantee; unknown charge is never softened to "unbilled"; focus starts on Cancel.

### W-09 — Failures & health, degraded (S-19)

```
+--------------------------------------------------------------------------------+
| Health                                                                         |
| +----------------------------------------------------------------------------+ |
| | DEGRADED  database unreachable since 14:02 UTC                             | |
| | blocked: new batches (HTTP 503 on /ready)                                  | |
| | still works: login, review, downloads of stored assets                     | |
| | system: re-checking every 5 s; self-heals within 30 s of DB ready  (R-018) | |
| +----------------------------------------------------------------------------+ |
| providers      text: ok (last ok 14:01)  image: 3x 503 since 14:02           |
|                tts: ok                  research: ok                          |
| qualification  image PASS 2026-10-20 . tts PASS . text PASS . research PASS   |
| queue          render 6 waiting (1 concurrent, default)  images 8 queued      |
| disk           91% full . 1.8 GB free . preview cleanup ->  (R-025)           |
| attempt rows   [ last 50 ]  provider . model . prompt hash . req id .          |
|                billed_units (debug) . idempotency . charge    no totals (D2)  |
+--------------------------------------------------------------------------------+
```
Annotations: cause → blocked → still-works → system action → operator action (IP-07); qualification records satisfy R-008-3's recorded pass/fail; the attempt list is debug-only (IP-08); no aggregate spend anywhere (D2).

### W-10 — Batch export with integrity panel (S-17)

```
+--------------------------------------------------------------------------------+
| Batch export  2026-10-20-a                                                     |
| eligible 29 . excluded 1 (#18 FAILED: narration - retry to include)            |
+--------------------------------------------------------------------------------+
| manifest.csv check                                  (R-014-3)                  |
|   rows = videos ................ 29  ok                                        |
|   posting_order 1..N unique .... 1..29  ok                                     |
|   filenames unique ............. ok                                            |
|   referenced files present ..... 29/29 ok                                      |
| columns: posting_order, filename, title, srt, vtt, sidecar, duration_s,         |
|          posted_flag                                        (R-014-2)          |
+--------------------------------------------------------------------------------+
| privacy: no API keys or secrets in any file in this ZIP        (R-015-5)        |
|                          [ Export ZIP ]        [ include #18 later when fixed ] |
+--------------------------------------------------------------------------------+
```
Annotations: integrity is proven before download; exclusions are explicit and reasoned; the posting log (S-18) is the only place `posted_flag` changes (R-014-4).

---

## 6. State inventory

States per screen: **E** empty (including first-run where applicable), **L** loading, **P** partial, **ER** error, **BL** blocked, **S** success. Screens S-09…S-16 share the workspace shell, whose shell-level states are listed once (S-09 row) and each tab adds its own.

### 6.1 Full table

| Screen | E — empty | L — loading | P — partial | ER — error | BL — blocked | S — success |
|---|---|---|---|---|---|---|
| S-01 Login | Fields blank, no error, no register/reset link | Submit disabled, "signing in" | n/a | "Wrong username or password" — same message for both fields, no account enumeration | Session cookie missing on a protected route → redirect here with "sign in to continue" | Redirect to S-02 |
| S-02 Overview | **First run:** "No series yet. No batches yet." + Create series (only action) | Skeleton counters + 3 skeleton rows | Some batches failed to load: per-batch error row "could not load batch — retry", other batches still shown | Whole-feed error: "Status feed unavailable (last good 14:02 UTC). Nothing was changed." | Degraded banner + attention list still readable (R-018) | Attention list, running list, complete count |
| S-03 Series list | Empty: "No series yet" + Create series | Row skeletons | Archived series shown collapsed with badge; a series whose batch count failed shows "—" | Load error with retry | Archived series row: batch/topic creation disabled with reason (R-001-3) | 5+ rows with version chip, batch count, archive state |
| S-04 Series editor | New profile: all blocks blank, Save disabled ("nothing to save") | Saving → "minting v14" | Unsaved changes with per-field changed marks | Save error: inline at field or global, text preserved (IP-09 on conflict) | Archived: read-only + reason. No provider key for a required capability: field-level warning, save still allowed | "Saved as v14", version chip updated |
| S-05 Version history | Only v1 exists: single row + "later edits appear here" | Skeleton rows | Version list loaded, in-use counts still computing ("—") | Load error + retry | n/a | Rows with version, time, changed fields, in-use counts |
| S-06 Version detail | n/a (a version always exists) | Loading | Diff still computing | Load error | Version is immutable: no edit affordances, by design | Snapshot + diff vs chosen version |
| S-07 Batch create | Fields at defaults (30, 75 s), Create disabled until a series version is resolvable | Creating → "creating 30 videos" | n/a | "Batch not created: <reason>" with the form intact | Series archived → form disabled with reason. Service not ready → HTTP 503 copy (R-018-1) | Redirect to S-08 with 0 of 30 |
| S-08 Batch detail | Impossible for a real batch (min 1); for a legacy empty batch: "This batch has no videos" | Skeleton rows + counters | Mixed: some rows loaded, per-row error placeholders; counters marked "partial" | Whole-batch load error; progress feed stalled banner ("last update 22 s ago") | Batch cancelled: read-only list + reason. Degraded: banner, per-video actions limited | 30 rows grouped, counters live |
| S-09 Topic & research | No topic yet: "propose a topic" (B) or manual field (A) | Proposing / researching with step text ("search 1 of 3, 5 results, 1 accepted") | Some claims have sources, some pending | Research adapter failed (retryable/non-retryable per IP-06 wording) | Duplicate topic (IP-11); factual mode with zero accepted sources | Topic + accepted/rejected evidence list + claim chips |
| S-10 Script | No script yet (blocked on topic approval) | Drafting with schema retry counter | Draft present, claims partially resolved, scan running | Schema failure after 3 retries: failing field, schema version, retry count (R-004-2) | Approval disabled: unsourced claims / 8-gram hit / script not validated | Approved rev with approver + time |
| S-11 Storyboard | No storyboard yet (needs approved script) | Splitting into scenes | Scene list present, narration spans pending | Storyboard failed after 3 retries (R-004-2) | Not reachable before script approval | 17 scenes with spans and prompts |
| S-12 Scene grid | 0 of 17 generated, all tiles "not started" + checkpoint copy | Tiles fill progressively: "11 of 17" | **The normal state:** some tiles ready, some generating, some failed, some stale | A tile failing: tile-level error + retry scope; grid keeps working | Image stage blocked (script unapproved, provider down, rate limit) | All 17 ready, first-three checkpoint cleared |
| S-13 Scene detail | Scene exists by definition; image slot empty if ungenerated | Image loading / generating with attempt n of 3 | Current image + previous attempts list | Scene generation failed 3/3 with provider detail | Blocked by provider/rate limit; replace disabled with reason | Image + prompt + provenance + pin |
| S-14 Narration & timing | No narration yet (needs approved script) | "1 TTS call running (11 s typical)" | Audio present, timings deriving | TTS failed (class + attempts) | Blocked: script unapproved; or duration out of band → "returns to script review" (R-009-4) | Audio + word timings + duration in band |
| S-15 Render & QC | No render yet | "render 1 of 1 running" or "waiting: render slot 1 of 1" | Render done, QC running | Render failed (stage detail, no provider) / QC failed with exact failing check | Final approval blocked: QC failing check named | MP4 + all QC checks passing + approved |
| S-16 Export & provenance | Not eligible: final approval required | Package building | Package built, a referenced file missing → list of missing files | Package build failed | Not approved → no download (R-005-3) | Download link + pins + file list |
| S-17 Batch export | No eligible videos: "nothing to export yet — 30 videos need final approval" | ZIP building with count | Some videos excluded: exclusion table with reasons | ZIP build failed with the failing step | Integrity failure (duplicate posting_order, missing file) blocks download and lists rows | ZIP + integrity ok |
| S-18 Posting log | "Nothing marked posted yet" + explanation that posting is manual | Row loading | Some posted, some unposted | Save failed for one row, value retained | n/a | Rows with platform, UTC timestamp, URL, `posted_flag` |
| S-19 Health | Fresh install: all providers "present", qualification "not run" | Status loading | Some providers report, one times out ("unknown, last seen") | Probe error is itself a health finding | Degraded startup (SY-1) or readiness failure | All green + attempt rows + disk headroom |
| S-20 Data & cleanup | No eligible assets: "nothing is past retention" | Computing preview | Preview partial: "412 of 430 computed" | Compute failed: no delete offered | Assets protected: deletion disabled with protected count (R-025-3) | Preview + delete with typed confirm + receipt |
| S-21 Settings | Fresh install: 3 keys "absent" with setup pointer | Checking presence | Two present, one absent | Presence check itself failed ("could not verify") | n/a | 3 keys present + qualification pass/fail + dates |

### 6.2 Explicit expansions

**First run (S-02 empty, the whole product empty).** The operator has an account but no series, no batch, no assets. The screen must contain: one sentence of what the product does in this shell, one primary action (Create series), and one quiet line naming what is needed next ("three provider keys are checked in Settings"). It must **not** show a fake dashboard of zeros, charts, or disabled nav items pretending to be features. Nav rail shows all destinations, all of which have their own honest empty states.

**A 30-video batch (S-08 success + partial).** 30 rows, three groups, counters live. Required sub-states within the same screen: 0 complete; 1 running with 29 not started; 12 complete with 1 failed; 29 complete with 1 failed; 30 approved awaiting export; 30 exported with 22 posted. The failed-in-the-middle case is the canonical one: the grid must show the failure **and** that the other 29 are unaffected in the same glance (R-021-1). With 30 rows the operator must never need to open a detail screen to learn *which* video failed and *at what stage*.

**Video workspace partial (S-09 shell).** The shell always shows: current stage, stage rail with stale markers, pin footer, mode, and spend so far in calls. Partial-data states (a tab whose data failed) leave the rail intact so the operator never loses their place.

**Factual-mode blocked (S-10 BL).** Approve disabled, count visible, three unresolved claim rows, per-claim actions, no modal. The disabled control must carry the reason as accessible text (§7 AX-11), not a tooltip only.

**Degraded (S-19 BL + global banner).** Cause, blocked scope, working scope, system action, operator action — always all five (IP-07).

---

## 7. Accessibility and usability requirements (testable)

Target: **WCAG 2.2 AA** on the review loop, because the review loop is the product. Each item below is written so QA can test it.

### 7.1 Keyboard-only review loop

| ID | Requirement | Test |
|---|---|---|
| AX-01 | The whole review loop is completable with a keyboard alone: login → open attention item → read script → approve script → release 14 images → open scene 13 → replace → reorder scenes 13 and 14 → accept timing → approve final → download package. | Perform F-A end-to-end with the pointer physically disconnected. Zero dead ends. (R-005-1, IP-04) |
| AX-02 | Every interactive element is reachable in a logical order, and focus order matches visual order on all edit tabs. | Tab through S-10 and S-12; focus order equals reading order; no element skipped, none reachable only by pointer. |
| AX-03 | No action is bound to a keyboard shortcut that conflicts with browser or assistive-technology shortcuts; all single-key shortcuts are active only when focus is not in a text field. | Type `j` `r` `a` inside the script editor: they insert characters, they do not navigate. |
| AX-04 | The spend-incurring action is never the default focus and never triggered by a bare `Enter` from a list. | In IP-01 and IP-06 panels, initial focus is on the no-spend action; `Enter` on a batch row opens, it does not regenerate. (DI-03, IP-14) |
| AX-05 | Scene reorder is operable without drag-and-drop. | Reorder with `Alt+↑/↓`; announce old and new position. (R-006-3) |

### 7.2 Focus management and announcements

| ID | Requirement | Test |
|---|---|---|
| AX-06 | Focus never moves as the result of a background update. When a video's stage completes while the operator is on another tab, only a live-region announcement occurs. | Start a 30-video batch; keep focus in the script editor for 5 min; focus never moves; announcements are ≤1 per 5 s. (R-022-1) |
| AX-07 | After a regeneration is triggered, focus moves to the status region for that stage (labelled with stage code and video id), and returns to the triggering control when the stage settles. | Trigger replace on S-13: focus lands on "scene 7 image — generating, attempt 1 of 3"; on completion returns to Replace. (R-011-1) |
| AX-08 | When a gate opens (approval required), the announcement names the video, the gate and the count of items waiting — never a generic "update available". | The live-region text reads e.g. "Video 7 of 30 needs script approval. 4 videos need attention." |
| AX-09 | Dialogs and inline panels trap focus, close on `Esc` without committing, and return focus to the opener. | Test IP-10 acknowledge dialog and IP-13 typed confirm. |
| AX-10 | Batch grid progress updates are announced as a debounced summary ("18 of 30 complete"), not per row. | 30-video batch run: announcements ≤1 per 5 s and never one per tile. (IP-05) |
| AX-11 | A disabled control that blocks progress always exposes its reason as text associated with the control (described-by), not only as a tooltip or colour. | S-10 approve: screen reader reads the citation count. (R-027-3) |

### 7.3 Perception

| ID | Requirement | Test |
|---|---|---|
| AX-12 | Body text contrast ≥ 4.5:1; text ≥ 24 px or bold ≥ 18.7 px ≥ 3:1; UI boundaries and state indicators ≥ 3:1 (WCAG 1.4.3, 1.4.11). | Token audit in UI_SPEC. |
| AX-13 | State is never conveyed by colour alone: every stage/attention/video state has text (or text + icon) — `FAILED`, `stale`, `blocked` are words. | Greyscale screenshot test of S-08 and the stage rail. (R-006-1 visibility) |
| AX-14 | Text reflows at 320 CSS px with no horizontal scrolling for reading surfaces, and zoom to 200% without loss of function. | Browser zoom 200% on S-02, S-08, S-10. |
| AX-15 | Images and video: every scene image has an accessible name derived from its prompt summary; the render `<video>` has captions available and a text alternative stating duration and dimensions. | Screen-reader pass on S-12, S-15. (R-013-1) |
| AX-16 | Motion: Ken Burns/render previews respect `prefers-reduced-motion` and can be paused; no auto-playing audio. | Enable reduced motion: previews are static frames. |
| AX-17 | Target size: all pointer targets ≥ 24×24 CSS px; primary review and approve controls ≥ 44×44 px with ≥ 8 px separation (WCAG 2.5.8). | Measure on S-12 tiles and IP-06 buttons. |
| AX-18 | Focus indicator is visible on every element, with ≥ 3:1 contrast against its background and ≥ 2 px thickness (WCAG 2.4.13). | Keyboard pass with a high-contrast check. |

### 7.4 Cognitive and error-prevention

| ID | Requirement | Test |
|---|---|---|
| AX-19 | Every number shown to the operator is exact and sourced from current state (scene count, call counts, words, seconds, bytes). Prohibited: "some", "several", "a few", "approximately" for anything the system can count. | Copy audit against §8; the only permitted approximations are the labelled indicatives in §0.4. |
| AX-20 | The same fact has the same wording everywhere: one string per state name, one string per error class. | Cross-screen string audit (S-02, S-08, S-15, S-19). |
| AX-21 | Unsaved edits are never lost: not by navigation, refresh, session expiry or a 409. After re-login the draft is restored with a banner naming its age. | Kill the session mid-edit; re-login; text intact. (R-024-2, IP-09) |
| AX-22 | Phone view (≤ 480 px) is monitoring-only: S-02 and S-08 read-only plus "open on desktop" affordances. **No gate approval, no replace, no delete, no retry** is offered below 768 px. | Attempt every gate on a 390 px viewport: none available, each explains why. (DI-09) |
| AX-23 | Destructive actions require the typed or two-step confirmations in IP-14, and no destructive action is reachable in one keystroke from a list. | Attempt single-`Enter` delete: impossible. |
| AX-24 | Long operations are cancellable or safely abandonable at the UI level: leaving the page never cancels a job, and the screen says so. | Navigate away mid-render; job continues; return shows correct state. (R-011-1) |
| AX-25 | Every failure surface answers: what failed, at which stage, what class, attempts used, what survived, what a retry re-runs, next operator action. Missing any of the six is a defect. | Audit S-15, S-19, IP-06 against the six. (R-011-2, R-022-2) |
| AX-26 | The UI never claims a timed-out call was unbilled. The string "unknown charge" appears wherever a timeout attempt is shown. | Force a TTS timeout: the attempt row says unknown charge. (R-012-4) |
| AX-27 | Response budget: batch counters reflect a state change within 5 s with no manual refresh; a stalled feed is labelled with its last-update age. | Change a video state; measure ≤ 5 s; stop the feed and confirm the label. (R-022-1) |
| AX-28 | No blocking spinner over a whole screen during generation; per-region progress only, and the rest of the screen stays operable. | Start a 30-video batch; all review surfaces remain usable. |

---

## 8. Copy guidance

### 8.1 Rules

1. **Numbers first, nouns second.** "17 image calls" not "several image calls".
2. **No currency, no credits, no totals** (D2). Call counts are the only quantity in a spend warning.
3. **Two buttons, named by outcome:** *Apply edit (no regeneration)* / *Apply and regenerate now*. Never "OK/Cancel" on a spend decision.
4. **Name what survives.** A warning that only lists losses is incomplete.
5. **Never assert an unverified fact about billing** (R-012-4).
6. **Banned phrasings:** "Something went wrong", "Oops", "An error occurred", "Please try again later" (without a cause and a next step), "Are you sure?" (without the consequence), "Invalid input" (without the field), "AI-generated" as a risk disclaimer in place of a real check, "publish/post to <platform>", "upgrade", "credits remaining".

### 8.2 Templates

| ID | Context | Copy |
|---|---|---|
| C-01 | Invalidation preview, script edit | "Changing the script makes **scene prompts (17), narration (1 TTS call), timing and captions, and the render (1 pass)** stale. **17 stored images survive** — a wording-only edit does not regenerate images. Text calls: 17 prompts re-derived." |
| C-02 | Invalidation preview, one image | "Replacing scene 7's image costs **1 image call**. Scene 7's visual and the render become stale. **Images 1–6 and 8–17 and the narration survive.**" |
| C-03 | Invalidation preview, reorder | "Reordering changes captions and timing, and makes the render stale. **0 image calls. 0 TTS calls. 17 images and the narration survive.** Scene ids stay S01–S17." |
| C-04 | Invalidation preview, voice/speed | "Changing the voice or speed makes **narration (1 TTS call), timing and the render** stale. **17 images survive.**" |
| C-05 | Invalidation preview, aspect ratio, unresolved | "Composition and the render become stale. Images: **pending reframe check** — 17 calls only if the current images cannot be reframed. The regenerate action stays disabled until that is known." |
| C-06 | Invalidation preview, topic after research | "Changing the topic makes **the script and everything downstream** stale: script, storyboard, narration (1 TTS call), timing, render. **No image call is made until you approve the new script.**" |
| C-07 | Preview could not be computed | "The impact of this change could not be computed, so regeneration is blocked. Editing and regeneration are both disabled until it can be computed — this prevents a change whose cost you could not see." |
| C-08 | Series version commit | "Saving mints **v14**. Nothing is regenerated. 30 videos keep their current pins; stages that have not started will use v14 when they start. v13 stays immutable." |
| C-09 | Script gate, ready | "Approving the script unlocks **17 image calls and 1 TTS call** for this video. Nothing runs until you approve." |
| C-10 | Script gate, blocked by citations | "Script approval is blocked: **3 of 14 factual claims have no resolvable source.** Source, reword or acknowledge all 3 first." |
| C-11 | Script gate, word budget | "228 words → about 75.1 s at the measured 3.035 words/s. Band for a 75 s target: 216–239 words. Outside the band, narration will most likely miss the ±5% duration check and return here after one TTS call." |
| C-12 | Degraded, DB/queue | "Service not ready — the database is unreachable. New batches are rejected (HTTP 503). Review and downloads of stored assets still work. Re-checking every 5 s; recovers within 30 s of the database reporting ready." |
| C-13 | Degraded, provider | "The image provider has failed 3 times in a row since 14:02 UTC. 30 videos are paused at the image stage; other stages continue. Automatic retries use 1 s, 4 s and 16 s, then stop and wait for you." |
| C-14 | Degraded, disk | "Disk is 91% full (1.8 GB free). Renders and new image downloads will fail below the safety margin. Cleanup preview: **412 assets, 6.2 GB** eligible, 38 protected. No new media writes until space is freed." |
| C-15 | Degraded, rate limit | "Image rate limit reached (10 requests per minute). **8 calls queued** — this is expected, not an error." |
| C-16 | Startup blocked | "Startup blocked: missing required configuration `ELEVENLABS_API_KEY`. Set it in `.env` and restart the stack. Other services are not started." |
| C-17 | Retry scope | "Retry will re-run **narration (1 TTS call), timing and the render (1 pass)**. It will **not** re-run the 17 images, the approved script, the storyboard or the research. Retrying reuses every stored asset: no new provider call is made for a completed stage." |
| C-18 | Unknown charge | "This attempt timed out at 60 s. It may have been billed. It is recorded as **unknown charge** — not as unbilled." |
| C-19 | Non-retryable | "Not retryable: HTTP 401 from ElevenLabs. Retrying fails the same way. Fix the key in Settings, then retry." |
| C-20 | Failure summary shape | "<Stage> failed for video <n>: <error class>, <HTTP status> from <provider>, attempt <a> of 3. <What survived>. <What a retry re-runs>." |
| C-21 | Dedupe rejection | "Rejected: 0.91 similar to video 4, 'Why We Procrastinate' (threshold 0.85). The same rule applies to the last 10 videos of this series. Use it anyway, or propose another topic." |
| C-22 | Batch progress | "18 of 30 complete · 3 need attention · 9 running · 1 failed. Last update 2 s ago." |
| C-23 | Export integrity failure | "The ZIP was not built. `manifest.csv` has posting_order 7 twice; every row must have a unique integer 1..29. Nothing was downloaded." |
| C-24 | Posting log | "Posted on <platform> at 2026-10-20T16:04:00Z — <url>. This sets `posted_flag=1` in the next export. Posting itself is manual; this product does not publish." |
| C-25 | Cleanup preview | "412 assets, 6.2 GB, oldest 2025-10-20. 38 assets are protected because their project is unposted, and 6 because a batch is in flight. Deleting is permanent." |

### 8.3 Number formatting

- Counts: plain integers with thousands separators only above 9,999 (e.g. `510`, `1,311`).
- Durations: `mm:ss.s` up to one decimal (`79.1 s`, `05:12`); the band is shown in both words and seconds (`216–239 words (71.2–78.7 s)`).
- Bytes: binary units, one decimal (`6.2 GB`).
- Timestamps: ISO-8601 UTC in data contexts (`2026-10-20T16:04:00Z`); relative ("2 min ago") in lists with the absolute value in the accessible name.
- Percentages: one decimal, signed where it is a deviation (`+5.5%`).

---

## 9. Coverage, milestone mapping and handoff

### 9.1 Story coverage

All 37 P0 stories are designed for. Stories with no dedicated screen are shown with what they surface as.

| Story | Where it lives | Notes |
|---|---|---|
| US-001 Compose deployment | SY-1, S-19 | No product screen; only failure/readiness surfaces (R-016-5) |
| US-002 Migration & rollback | S-19 | Health endpoint state "migration failed"; a failed migration disables new work (R-017-4) |
| US-003 Degraded startup | S-19, IP-07 | Lifecycle states + self-heal banner (R-018) |
| US-004 Auth | S-01, SY-2, S-21 | Session cookie behaviour, no register/reset |
| US-005 Optimistic locking | IP-09 | Inline conflict, no page |
| US-006 Retention & cleanup | S-20, IP-13 | Preview with protected counts |
| US-007 Asset dedupe | — (invisible by design) | No screen: dedupe must not change any operator-visible behaviour (R-026). If it ever needs a screen, that is a defect in the model |
| US-008 Series create/edit | S-04 | Five field blocks |
| US-009 Duplicate/archive/≥5 | S-03, S-04, IP-14 | Archive confirmation + disabled creation |
| US-010 Versioning & pins | S-04, S-05, S-06, S-16, IP-02, F-D | Pins inspectable per stage (R-002-4) |
| US-011 Adapter layer | S-19 | Provider status, timeouts, rate-limit queue states |
| US-012 Qualification gate | S-21, S-19 | Recorded pass/fail + date |
| US-013 Attempt rows & idempotency | S-19, IP-08 | Per-row debug list, idempotency flag |
| US-014 Schema validation & retry | S-10, S-11, S-09 | Failing field, schema version, retry 3/3 |
| US-015 Topic proposal | S-09 | Rationale + source links |
| US-016 Research & source capture | S-09 | Accepted vs rejected, claim chips |
| US-017 Script draft & references | S-10 | Word budget, 8-gram scan result, style summary |
| US-018 Storyboard | S-11 | Scene count, spans, prompts |
| US-019 Image generation & provenance | S-12, S-13, W-06 | First-three checkpoint; provenance per asset |
| US-020 Image replace & stable ids | S-13, IP-04 | One call per replace |
| US-021 Narration | S-14 | Audio + request id |
| US-022 Speech-led timing | S-14 | Derived timings, band, return-to-review |
| US-023 Duration targets | S-04, S-07, S-14 | Per-series default, per-video override |
| US-024 Render | S-15 | Single render slot |
| US-025 QC | S-15 | Every check with a number |
| US-026 Per-video export + posted | S-16, S-18 | Package + mark posted |
| US-027 Batch ZIP + manifest | S-17, W-10 | Integrity panel |
| US-028 Review gates | IP-03, all tabs | Mandatory vs optional gates |
| US-029 Invalidation model | IP-01, W-07 | Matrix + conditional case |
| US-030 Scene reorder | IP-04, C-03 | 0/0 calls, captions remap |
| US-031 Recoverability & retry | IP-06, S-19 | Classes, backoff, manual retry |
| US-032 Batch creation | S-07, W-02 | 1–30, no automation |
| US-033 Topic dedupe | S-09, IP-11 | Match surfaced, override recorded |
| US-034 Batch independence | S-08, IP-05 | One failure does not stop 29 |
| US-035 Batch progress & cost-free retry | S-08, IP-05, IP-06 | 5 s freshness, reuse guarantee |
| US-036 Batch resumability | S-08, IP-06 | "resumed after restart" |
| US-037 Citation enforcement | S-10, IP-10, F-E | Blocked approval, ack, manifest |

**Stories I could not design a screen for:** US-007 only, and that is correct — asset dedupe is an invisible storage property (R-026-1) and must not surface. No story is undesigned.

### 9.2 Milestone mapping (so UI design and technical design can sequence)

| Milestone | Screens that must exist | Rationale |
|---|---|---|
| A | S-01, S-02 (single-video form), S-03 (list), S-04, S-09, S-10, S-11, S-12 (replace only, checkpoint), S-13, S-14, S-15, S-16, S-19 (providers + attempts), S-21, SY-1, SY-2 | Thin slice: one 75 s video, auth on, per-video export (BACKLOG §4) |
| B | S-02 (full attention), S-03 (duplicate/archive), S-05, S-06, S-07, S-08, S-09 (proposal + dedupe), S-12 (reorder), S-17, S-18, S-20, IP-09 | Batch, export ZIP, retention, locking, citation enforcement (US-037 in B) |
| C | No new screens | Exercise S-07…S-17 at N=30 |

### 9.3 What the UI designer must decide next

Colour, type, spacing, iconography, the visual language of the stage rail, the density of the 30-row grid and the 17-tile grid, focus-ring styling, and the exact visual treatment of `stale` vs `failed` vs `blocked` (they are three different states and must differ by more than hue).

### 9.4 What the CTO must decide next

The real stage/state machine behind §0.2 and IP-03 (US-028 owns it), how impact previews are computed server-side, how pins are stored per stage (R-002-2), how staleness propagates and clears, and how retry scope is derived from persisted state (R-022-2). This spec constrains those decisions (the UI must be able to answer the questions in §4) without prescribing the mechanism.

---

## 10. Open questions (none blocking)

Six genuine gaps in the approved artifacts, each with the default this spec assumes. None prevents UI or technical design from starting; each should be confirmed by the owner/PM when convenient, and any answer other than the default triggers a revision of this spec.

| # | Question | Why it is not answered by the PRD | Default assumed here | Impact if wrong |
|---|---|---|---|---|
| OQ-1 | For a factual claim the owner explicitly acknowledged as unsourced (R-027-3), what does the export source manifest row look like, given R-027-5 requires "one row per factual claim with URL and retrieval timestamp"? | R-027-3 permits acknowledgement; R-027-5 assumes a URL exists. The two can conflict for an acknowledged claim. | One row per claim; acknowledged-unsourced rows carry `url=""`, `retrieved_at=null`, `status="acknowledged-unsourced"`, plus operator and UTC time. S-16 shows the marker. | If the manifest instead requires a URL, acknowledged claims must be reworded before export and the acknowledge action must lose its "can still approve" property. |
| OQ-2 | Editing a scene **prompt** is not a row in the R-006-2 matrix. Is it a replace (1 image call) or a free text edit? | The matrix covers replacing an image, script, duration, aspect, captions/music, voice/speed, topic, reorder — not prompt text. | Treated as a replace for that scene: 1 image call, that visual + render stale. Prompt history retained. | If it should be free until regenerated, the panel wording changes from "1 image call" to "0 calls now; 1 when regenerated". |
| OQ-3 | Rejecting a gate **without** editing anything: does it invalidate anything? | R-005-4 says a rejection returns the video to the named stage and no billable call fires downstream, but says nothing about asset validity. | Rejection alone invalidates nothing (assets stay current); only an edit invalidates. The rejection form shows the IP-01 preview if, and only if, the operator changes something. | If rejection alone must re-run a stage, the reject action becomes a spend action and needs the IP-01 panel unconditionally. |
| OQ-4 | Batch **cancel** exists only by implication (R-001-3 says an archived series' batch "runs to completion or is explicitly cancelled by the owner"). What does cancel do to in-flight calls and completed assets? | No requirement defines cancel semantics. | Cancel stops scheduling new stages, cannot abort an already-issued provider call (and says so), keeps all completed assets, marks remaining videos CANCELLED and excludes them from export (S-17 lists exclusions with the reason). Typed confirmation (IP-14). | If cancel must also unwind completed work or block export of the batch, the S-08/S-17 states change. |
| OQ-5 | Is `posting_order` operator-editable, or always the batch's video order? | R-014-2 requires unique integers 1..N; nothing says who decides the order. | Operator-editable at S-17 by drag/`Alt+↑↓` on eligible videos, defaulting to batch order; the integrity check re-runs on every change. Export order is recorded in `manifest.csv`. | If it must be derived, S-17 loses an editing affordance and the integrity panel simplifies. |
| OQ-6 | Does a mid-batch series edit change the version used by videos already **inside** the pipeline, or only stages that start after the edit (i.e. is R-002-3 evaluated per stage or per video)? | R-002-3 says later, not-yet-executed stages adopt the newest version when they start — per stage. Operationally that means a series edit mid-batch can change narration or render style for videos already partly generated. | Evaluated **per stage**, exactly as written: a stage that has not started uses the newest version when it starts. S-04 and F-D state this explicitly, and S-16 shows per-stage pins so the operator can see the mix. | If the intent is per video (a video keeps one version for its whole life), S-04's commit copy and F-D change, and the pin inspector shows one pin per video instead of per stage — but note this would contradict R-002-2/4 as written. |

No other context is missing. Everything else in this spec traces to a numbered requirement, an acceptance criterion, or a measured qualification result.

---

## 11. Summary for the handoff

- **21 routed screens** (8 of them tabs inside one video workspace shell), **3 system surfaces**, **1 inline conflict pattern**, **14 interaction patterns**, **10 wireframes**, **5 end-to-end flows**, **28 accessibility/usability requirements** (AX-01…AX-28), **25 copy templates** (C-01…C-25).
- **The three interactions the product lives or dies by:** IP-01 (impact before spending, with editing and regenerating as separate commits), IP-05/IP-06 (30 videos at a glance; a retry's scope stated before it runs), IP-02 vs IP-01 (a series edit mints a version and regenerates nothing; a project edit invalidates and must say exactly what).
- **Hard constraints honoured throughout:** no currency or credit totals (D2), no publishing or scheduling (D8, D9, R-019-4), one seeded operator with no account surface (D3, R-015-3), one generic caption safe area (D13), no platform-specific previews, failures always shown with cause, class, attempts, survival and retry scope.
- **No blocking questions.** Six interpretation gaps in §10, each with a default and its impact if the default is wrong.
