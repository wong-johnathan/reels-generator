/**
 * `scene.narration_start_ms` / `narration_end_ms` — the scene spans that the
 * timing stage recalculates from real speech (TECH_DESIGN §3.1 `scene`,
 * R-009-3). Spans are the only thing TC writes to `scene`: reordering moves
 * `position` alone (R-006-3), and `scene_no` is the stable identity used here.
 *
 * All spans of one take are written in a single transaction, so a render can
 * never read a half-remapped storyboard.
 */
import type { Pool } from 'pg';

import { withTransaction, type Queryable } from '../client.js';

export interface SceneSpanRow {
  readonly id: string;
  readonly scene_no: string;
  readonly position: number;
  readonly narration_start_ms: number | null;
  readonly narration_end_ms: number | null;
}

export interface SceneSpanWrite {
  readonly scene_no: string;
  readonly start_ms: number;
  readonly end_ms: number;
}

export async function listSceneSpans(db: Queryable, projectId: string): Promise<SceneSpanRow[]> {
  const result = await db.query<SceneSpanRow>(
    `SELECT id, scene_no, position, narration_start_ms, narration_end_ms
       FROM scene WHERE project_id = $1 ORDER BY position`,
    [projectId],
  );
  return result.rows;
}

/**
 * Write every span or none. A plan scene with no `scene` row is an ordering bug
 * (timing ran before the storyboard persisted), so the whole take is refused
 * rather than silently leaving that scene without speech.
 */
export async function writeSceneNarrationSpans(
  pool: Pool,
  projectId: string,
  spans: readonly SceneSpanWrite[],
): Promise<number> {
  return withTransaction(pool, async (client) => {
    let written = 0;
    for (const span of spans) {
      if (!Number.isInteger(span.start_ms) || !Number.isInteger(span.end_ms)) {
        throw new RangeError(`scene ${span.scene_no} span must be integer milliseconds`);
      }
      if (span.end_ms < span.start_ms) {
        throw new RangeError(
          `scene ${span.scene_no} ends before it starts (${span.start_ms}..${span.end_ms})`,
        );
      }
      const result = await client.query(
        `UPDATE scene SET narration_start_ms = $3, narration_end_ms = $4
          WHERE project_id = $1 AND scene_no = $2`,
        [projectId, span.scene_no, span.start_ms, span.end_ms],
      );
      if ((result.rowCount ?? 0) !== 1) {
        throw new Error(
          `scene ${span.scene_no} does not exist on project ${projectId}: the timing plan is ahead of the storyboard`,
        );
      }
      written += 1;
    }
    return written;
  });
}
