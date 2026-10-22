/**
 * Duration repair: trim the words, never the speed (R-009-4).
 *
 * The word budget is derived from a constant — 3.035 words/second — measured once
 * from a fixture. Real narration runs slower whenever the prose is choppy: short
 * sentences and em-dashes buy a silence at every break. Batch-0016's 232 words
 * came back as 94.64 s (2.45 w/s) against a 75 s target: +27.5 %, outside the band,
 * with seventeen images already paid for.
 *
 * Throwing the take away would waste those images and regenerate a *different*
 * script. What the operator actually wants is the same video, shorter. So:
 *
 *   1. measure the rate this take achieved (words ÷ actual audio seconds);
 *   2. derive the word count that would have hit the target at that rate;
 *   3. ask the model to cut the script to that count, keeping its structure;
 *   4. re-split the trimmed narration into the same number of scenes, in the same
 *      order, carrying the original image prompts across untouched — the images
 *      stay valid because the prompts never move;
 *   5. write a new script revision and a new storyboard plan, then re-run voice
 *      and timing.
 *
 * Trimming is a creative act, so it is bounded: the result must land within 5 % of
 * the derived count, keep the scene count, and keep every field of the script
 * document. A trim that fails those checks writes nothing and the take returns to
 * review as before — the failure stays visible instead of becoming a silently
 * worse video.
 */
import type { Pool } from 'pg';

import { TEXT_SCHEMAS } from '../adapters/text-schemas.js';
import type { ChatMessage, TextAdapter } from '../adapters/text.js';
import { insertAsset, linkAssetToProject } from '../db/repositories/assets.js';
import { withTransaction } from '../db/client.js';
import { openRunInAttempt } from '../domain/generation-run.js';
import { sha256Hex, type AssetBlobStore } from '../workers/asset-store.js';
import { spokenNarration, type ScriptDocument } from '../domain/authoring.js';
import { NARRATION_WORDS_PER_SECOND } from '../shared/calibration.js';

/** How far the trimmed script may sit from the derived count. */
export const TRIM_TOLERANCE_RATIO = 0.05;

/** A scene needs enough words to be a shot; fewer than this and the trim failed. */
export const MIN_SCENE_WORDS = 6;

/** Trims to query inside one TC attempt before falling back to a hard cut. */
export const MAX_TRIM_QUERIES = 4;

export function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0).length;
}

/**
 * Hard backstop: shorten the narration until the spoken text fits, without leaving
 * any scene too thin to caption.
 *
 * Dropping whole sentences looked simpler and produced a one-word scene: with
 * seventeen scenes, the splitter lands cuts between sentences and hands one scene
 * a fragment. So the cut works *inside* sentences — trailing clauses first, then
 * trailing words — and every sentence keeps at least MIN_SCENE_WORDS, the floor a
 * scene needs. The hook and the ending are never touched: they are the video's
 * opening and its turn.
 */
export function trimSentencesToFit(document: ScriptDocument, maxWords: number): ScriptDocument {
  const sentences = (document.narration.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [])
    .map((text) => text.trim())
    .filter((text) => text.length > 0);
  const spoken = (parts: readonly string[]): number =>
    countWords([document.hook, parts.join(' ').trim(), document.ending].join(' '));

  const current = [...sentences];
  for (let guard = 0; guard < 500 && current.length > 0 && spoken(current) > maxWords; guard += 1) {
    let longest = 0;
    for (let index = 1; index < current.length; index += 1) {
      if (countWords(current[index]!) > countWords(current[longest]!)) longest = index;
    }
    const sentence = current[longest]!;
    const words = sentence.split(/\s+/).filter((word) => word.length > 0);
    if (words.length <= MIN_SCENE_WORDS) break;
    const clauses = sentence.split(/(?<=,)\s+|\s+—\s+/).filter((clause) => clause.length > 0);
    if (clauses.length > 1) {
      const withoutLast = clauses.slice(0, -1).join(' ').trim();
      if (countWords(withoutLast) >= MIN_SCENE_WORDS) {
        current[longest] = withoutLast;
        continue;
      }
    }
    current[longest] = words.slice(0, Math.max(MIN_SCENE_WORDS, words.length - 1)).join(' ');
  }

  // A stub sentence ("Yes.") becomes a one-word *scene* once the splitter lands a
  // cut beside it. Merge those into a neighbour: same words, one fewer place for a
  // scene to collapse into.
  for (let index = 0; index < current.length; index += 1) {
    if (current.length === 1) break;
    if (countWords(current[index]!) >= MIN_SCENE_WORDS) continue;
    const into = index > 0 ? index - 1 : 1;
    current[into] = `${current[into]!} ${current[index]!}`.trim();
    current.splice(index, 1);
    index -= 1;
  }

  return { ...document, narration: current.join(' ').trim() };
}

