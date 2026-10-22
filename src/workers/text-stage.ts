/**
 * Text stage runner — T (topic), SC (script), SB (storyboard).
 *
 * This is the content half of the orchestration spine: each stage builds a
 * `TextRequest` from persisted context, runs it through `runProviderAttempt`
 * (so the committed `job_attempt`/`generation_run` rows precede the call,
 * R-012-1), persists the result, and closes the stage through the state machine.
 *
 * Milestone A scope, stated plainly so it cannot be mistaken for the product
 * path:
 *   - the *reference gate* (R-003-1..4) is **not** exercised: a creative series
 *     with no `reference` rows drafts from the series niche alone, and no
 *     8-gram scan runs (`script_revision.eight_gram_scan_pass` stays null);
 *   - the *operator approval gates* are **not** exercised: for the automatic
 *     fake run the topic and script are written `approved` (topic.status /
 *     script_revision.status) so the downstream stages can run unattended.
 *   Both are product gates owned by other cards (B-02/B-03); this card only
 *   proves the orchestration spine from topic to a rendered MP4.
 */
import { createHash } from 'node:crypto';

import type { Pool } from 'pg';

import {
  checkWordBudget,
  planStoryboard,
  sceneCountBand,
  spokenNarration,
  targetSceneCount,
  type ScriptDocument,
  type StoryboardDocument,
} from '../domain/authoring.js';
import { TEXT_SCHEMAS, type TextSchema, type TextStageCode } from '../adapters/text-schemas.js';
import type { ChatMessage, TextAdapter, TextRequest } from '../adapters/text.js';
import { withTransaction } from '../db/client.js';
import { insertAsset, linkAssetToProject } from '../db/repositories/assets.js';
import {
  applyStageEvent,
  beginStage,
  setProjectCurrentStage,
} from '../db/repositories/stage-state.js';
import {
  assetObjectKey,
  SCRIPT_OBJECT_NAME,
  STORYBOARD_OBJECT_NAME,
} from '../storage/object-key.js';
import { jsonBytes, sha256Hex, type AssetBlobStore } from './asset-store.js';
import { runProviderAttempt, type AttemptOutcome } from './attempt.js';

/** The sidecar document that carries the storyboard's word ranges to TC. */
export const STORYBOARD_PLAN_SCHEMA_VERSION = 'storyboard-plan.v1';

export interface StoryboardPlanSceneRef {
  readonly scene_no: string;
  readonly position: number;
  readonly start_word: number;
  readonly end_word: number;
}

export interface StoryboardPlanDocument {
  readonly schema_version: typeof STORYBOARD_PLAN_SCHEMA_VERSION;
  readonly project_id: string;
  readonly target_duration_s: number;
  readonly scenes: readonly StoryboardPlanSceneRef[];
}

export interface TextStageDeps {
  readonly pool: Pool;
  readonly text: TextAdapter;
  /** Content-addressed store for the SB plan sidecar (SB only). */
  readonly blobs: AssetBlobStore;
}

export interface TextStageJob {
  readonly jobId: string;
  readonly projectId: string;
  readonly attemptNo: number;
  readonly workerId?: string | null;
}

export type TextStageResult =
  | {
      readonly status: 'succeeded';
      readonly stage: TextStageCode;
      readonly attempt: AttemptOutcome;
    }
  | { readonly status: 'failed'; readonly stage: TextStageCode; readonly attempt: AttemptOutcome };

interface SeriesContext {
  readonly seriesId: string;
  readonly seriesVersionId: string;
  readonly seriesSlug: string;
  readonly batchOrdinal: number;
  readonly niche: unknown;
  readonly mode: string;
  readonly targetDurationS: number;
}

