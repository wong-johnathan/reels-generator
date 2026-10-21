# B-07 — TTS adapter + FakeTtsAdapter + qualify + word-timing

Task `t_fa5e83c8` · LEAD_PLAN §4 B-07 · US-011 (TTS), US-012 (TTS qualification), US-022
(word-timing half) · base `e793838` (B-02 head, which contains B-01 `3f70438`) · branch
`feat/t_fa5e83c8`.

Signal line, verbatim: _"monotonic word timings derived on the qualification fixture; TTS qual
recorded."_

Test-id convention: `W` = `src/domain/word-timing.test.ts`, `T` = `src/adapters/tts.test.ts`,
`Q` = `src/adapters/tts-qualify.test.ts` (DB), `P` = `src/db/repositories/provider-qualifications.test.ts`
(DB).

---

## 1. Acceptance mapping

| Requirement / criterion                                                                                                                                                  | What this task delivers                                                                                                                                                                                                                                                            | Test ids                                                                                                                                                                                                                                                                                 | Result                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **R-008-1** configurable model id, credentials, timeout per adapter (TTS 120 s)                                                                                          | `ElevenLabsTtsAdapter` takes `apiKey`/`voiceId`/`modelId`/`timeoutMs`; default timeout 120 000 ms per TECH_DESIGN §5.4, applied through `AbortSignal.timeout`                                                                                                                      | T "loads the documented defaults: 120 s timeout and 10 requests/minute (R-008-1/2)"; T "aborts at the configured timeout and marks that the call may have billed"                                                                                                                        | PASS                                                           |
| **R-008-2** per-provider-key rate limit, default 10 req/min, configurable                                                                                                | `TokenBucketRateLimiter` (in-process bucket, per adapter instance = per provider key); adapter acquires the bucket **before** the HTTP request; excess waits, never drops                                                                                                          | T "acquires the rate-limit bucket before issuing the request (R-008-2)"; T "allows a burst up to the per-minute capacity, then paces at the refill rate"; T "refuses a non-positive rate instead of silently disabling itself"                                                           | PASS                                                           |
| **R-008-3** TTS qualification: character-level alignment on a **≥60 s** sample with **≥99 % word coverage** and **monotonic** word timestamps, pass/fail + date recorded | `qualify()` derives word timings from the returned alignment, applies the thresholds, and writes a `provider_qualification` row (provider, adapter, passed, details, `run_at`) for pass **and** fail                                                                               | T "runs the R-008-3 thresholds on the fixture and records a pass"; T "records a failure when word coverage misses the 99% threshold"; T "records a failure for a sample shorter than 60 s…"; P 5 tests; Q "derives monotonic timings on the fixture and records a passing qualification" | PASS                                                           |
| R-008-3 "worker refuses a billable call when the adapter's latest record is not `passed`"                                                                                | `isAdapterQualified()` reads the newest row per (provider, adapter) and fails closed (no row ⇒ not qualified; a newer failure revokes an older pass)                                                                                                                               | P "is not qualified when the newest record failed, even if an older one passed"; P "is not qualified when no record exists at all (fail closed)"; P "scopes records per adapter…"; Q "records a failing qualification that the latest-record gate then refuses"                          | PASS                                                           |
| **US-011** TTS adapter isolation (`convert-with-timestamps`)                                                                                                             | `src/adapters/tts.ts`: `TtsAdapter` contract, `ElevenLabsTtsAdapter` (POST `/v1/text-to-speech/{voice_id}/with-timestamps`, `xi-api-key`, `model_id`, `audio_base64` + `alignment`), injected `fetch`                                                                              | T "posts convert-with-timestamps with the voice id, model id and xi-api-key"; T "decodes audio_base64 and returns the alignment, request id and derived duration"; T "rejects a response whose alignment is missing a required field"                                                    | PASS                                                           |
| US-011 deterministic fake for every test (no paid provider)                                                                                                              | `FakeTtsAdapter`: deterministic alignment at the measured pace, byte-identical WAV audio, deterministic request id, configurable failure series                                                                                                                                    | T 9 `FakeTtsAdapter` tests incl. "is deterministic…", "makes no network call at all", "replays a configured failure series…"                                                                                                                                                             | PASS                                                           |
| **US-012** qualification recorded and surfaced per provider                                                                                                              | `provider_qualification` write path (`src/db/repositories/provider-qualifications.ts`) + `PostgresQualificationStore`; details carry the measured numbers the S-21 screen shows (coverage, duration, sample label, failures)                                                       | Q both tests; P "inserts a row and round-trips the jsonb details"                                                                                                                                                                                                                        | PASS                                                           |
| **US-022** word-timing half: character→word grouping, ≥99 % coverage, monotonic                                                                                          | `src/domain/word-timing.ts`: `deriveWordTimings` (whitespace grouping, ms spans, punctuation kept with its word), `validateWordTimings` (99 % gate on character/word/script coverage + monotonicity), `alignmentDurationSeconds`, `countTextWords`                                 | W 14 tests incl. "groups characters into words…", "passes at exactly the 99% coverage threshold and fails one word below it", "flags a non-monotonic timestamp…", "reports script coverage when the provider alignment normalises words away"                                            | PASS                                                           |
| US-022 "a miss returns the video to script/voice review, never time-stretches"                                                                                           | The domain module never invents or stretches a timestamp: an untimed word is dropped from the caption list and counted against coverage; `validateWordTimings().failures` is the named reason the stage surfaces. Wiring the return-to-review transition is B-11 (its Signal line) | W "counts untimed characters against coverage and keeps their word out of the caption list"; W "flags a character whose end precedes its start…"                                                                                                                                         | PASS (transform); **B-11 owns the stage transition**           |
| **R-011-2** retry classification (adapter states the fact, B-08 retries)                                                                                                 | `classifyTtsHttpStatus` (408/429/5xx transient, other 4xx non-retryable) + `TtsProviderError.errorClass`/`retryable`; `TtsTimeoutError.mayHaveBilled` for R-012-4                                                                                                                  | T "treats 429, 408 and 5xx as transient (R-011-2)"; T "treats every other 4xx, including 401, as non-retryable"; T "classifies a 401 as non-retryable…"                                                                                                                                  | PASS (facts only; the 3-attempt loop is B-08)                  |
| **R-012-2** idempotency declaration                                                                                                                                      | `idempotencyProtected = false` on both adapters (ElevenLabs honours no client key, TECH_DESIGN §5.5)                                                                                                                                                                               | T "declares the provider idempotency contract (R-012-2): unprotected"; T "loads the documented defaults…"                                                                                                                                                                                | PASS                                                           |
| **R-012-1** no provider call without a committed `generation_run`                                                                                                        | `convert(req, run)` requires the run ref and refuses any stage other than `NA` (`AdapterStageMismatchError`); `asProviderAdapter()` is the bridge for B-02's `executePersisted()`                                                                                                  | T "refuses a generation_run of another stage (X-7: NA only)"; T "exposes the TECH_DESIGN §5.4 convert() as a ProviderAdapter for the attempt guard"                                                                                                                                      | PASS (adapter half; `executePersisted` itself is B-02's guard) |
| **R-015-5** secrets never in logs/exports                                                                                                                                | Error messages never contain the api key; provider error bodies are truncated to 200 chars and only the value-free key name is used in the constructor guard                                                                                                                       | T "never puts the api key in an error message (R-015-5)"                                                                                                                                                                                                                                 | PASS                                                           |
| TECH_DESIGN §5.7 Redis-mirrored bucket                                                                                                                                   | Not in this task: the in-process bucket is the adapter-side limiter; the Redis mirror belongs to B-08's queue topology                                                                                                                                                             | —                                                                                                                                                                                                                                                                                        | **Limitation (B-08)**                                          |

