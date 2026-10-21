/**
 * scene reads — R-007 (scene_no stable, position moves), US-019.
 *
 * The image stage reads scenes; it never invents or reorders them (that is the
 * storyboard stage and B-15 per-scene replace). One shared read keeps B-11,
 * B-12 and B-15 from growing three private copies of the row shape.
 */
import type { Queryable } from '../client.js';

export interface SceneRow {
  readonly id: string;
  readonly project_id: string;
  readonly scene_no: string;
  readonly position: number;
  readonly narration_start_ms: number | null;
  readonly narration_end_ms: number | null;
  readonly image_prompt: string | null;
  readonly camera_move: string | null;
  readonly caption_emphasis: string | null;
  readonly fallback_text: string | null;
  readonly uses_protagonist: boolean;
  readonly asset_id: string | null;
  readonly revision: number;
  readonly created_at: Date;
}

export const SCENE_COLUMNS =
  'id, project_id, scene_no, position, narration_start_ms, narration_end_ms, image_prompt, ' +
  'camera_move, caption_emphasis, fallback_text, uses_protagonist, asset_id, revision, created_at';

/** Scenes in display order. position, not scene_no, is the order (R-006-3). */
export async function listScenes(db: Queryable, projectId: string): Promise<SceneRow[]> {
  const result = await db.query<SceneRow>(
    'SELECT ' +
      SCENE_COLUMNS +
      ' FROM scene WHERE project_id = $1 ORDER BY position ASC, scene_no ASC',
    [projectId],
  );
  return result.rows;
}

/** The scenes the first-three checkpoint reviews: positions 1..3 (PRD 10). */
export function firstThree(scenes: readonly SceneRow[]): SceneRow[] {
  return scenes.filter((scene) => scene.position <= 3);
}

/** The scene a request names, scoped to its video (a scene id is not a capability). */
export async function findSceneInProject(
  db: Queryable,
  projectId: string,
  sceneId: string,
): Promise<SceneRow | null> {
  const result = await db.query<SceneRow>(
    'SELECT ' + SCENE_COLUMNS + ' FROM scene WHERE id = $1 AND project_id = $2',
    [sceneId, projectId],
  );
  return result.rows[0] ?? null;
}

/** The scene does not exist, or it belongs to a different video. Both are 404s. */
export class SceneNotFoundInProjectError extends Error {
  constructor(
    readonly sceneId: string,
    readonly projectId: string,
  ) {
    super('scene ' + sceneId + ' does not exist in video ' + projectId);
    this.name = 'SceneNotFoundInProjectError';
  }
}

/** R-024: the caller's revision is not the current one; the request is refused, not merged. */
export class SceneRevisionConflictError extends Error {
  constructor(
    readonly sceneId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      'scene ' +
        sceneId +
        ' is at revision ' +
        actualRevision +
        ', the request carried ' +
        expectedRevision +
        ': reload before editing (R-024)',
    );
    this.name = 'SceneRevisionConflictError';
  }
}

export interface PrepareSceneReplaceInput {
  readonly projectId: string;
  readonly sceneId: string;
  /** The optimistic-lock revision the operator's screen was showing (R-024). */
  readonly expectedRevision: number;
  /** An operator prompt override committed with the enqueue; omitted = no edit. */
  readonly imagePrompt?: string | null;
}

/**
 * Lock the scene, check its revision, and apply an optional prompt override —
 * the edit half of a per-scene replace (US-020). The caller owns the
 * transaction so the edit and the queued job commit together.
 *
 * The revision is bumped only when the prompt actually changes; an image
 * replacement that keeps the prompt is not a prompt edit (R-024).
 */
export async function lockSceneForReplace(
  db: Queryable,
  input: PrepareSceneReplaceInput,
): Promise<SceneRow> {
  const locked = await db.query<SceneRow>(
    'SELECT ' + SCENE_COLUMNS + ' FROM scene WHERE id = $1 AND project_id = $2 FOR UPDATE',
    [input.sceneId, input.projectId],
  );
  const scene = locked.rows[0];
  if (scene === undefined) throw new SceneNotFoundInProjectError(input.sceneId, input.projectId);
  if (scene.revision !== input.expectedRevision) {
    throw new SceneRevisionConflictError(input.sceneId, input.expectedRevision, scene.revision);
  }
  const prompt = input.imagePrompt ?? null;
  if (prompt === null || prompt.trim() === (scene.image_prompt ?? '').trim()) return scene;

  const updated = await db.query<SceneRow>(
    'UPDATE scene SET image_prompt = $2, revision = revision + 1 WHERE id = $1 RETURNING ' +
      SCENE_COLUMNS,
    [scene.id, prompt.trim()],
  );
  const row = updated.rows[0];
  if (row === undefined) throw new Error('scene prompt update returned no row');
  return row;
}
