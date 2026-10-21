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