async function loadSeriesContext(pool: Pool, projectId: string): Promise<SeriesContext> {
  const result = await pool.query<{
    series_id: string;
    niche: unknown;
    mode: string;
    series_version_id: string;
    snapshot: unknown;
    slug: string;
    ordinal: number;
  }>(
    `SELECT p.series_id, s.niche, s.mode, v.id AS series_version_id, v.snapshot, s.slug, b.ordinal
       FROM project p
       JOIN series s ON s.id = p.series_id
       JOIN series_version v ON v.id = s.current_version_id
       JOIN batch b ON b.id = p.batch_id
      WHERE p.id = $1`,
    [projectId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`project ${projectId} does not exist`);
  const snapshot = row.snapshot as { target_duration_s?: unknown };
  return {
    seriesId: row.series_id,
    seriesVersionId: row.series_version_id,
    seriesSlug: row.slug,
    batchOrdinal: Number(row.ordinal),
    niche: row.niche,
    mode: row.mode,
    targetDurationS:
      typeof snapshot.target_duration_s === 'number' ? snapshot.target_duration_s : 75,
  };
}

function promptHash(messages: unknown): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex');
}

/**
 * The system prompt carries the JSON Schema itself.
 *
 * It used to say "matching the schema" and then never send one: with
 * `response_format: json_object` the provider is only told to reply with *some*
 * JSON, so DeepSeek invented its own keys and every real run failed validation at
 * the first stage. The fakes hid it, because FakeTextAdapter ignores the prompt and
 * returns a fixture that already parses.
 */
export function systemPrompt(schema: TextSchema<unknown>): string {
  return (
    'You are a video-production assistant. Reply with exactly one JSON object that ' +
    `validates against ${schema.version}. No prose, no markdown fences, no commentary.\n` +
    `JSON Schema: ${JSON.stringify(schema.jsonSchema)}`
  );
}

/**
 * Tolerate the two shapes providers actually return: a fenced code block, and a
 * one-key envelope like `{"topic": {…}}`. Both are unambiguous, so unwrapping them
 * is safer than failing the stage and paying for the same call again.
 */
export function normalizeDocument(value: unknown): unknown {
  if (typeof value === 'string') {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(value);
    const text = fenced?.[1] ?? value;
    try {
      return JSON.parse(text.trim());
    } catch {
      return value;
    }
  }
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value);
    if (keys.length === 1) {
      const inner = (value as Record<string, unknown>)[keys[0]!];
      // Not an array: `{scenes: […]}` is the storyboard document itself, and
      // descending into it handed the validator an array where an object belongs.
      if (typeof inner === 'object' && inner !== null && !Array.isArray(inner)) return inner;
    }
  }
  return value;
}

function requestFor<Out>(
  stage: TextStageCode,
  schema: TextSchema<Out>,
  user: unknown,
): TextRequest<unknown> {
  return {
    stage,
    schema: schema as unknown as TextSchema<unknown>,
    messages: [
      { role: 'system' as const, content: systemPrompt(schema as unknown as TextSchema<unknown>) },
      { role: 'user' as const, content: JSON.stringify(user) },
    ],
  };
}

/** The T request: derive a topic from the series niche. */
function buildTopicRequest(context: SeriesContext): TextRequest<unknown> {
  return requestFor('T', TEXT_SCHEMAS.topic, {
    instruction: 'Propose one short-form video topic for this series.',
    niche: context.niche,
    mode: context.mode,
  });
}

/** The SC request: draft the script from the approved topic. */
async function buildScriptRequest(
  pool: Pool,
  projectId: string,
  context: SeriesContext,
): Promise<TextRequest<unknown>> {
  const topic = await pool.query<{ title: string | null; description: string | null }>(
    `SELECT title, description FROM topic WHERE project_id = $1`,
    [projectId],
  );
  const row = topic.rows[0];
  return requestFor('SC', TEXT_SCHEMAS.script, {
    instruction: 'Draft a hook, narration, ending, title, description and hashtags for this topic.',
    topic: row ?? { title: null, description: null },
    niche: context.niche,
  });
}