## 2. Signal evidence — real run

Executed on this host (Node v26.5.1, PostgreSQL 16.14 + pgcrypto/pgvector at
`127.0.0.1:55432`), a throwaway database provisioned through `tests/helpers/pg.ts`, migrations
M-001…M-005 applied, `FakeTtsAdapter.qualify({ store: PostgresQualificationStore })`:

```
sample_label          = d5-proper-nouns-75s
sample_words          = 265
sample_chars          = 1503
proper_nouns          = 11
duration_s            = 87.315
character_coverage    = 1
word_coverage         = 1
script_coverage       = 1
monotonic             = true
failures              = []
passed                = true
derived_words         = 265
first_word            = {"word":"At","start_ms":0,"end_ms":329}
last_word             = {"word":"ghost.","start_ms":86985,"end_ms":87315}
validation.ok         = true
out_of_order_words    = 0
recorded_row          = {"provider":"fake","adapter":"tts.fake","passed":true,"run_at":"2026-10-21T00:48:11.498Z"}
recorded_details      = {"failures":[],"monotonic":true,"duration_s":87.3146622734761,"min_sample_s":60,"sample_chars":1503,"sample_label":"d5-proper-nouns-75s","sample_words":265,"word_coverage":1,"script_coverage":1,"character_coverage":1}
--- regressed run ---
passed                = false
word_coverage         = 0.9849056603773585
failures              = ["word_coverage 0.9849 < 0.99 (R-008-3)","script_coverage 0.9849 < 0.99: 261 timed words for 265 script words (R-008-3)"]
recorded_passed       = false
gate_isAdapterQualified = false
```

