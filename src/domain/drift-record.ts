/**
 * The 17-scene character-drift record — PRD 4 (D4 residual unknown), LEAD_PLAN 2/4.
 *
 * The benchmark itself is an operator activity: generate the 17 scenes with the
 * recurring protagonist reference set and count the visually off-model ones.
 * This module is the part that is automatable and must not be improvised at
 * reporting time: it validates the operator scene list and computes the drift
 * rate, and it refuses a record without a model, a scene count and valid scene
 * ids. A missing eyeball therefore cannot be back-filled with zero drift.
 */

const SCENE_NO_PATTERN = /^S[0-9]{2}$/;

export class DriftRecordError extends Error {
  constructor(
    readonly code:
      'model_missing' | 'scene_count_invalid' | 'scene_no_invalid' | 'scene_no_duplicate',
    message: string,
  ) {
    super(code + ': ' + message);
    this.name = 'DriftRecordError';
  }
}

export interface DriftRecordInput {
  /** The model actually used, e.g. gemini-nano-banana-2.1 — never a guess. */
  readonly model: string;
  readonly sceneCount: number;
  /** The scene ids the operator judged off-model, e.g. ['S04', 'S11']. */
  readonly offModelSceneNos: readonly string[];
  readonly measuredAt?: Date;
  readonly notes?: string | null;
}

export interface DriftRecord {
  readonly model: string;
  readonly total_scenes: number;
  readonly off_model_scene_nos: readonly string[];
  /** off-model scenes / total scenes, rounded to 4 decimals. */
  readonly drift_rate: number;
  readonly measured_at: string;
  readonly notes: string | null;
}

export function recordDrift(input: DriftRecordInput): DriftRecord {
  const model = input.model.trim();
  if (model === '')
    throw new DriftRecordError(
      'model_missing',
      'the record must name the model that produced the scenes',
    );
  if (!Number.isInteger(input.sceneCount) || input.sceneCount < 1) {
    throw new DriftRecordError(
      'scene_count_invalid',
      'scene count must be a positive integer, got ' + String(input.sceneCount),
    );
  }

  const seen = new Set<string>();
  for (const sceneNo of input.offModelSceneNos) {
    if (!SCENE_NO_PATTERN.test(sceneNo)) {
      throw new DriftRecordError(
        'scene_no_invalid',
        'scene id "' + sceneNo + '" is not S01..S99 (R-007-2)',
      );
    }
    const position = Number.parseInt(sceneNo.slice(1), 10);
    if (position < 1 || position > input.sceneCount) {
      throw new DriftRecordError(
        'scene_no_invalid',
        'scene id ' + sceneNo + ' is outside 1..' + input.sceneCount,
      );
    }
    if (seen.has(sceneNo)) {
      throw new DriftRecordError('scene_no_duplicate', 'scene id ' + sceneNo + ' is listed twice');
    }
    seen.add(sceneNo);
  }

  const offModel = [...seen].sort();
  return {
    model,
    total_scenes: input.sceneCount,
    off_model_scene_nos: offModel,
    drift_rate: Number((offModel.length / input.sceneCount).toFixed(4)),
    measured_at: (input.measuredAt ?? new Date()).toISOString(),
    notes: input.notes ?? null,
  };
}