export interface RepairScene {
  readonly scene_no: string;
  readonly position: number;
  readonly image_prompt: string;
  readonly camera_move: string;
  readonly caption_emphasis: string | null;
  readonly fallback_text: string | null;
}

export interface StoryboardPlanRead {
  readonly object_key: string;
  readonly document: Record<string, unknown> & {
    scenes?: readonly (Record<string, unknown> & { scene_no?: unknown })[];
  };
}

export interface DurationRepairInput {
  readonly projectId: string;
  /** The TC attempt that measured the overshoot; the trim runs inside it. */
  readonly jobAttemptId: string;
  /** Narration seconds the take actually produced. */
  readonly measuredAudioS: number;
  /** Seconds the narration may occupy (target minus lead/trail). */
  readonly targetAudioS: number;
  readonly targetDurationS: number;
  readonly wordCount: number;
}

export type DurationRepairOutcome =
  | {
      readonly applied: true;
      readonly target_words: number;
      readonly word_count: number;
      readonly revision: number;
      readonly detail: string;
    }
  | { readonly applied: false; readonly reason: string };

/**
 * The count that would have hit the target at the rate this take achieved.
 *
 * Derived from measurement, not from the calibration constant: that is the whole
 * point. Bounded below so a pathological rate cannot ask for an unsplittable
 * script.
 */
export function deriveTargetWords(input: {
  readonly wordCount: number;
  readonly measuredAudioS: number;
  readonly targetAudioS: number;
}): number {
  if (!Number.isFinite(input.measuredAudioS) || input.measuredAudioS <= 0) {
    throw new RangeError('measured audio duration must be positive to derive a word count');
  }
  if (!Number.isFinite(input.targetAudioS) || input.targetAudioS <= 0) {
    throw new RangeError('target audio duration must be positive to derive a word count');
  }
  const wordsPerSecond = input.wordCount / input.measuredAudioS;
  return Math.max(1, Math.floor(wordsPerSecond * input.targetAudioS));
}

/** The message that asks for a shorter script, with the document in front of it. */
export function buildTrimMessages(input: {
  readonly document: ScriptDocument;
  readonly currentWords: number;
  readonly targetWords: number;
  /** Scenes the trim must still fill; the per-scene count makes the target countable. */
  readonly sceneCount: number;
}): readonly ChatMessage[] {
  const perScene = Math.max(1, Math.round(input.targetWords / Math.max(1, input.sceneCount)));
  const cut = Math.max(0, input.currentWords - input.targetWords);
  return [
    {
      role: 'system',
      content:
        'You tighten finished short-form narration so it fits its runtime. You never ' +
        'add claims, never change the voice or the point of view, and never reorder ' +
        'the argument. You return the complete script as JSON with the same fields.',
    },
    {
      role: 'user',
      content:
        `This narration is ${input.currentWords} words and speaks for longer than the ` +
        `runtime allows. Cut ${cut} words so the spoken total is ${input.targetWords} ` +
        `words — that is ${input.sceneCount} scenes of about ${perScene} words each, ` +
        'which is how you should check your work: count the words in every scene of ' +
        'your answer before returning it. Remove clauses, asides and repeated beats ' +
        'rather than whole ideas. Keep the hook, the turn, and the ending intact.\n\n' +
        `The script as it stands:\n${JSON.stringify(input.document)}\n\n` +
        'Return the full JSON document, same fields, same title, same hashtags.',
    },
  ];
}

/**
 * Read the current storyboard plan. The plan carries each scene's narration and
 * its image prompt, which is what lets a trim preserve the images.
 */