Both halves of the Signal line are shown: monotonic timings derived on the qualification
fixture (265/265 words, 0 out-of-order words, 87.3 s ≥ 60 s), and the qualification **recorded**
in `provider_qualification` (`run_at` read back from the row) — including a regressed run that
the gate then refuses.

## 3. Commands actually run and their results

| Command                                                                                                                                                             | Result                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `npx vitest run src/domain/word-timing.test.ts src/adapters/tts.test.ts`                                                                                            | **45 passed** (14 + 31)                                                   |
| `TEST_DATABASE_URL=postgres://reels@127.0.0.1:55432/reels_test npx vitest run src/adapters/tts-qualify.test.ts src/db/repositories/provider-qualifications.test.ts` | **7 passed** (2 + 5)                                                      |
| `TEST_DATABASE_URL=… npm test` (whole tree)                                                                                                                         | **141 passed / 15 files** (0 failed)                                      |
| `npm test` (no database)                                                                                                                                            | **111 passed, 30 skipped** — the DB suites skip loudly with `SKIP_REASON` |
| `npm run lint`                                                                                                                                                      | PASS (eslint, whole tree)                                                 |
| `npm run typecheck`                                                                                                                                                 | PASS (tsc `--noEmit`, whole tree)                                         |
| `npm run build`                                                                                                                                                     | PASS (tsc `-p tsconfig.build.json`)                                       |
| `npm run format:check`                                                                                                                                              | PASS (prettier, whole tree)                                               |
| `git log --all -- .env`                                                                                                                                             | empty — no `.env` or credential in history                                |

RED-first was observed for every new module before implementation (the four test files failed to
resolve `./word-timing.js`, `./tts.js`, `./provider-qualifications.js`), then GREEN as above.

## 4. Files