/** The SB request: split the approved narration into scenes. */
async function buildStoryboardRequest(
  pool: Pool,
  projectId: string,
  context: SeriesContext,
): Promise<TextRequest<unknown>> {
  const script = await loadApprovedScript(pool, projectId);
  // The count is a hard rule (R-009-2) we enforce after the fact, so it has to be
  // stated up front. Without it the model guessed ~6.5 s per scene and returned 11
  // for a 75 s target, and all three blind retries returned 11 again.
  const target = targetSceneCount(context.targetDurationS);
  const band = sceneCountBand(context.targetDurationS);
  return requestFor('SB', TEXT_SCHEMAS.storyboard, {
    instruction:
      `Split the approved narration into exactly ${target} sequential scenes (S01…), ` +
      `and never fewer than ${band.min} or more than ${band.max}. Each scene reconstructs ` +
      'its part of the narration verbatim, with an image prompt, camera move, caption ' +
      'emphasis and fallback text. If a character appears, write ONE canonical ' +
      'description of them (age, hair, face, glasses, clothing) and begin every image ' +
      'prompt that features them with that description word for word — image prompts ' +
      'are generated independently, so an unstated character becomes a new person.',
    narration: spokenNarration(script),
    target_duration_s: context.targetDurationS,
    scene_count: { target, min: band.min, max: band.max },
  });
}