export async function readStoryboardPlan(
  pool: Pool,
  blobs: AssetBlobStore,
  projectId: string,
): Promise<StoryboardPlanRead> {
  const result = await pool.query<{ object_key: string }>(
    `SELECT object_key FROM asset
      WHERE project_id = $1 AND stage = 'NA' AND kind = 'sidecar'
        AND rights_metadata->>'stage' = 'SB'
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [projectId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`project ${projectId} has no storyboard plan to repair against`);
  }
  const bytes = await blobs.get(row.object_key);
  const document = JSON.parse(new TextDecoder().decode(bytes)) as StoryboardPlanRead['document'];
  if (!Array.isArray(document.scenes) || document.scenes.length === 0) {
    throw new Error(`project ${projectId} storyboard plan has no scenes`);
  }
  return { object_key: row.object_key, document };
}

/** The parts of a plan scene a trim must carry across unchanged. */
export function sceneCarryovers(document: StoryboardPlanRead['document']): readonly RepairScene[] {
  return (document.scenes ?? []).map((scene, index) => {
    const position = Number(scene.position);
    return {
      scene_no: String(scene.scene_no),
      position: Number.isInteger(position) ? position : index,
      image_prompt: typeof scene.image_prompt === 'string' ? scene.image_prompt : '',
      camera_move: typeof scene.camera_move === 'string' ? scene.camera_move : '',
      caption_emphasis: typeof scene.caption_emphasis === 'string' ? scene.caption_emphasis : null,
      fallback_text: typeof scene.fallback_text === 'string' ? scene.fallback_text : null,
    };
  });
}

export interface RebuiltPlan {
  readonly document: Record<string, unknown>;
  readonly word_count: number;
}

/**
 * Re-split the trimmed narration into the same scenes, carrying each scene's
 * prompt and camera move by position. A changed scene count is a failed repair,
 * because it would silently invalidate the images already generated.
 */
export function rebuildPlan(input: {
  readonly plan: StoryboardPlanRead['document'];
  readonly carryovers: readonly RepairScene[];
  readonly document: ScriptDocument;
  readonly targetDurationS: number;
}): RebuiltPlan {
  // Balanced by words, not by sentence ends. A sentence-boundary split needs at
  // least as many sentences as scenes and hands a fragment to whichever scene sits
  // beside a short one — the one-word scene that blocked the first live repair.
  // Reels cut captions mid-sentence all the time; equal shots are the better fit.
  const words = spokenNarration(input.document)
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const count = input.carryovers.length;
  if (words.length < count * MIN_SCENE_WORDS) {
    throw new Error(
      `a ${words.length}-word narration cannot fill ${count} scenes of at least ${MIN_SCENE_WORDS} words`,
    );
  }
  const scenes = input.carryovers.map((carry, index) => {
    const start = Math.round((index * words.length) / count);
    const end = Math.round(((index + 1) * words.length) / count);
    const narration = words.slice(start, end).join(' ');
    return {
      scene_no: carry.scene_no,
      position: carry.position,
      narration,
      word_count: end - start,
      start_word: start,
      end_word: end,
      estimated_duration_s: Number(((end - start) / NARRATION_WORDS_PER_SECOND).toFixed(3)),
      image_prompt: carry.image_prompt,
      camera_move: carry.camera_move,
      caption_emphasis: carry.caption_emphasis,
      fallback_text: carry.fallback_text,
    };
  });
  return {
    document: {
      ...input.plan,
      target_duration_s: input.targetDurationS,
      scenes,
    },
    word_count: scenes.reduce((total, scene) => total + scene.word_count, 0),
  };
}

/**
 * Trim the take's script to fit, preserving scene prompts, then persist a new
 * script revision and a new storyboard plan.
 *
 * Writes nothing unless the trimmed script validates: a repair that only half
 * applies would leave the voice speaking one script and the captions timing another.
 */
export async function repairOvershoot(
  deps: { readonly pool: Pool; readonly blobs: AssetBlobStore; readonly text: TextAdapter },
  input: DurationRepairInput,
): Promise<DurationRepairOutcome> {
  const plan = await readStoryboardPlan(deps.pool, deps.blobs, input.projectId);
  const carryovers = sceneCarryovers(plan.document);

  const scriptRow = await deps.pool.query<{
    revision: number;
    content: ScriptDocument;
  }>(
    `SELECT revision, content FROM script_revision
      WHERE project_id = $1 ORDER BY revision DESC LIMIT 1`,
    [input.projectId],
  );
  const current = scriptRow.rows[0];
  if (current === undefined) {
    return { applied: false, reason: 'no script revision to trim' };
  }

  const targetWords = deriveTargetWords(input);
  if (targetWords < carryovers.length * MIN_SCENE_WORDS) {
    return {
      applied: false,
      reason:
        `a ${targetWords}-word script cannot fill ${carryovers.length} scenes of at least ` +
        `${MIN_SCENE_WORDS} words; the target duration is too short for this scene count`,
    };
  }

  const tolerance = Math.round(targetWords * TRIM_TOLERANCE_RATIO);
  const maxWords = targetWords + tolerance;
  const sceneCount = carryovers.length;

  // The model cannot count, so asking once is not enough — measured on this very
  // take, "cut 51 words" produced 224 words: it cut eight. Query a few times and
  // keep the shortest answer, exactly as SC does for the word band.
  let draft: ScriptDocument | null = null;
  let draftWords = Number.POSITIVE_INFINITY;
  let lastReason = '';
  /** The run the surviving draft came from: the plan asset points at it for provenance. */
  let draftRunId: string | null = null;
  for (let query = 1; query <= MAX_TRIM_QUERIES; query += 1) {
    const messages = buildTrimMessages({
      document: query === 1 ? current.content : (draft ?? current.content),
      currentWords: query === 1 ? input.wordCount : draftWords,
      targetWords,
      sceneCount,
    });
    const adapter = deps.text.forRequest({
      stage: 'SC',
      schema: TEXT_SCHEMAS.script,
      messages,
      temperature: 0.2,
    });
    const run = await openRunInAttempt(deps.pool, {
      jobAttemptId: input.jobAttemptId,
      projectId: input.projectId,
      stage: 'SC',
      provider: adapter.provider,
      model: deps.text.model,
      promptHash: sha256Hex(new TextEncoder().encode(messages.map((m) => m.content).join('\n'))),
      seriesVersionId: null,
    });
    try {
      const result = await adapter.execute(run);
      const words = countWords(spokenNarration(result.content));
      if (words < draftWords) {
        draft = result.content;
        draftWords = words;
        draftRunId = run.id;
      }
      if (Math.abs(words - targetWords) <= tolerance) break;
      lastReason = `query ${query} returned ${words} words; ${targetWords} ±${tolerance} required`;
    } catch (error) {
      lastReason = `query ${query} failed: ${(error as Error).message}`;
    }
  }

  if (draft === null) {
    return { applied: false, reason: `the trim call failed: ${lastReason}` };
  }

  // Backstop: the best answer is still over. Cut whole sentences, longest first,
  // keeping the hook and the ending. Deterministic, so the take always moves
  // instead of bouncing between review and another rewrite that also overruns.
  let trimmed = draft;
  if (draftWords > maxWords) {
    trimmed = trimSentencesToFit(draft, maxWords);
    const fitted = countWords(spokenNarration(trimmed));
    if (fitted > maxWords) {
      return {
        applied: false,
        reason:
          `the trim returned ${draftWords} words and even a sentence-level cut left ` +
          `${fitted}; ${targetWords} ±${tolerance} was required`,
      };
    }
  }

  let rebuilt: RebuiltPlan;
  try {
    rebuilt = rebuildPlan({
      plan: plan.document,
      carryovers,
      document: trimmed,
      targetDurationS: input.targetDurationS,
    });
  } catch (error) {
    return { applied: false, reason: (error as Error).message };
  }

  const revision = current.revision + 1;
  await deps.pool.query(
    `INSERT INTO script_revision
       (project_id, revision, content, schema_version, word_count, status, approved_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, 'approved', now())
     ON CONFLICT (project_id, revision) DO NOTHING`,
    [
      input.projectId,
      revision,
      JSON.stringify(trimmed),
      TEXT_SCHEMAS.script.version,
      rebuilt.word_count,
    ],
  );

  // Same object key: the storage layout is the operator's map of the batch, and a
  // repaired storyboard belongs where the previous one lived, not beside it.
  const bytes = new TextEncoder().encode(JSON.stringify(rebuilt.document));
  await deps.blobs.put(plan.object_key, bytes, 'application/json');
  await withTransaction(deps.pool, async (client) => {
    const inserted = await insertAsset(client, {
      projectId: input.projectId,
      stage: 'NA', // borrowed: the plan has no asset stage of its own (D-F)
      kind: 'sidecar',
      contentSha256: sha256Hex(bytes),
      objectKey: plan.object_key,
      objectSizeBytes: bytes.byteLength,
      mimeType: 'application/json',
      seriesVersionId: null,
      provider: deps.text.provider,
      model: deps.text.model,
      rightsMetadata: { stage: 'SB', role: 'storyboard-plan', repaired_for_duration: true },
      generationRunId: draftRunId,
    });
    await linkAssetToProject(client, {
      assetId: inserted.row.id,
      projectId: input.projectId,
      role: 'storyboard_plan',
    });
  });

  return {
    applied: true,
    target_words: targetWords,
    word_count: rebuilt.word_count,
    revision,
    detail:
      `narration ran ${input.measuredAudioS.toFixed(2)} s for ${input.wordCount} words ` +
      `(${(input.wordCount / input.measuredAudioS).toFixed(2)} w/s); trimmed to ` +
      `${rebuilt.word_count} words as script revision ${revision} and kept all ` +
      `${carryovers.length} scene prompts, so the images still stand`,
  };
}