| File                                             | Purpose                                                                                                                                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/adapters/tts.ts`                            | TTS adapter contract, ElevenLabs implementation (injected fetch, timeout, rate limiter), `FakeTtsAdapter`, `qualify()`, error classification, `ttsPromptHash`, `asProviderAdapter`, `buildSilentWav`, `fakeAlignmentFor` |
| `src/adapters/tts-qualification-sample.ts`       | The ≥60 s / ≥10-proper-noun D5 qualification fixture (265 words, 11 proper nouns)                                                                                                                                        |
| `src/domain/word-timing.ts`                      | character→word grouping, coverage + monotonicity validation, alignment duration                                                                                                                                          |
| `src/db/repositories/provider-qualifications.ts` | `provider_qualification` insert/latest/gate + `PostgresQualificationStore`                                                                                                                                               |
| tests                                            | `src/domain/word-timing.test.ts`, `src/adapters/tts.test.ts`, `src/adapters/tts-qualify.test.ts`, `src/db/repositories/provider-qualifications.test.ts`, `tests/helpers/alignment.ts`                                    |

## 5. Limitations (stated, not hidden)

1. **No live ElevenLabs call was made.** R-008-3 names a paid qualification run; this repository
   forbids tests from reaching a paid provider and this host has no provider key. The real adapter
   is verified against a fake transport (exact URL/headers/body, base64 decode, alignment parsing,
   timeout abort, error classification), and the _recorded_ qualification in §2 was produced by the
   deterministic fake. The operator's first live `qualify()` is the remaining step that only a real
   key can close; the row it writes is the same code path.
2. **`duration_s` is derived from the alignment** (last character end time), not from ffprobe on the
   audio. The worker (B-11) may refine it with ffprobe on the stored asset.
3. **The Redis-mirrored rate-limit bucket (TECH_DESIGN §5.7) is B-08's.** This adapter's bucket is
   in-process per provider key.
4. **The 3-attempt backoff loop is B-08's.** This task classifies (`errorClass`, `retryable`,
   `mayHaveBilled`) and the fake exposes a failure series for B-08's tests.
5. **Stage wiring is B-11's.** Nothing here writes `video_stage`, flips `TC`, or performs the
   R-009-4 return-to-review transition; the domain module only produces the named validation
   failures that transition consumes.
6. **Node version on this host is v26.5.1**, while `engines`/`.nvmrc` pin Node 20. All tests, lint,
   typecheck and build ran green under v26.5.1; no Node-20-specific verification was possible here.
7. **Shared-foundation overlap with B-06 (in flight).** B-06 has uncommitted
   `src/adapters/{errors,rate-limit,qualification}.ts` covering the same three concerns my
   `tts.ts` carries in-file. No filename collides, but the concepts do; see the hotspot comment on
   the card and §6 for the recommended mapping. Not silently resolved.
8. **`PROVIDER_TIMEOUT_TTS_S` default is 60 in `src/config/env.ts`** (committed by B-01) while
   R-008-1 / TECH_DESIGN §5.4 specify 120 s for TTS. The adapter's own default is 120 000 ms; the
   env default is flagged, not changed here (adjacent file, not this task's scope).
9. **Qualification runs are exempt from the attempt-row rule** (R-012-1 vs §5.6): a qualification
   happens before a project exists, so there is no `project_id` to key a `generation_run` row on.
   The exemption is explicit in `tts.ts` (a committed run, when supplied, goes through the
   stage-checked `convert()`), and the row that _is_ written is `provider_qualification`. Raised
   as a comment on the card for a ruling.

## 6. Follow-ups for integration (not done in this diff)

1. **B-06 shared adapter foundation** — preferred resolution: keep B-06's
   `src/adapters/{errors,rate-limit,qualification}.ts` as the single foundation and re-point TTS:
   `TtsProviderError` → `ProviderRequestError` (`errorClass` → `failureClass`,
   `mayHaveBilled` → `billedUnknown`), `TokenBucketRateLimiter` → shared (`acquire(signal)`),
   `TtsQualificationStore`/`PostgresQualificationStore` → `QualificationStore`/`PgQualificationStore`.
   Alternatively keep the DB access in `src/db/repositories/` and let
   `src/adapters/qualification.ts` delegate to it. The word-timing module, fixture, fake and all
   tests are unaffected either way.
2. `src/config/env.ts`: `PROVIDER_TIMEOUT_TTS_S` default should be `120` (R-008-1).
3. B-08: consume `asProviderAdapter()` + `classifyTtsHttpStatus`/`TtsProviderError.errorClass`
   rather than re-deriving classification, and add the Redis mirror for the bucket.
4. B-11: call `isAdapterQualified(pool, 'elevenlabs', 'tts.elevenlabs.convert-with-timestamps')`
   before the NA call, and use `ttsPromptHash(request)` as `generation_run.prompt_hash`.