async function loadApprovedScript(pool: Pool, projectId: string): Promise<ScriptDocument> {
  const result = await pool.query<{ content: unknown }>(
    `SELECT content FROM script_revision
      WHERE project_id = $1 AND status = 'approved'
      ORDER BY revision DESC
      LIMIT 1`,
    [projectId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`project ${projectId} has no approved script; the SC stage must run first`);
  }
  return row.content as ScriptDocument;
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence (onResult hooks — run inside the attempt, before the run closes)
// ─────────────────────────────────────────────────────────────────────────────

function normalisedText(title: string | null, description: string | null): string {
  return [title ?? '', description ?? ''].join(' ').toLowerCase().replace(/\s+/g, ' ').trim();
}

async function persistTopic(
  pool: Pool,
  projectId: string,
  content: { title: string; description: string; rationale: string | null },
): Promise<void> {
  await pool.query(
    `INSERT INTO topic
       (project_id, title, description, normalized_text, rationale, dedupe_status, status, revision)
     VALUES ($1, $2, $3, $4, $5, 'none', 'approved', 1)
     ON CONFLICT (project_id) DO NOTHING`,
    [
      projectId,
      content.title,
      content.description,
      normalisedText(content.title, content.description),
      content.rationale,
    ],
  );
}

async function persistScript(
  deps: TextStageDeps,
  job: TextStageJob,
  context: SeriesContext,
  content: ScriptDocument,
  ref: { runId: string },
): Promise<void> {
  const wordCount = spokenNarration(content)
    .split(/\s+/)
    .filter((word) => word.length > 0).length;
  await deps.pool.query(
    `INSERT INTO script_revision
       (project_id, revision, content, schema_version, word_count, status, approved_at)
     VALUES ($1, 1, $2::jsonb, $3, $4, 'approved', now())
     ON CONFLICT (project_id, revision) DO NOTHING`,
    [job.projectId, JSON.stringify(content), TEXT_SCHEMAS.script.version, wordCount],
  );

  // The script is also written as a browsable `script.json` sidecar (D-F), so
  // the operator can read the draft straight from the bucket.
  const bytes = jsonBytes(content);
  const sha = sha256Hex(bytes);
  const key = assetObjectKey({
    seriesSlug: context.seriesSlug,
    batchOrdinal: context.batchOrdinal,
    name: SCRIPT_OBJECT_NAME,
  });
  await deps.blobs.put(key, bytes, 'application/json');

  await withTransaction(deps.pool, async (client) => {
    const inserted = await insertAsset(client, {
      projectId: job.projectId,
      stage: 'NA', // borrowed asset stage: there is no SC asset column (frozen schema)
      kind: 'sidecar',
      contentSha256: sha,
      objectKey: key,
      objectSizeBytes: bytes.byteLength,
      mimeType: 'application/json',
      seriesVersionId: context.seriesVersionId,
      provider: deps.text.provider,
      model: deps.text.model,
      rightsMetadata: { stage: 'SC', role: 'script' },
      generationRunId: ref.runId,
    });
    await linkAssetToProject(client, {
      assetId: inserted.row.id,
      projectId: job.projectId,
      role: 'script',
    });
  });
}

async function persistStoryboard(
  deps: TextStageDeps,
  job: TextStageJob,
  context: SeriesContext,
  content: StoryboardDocument,
  ref: { runId: string },
): Promise<void> {
  const script = await loadApprovedScript(deps.pool, job.projectId);
  const plan = planStoryboard({
    approved_narration: spokenNarration(script),
    document: content,
    target_duration_s: context.targetDurationS,
  });

  const document: StoryboardPlanDocument = {
    schema_version: STORYBOARD_PLAN_SCHEMA_VERSION,
    project_id: job.projectId,
    target_duration_s: context.targetDurationS,
    scenes: plan.scenes.map((scene) => ({
      scene_no: scene.scene_no,
      position: scene.position,
      start_word: scene.start_word,
      end_word: scene.end_word,
    })),
  };

  await withTransaction(deps.pool, async (client) => {
    for (const scene of plan.scenes) {
      await client.query(
        `INSERT INTO scene
           (project_id, scene_no, position, image_prompt, camera_move, caption_emphasis, fallback_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (project_id, scene_no) DO NOTHING`,
        [
          job.projectId,
          scene.scene_no,
          // The planner counts scenes from 0 (sceneNo() adds one to build S01),
          // while `scene.position` is 1-based by schema: scene_position_check
          // requires >= 1 and the checkpoint filter picks positions 1..3. Map at
          // the boundary so neither convention has to be guessed.
          sceneRowPosition(scene.position),
          scene.image_prompt,
          scene.camera_move,
          scene.caption_emphasis,
          scene.fallback_text,
        ],
      );
    }
  });

  const bytes = jsonBytes(document);
  const sha = sha256Hex(bytes);
  const key = assetObjectKey({
    seriesSlug: context.seriesSlug,
    batchOrdinal: context.batchOrdinal,
    name: STORYBOARD_OBJECT_NAME,
  });
  await deps.blobs.put(key, bytes, 'application/json');

  await withTransaction(deps.pool, async (client) => {
    const inserted = await insertAsset(client, {
      projectId: job.projectId,
      stage: 'NA', // borrowed asset stage: there is no SB asset column (frozen schema)
      kind: 'sidecar',
      contentSha256: sha,
      objectKey: key,
      objectSizeBytes: bytes.byteLength,
      mimeType: 'application/json',
      seriesVersionId: context.seriesVersionId,
      provider: deps.text.provider,
      model: deps.text.model,
      rightsMetadata: { stage: 'SB', role: 'storyboard-plan' },
      generationRunId: ref.runId,
    });
    await linkAssetToProject(client, {
      assetId: inserted.row.id,
      projectId: job.projectId,
      role: 'storyboard_plan',
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run one text stage end to end. On success the stage is `done`, the project's
 * `current_stage` points at the next stage, and the caller (the worker loop)
 * mints the next job. A retryable failure leaves the stage `running`; a
 * terminal failure leaves it `failed`.
 */
/** Domain scene positions are 0-based; stored positions are 1-based. */
export function sceneRowPosition(planPosition: number): number {
  return planPosition + 1;
}

/**
 * `runProviderAttempt` returns whatever the adapter produced. The text adapter
 * wraps the parsed document in a `TextResult` envelope, so the document itself is
 * under `content`. Anything else is a malformed result and must fail loudly —
 * an undefined document silently persisted as empty text is worse than a throw.
 */
export function unwrapTextDocument(result: unknown): unknown {
  if (typeof result !== 'object' || result === null || !('content' in result)) {
    throw new Error('text adapter returned no content envelope');
  }
  return (result as { content: unknown }).content;
}

/**
 * Retries used to re-send the identical prompt. When the failure is deterministic —
 * a scene count outside the band, a missing field — that buys three identical
 * rejections and three bills. The previous attempt's message is now carried into the
 * next request, so attempt 2 is a repair rather than a repeat.
 */
export function withRepairFeedback(
  messages: readonly ChatMessage[],
  failure: string,
): ChatMessage[] {
  return [
    ...messages,
    {
      role: 'user',
      content:
        `Your previous reply for this stage was rejected: ${failure}\n` +
        'Reply again with a corrected JSON object that validates against the schema, ' +
        'changing whatever caused the rejection.',
    },
  ];
}

/** The most recent rejection for this job, if any. Redacted text only. */
async function loadPreviousFailure(pool: Pool, jobId: string): Promise<string | null> {
  const result = await pool.query<{ error_message: string | null }>(
    `SELECT error_message FROM job_attempt
      WHERE job_id = $1 AND status = 'failed'
      ORDER BY attempt_no DESC
      LIMIT 1`,
    [jobId],
  );
  const message = result.rows[0]?.error_message ?? null;
  return message === null || message.trim() === '' ? null : message;
}

export async function runTextStage(
  deps: TextStageDeps,
  stage: TextStageCode,
  job: TextStageJob,
): Promise<TextStageResult> {
  const context = await loadSeriesContext(deps.pool, job.projectId);
  const request =
    stage === 'T'
      ? buildTopicRequest(context)
      : stage === 'SC'
        ? await buildScriptRequest(deps.pool, job.projectId, context)
        : await buildStoryboardRequest(deps.pool, job.projectId, context);
  // Repair feedback is part of what we send, so it is part of the provenance hash.
  const repair = job.attemptNo > 1 ? await loadPreviousFailure(deps.pool, job.jobId) : null;
  const messages =
    repair === null ? request.messages : withRepairFeedback(request.messages, repair);
  const attemptRequest: TextRequest<unknown> = { ...request, messages };
  const hash = promptHash(messages);
  const next = stage === 'T' ? 'RS' : stage === 'SC' ? 'SB' : 'IM';

  await beginStage(deps.pool, job.projectId, stage, {
    seriesVersionId: context.seriesVersionId,
  });

  const outcome = await runProviderAttempt(
    {
      pool: deps.pool,
      adapter: deps.text.forRequest(attemptRequest),
      onResult: async (result, ref) => {
        // runProviderAttempt hands back the adapter's envelope (TextResult), not
        // the document. Casting the envelope to ScriptDocument left `hook`,
        // `narration` and `ending` undefined: SC then threw on `undefined.trim()`,
        // and T wrote an empty title because normalisedText tolerates undefined.
        const document = normalizeDocument(unwrapTextDocument(result));

        if (stage === 'T') {
          await persistTopic(deps.pool, job.projectId, TEXT_SCHEMAS.topic.schema.parse(document));
        } else if (stage === 'SC') {
          const script = TEXT_SCHEMAS.script.schema.parse(document);
          // The word budget is a hard rule (R-009-1/R-009-3) and the prompt only
          // offers it as guidance: a 136-word script for a 75 s target reached NA,
          // produced 62 s of speech, and was rejected by TC as duration_out_of_band
          // — three stages and a TTS bill later. Refuse it here, where the repair
          // retry can still fix it.
          const budget = checkWordBudget(spokenNarration(script), context.targetDurationS);
          if (!budget.within_band) {
            throw new Error(
              `narration is ${budget.word_count} words (~${budget.estimated_runtime_s.toFixed(1)} s) ` +
                `but a ${context.targetDurationS} s target needs ${budget.budget.min_words}–` +
                `${budget.budget.max_words} words, ideally ${budget.budget.target_words} (R-009-1). ` +
                'Rewrite the narration to that length; keep the hook, the scenes and the ending.',
            );
          }
          await persistScript(deps, job, context, script, ref);
        } else {
          await persistStoryboard(
            deps,
            job,
            context,
            TEXT_SCHEMAS.storyboard.schema.parse(document),
            ref,
          );
        }
      },
    },
    {
      jobId: job.jobId,
      attemptNo: job.attemptNo,
      projectId: job.projectId,
      stage,
      provider: deps.text.provider,
      model: deps.text.model,
      promptHash: hash,
      schemaVersion: request.schema.version,
      seriesVersionId: context.seriesVersionId,
      workerId: job.workerId ?? null,
    },
  );

  if (outcome.status === 'succeeded') {
    await applyStageEvent(deps.pool, job.projectId, stage, 'succeed');
    await setProjectCurrentStage(deps.pool, job.projectId, next as never);
    return { status: 'succeeded', stage, attempt: outcome };
  }

  if (!outcome.retry.requeue) {
    await applyStageEvent(deps.pool, job.projectId, stage, 'fail');
  }
  return { status: 'failed', stage, attempt: outcome };
}
