/**
 * Fixtures for the NA/TC stage tests (B-11).
 *
 * `seedProject` (tests/helpers/fixtures.ts) builds the smallest legal operator →
 * series → series_version → project → job chain. The stage workers additionally
 * need the stage's own rows: a `job` for the stage, the `video_stage` row the
 * state machine guards, and for timing, the scenes whose narration spans it
 * recalcs. These inserts are raw SQL for the same reason the existing fixtures
 * are: they are test scaffolding, not a production write path.
 */
import type { Pool } from 'pg';

/** A queued job row for one stage of a project. */
export async function insertStageJob(
  pool: Pool,
  projectId: string,
  stage: string,
  status = 'queued',
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO job (project_id, stage, status) VALUES ($1, $2, $3) RETURNING id`,
    [projectId, stage, status],
  );
  return result.rows[0]!.id;
}

/** The per-stage state row the state machine owns (`video_stage`). */
export async function insertVideoStage(
  pool: Pool,
  projectId: string,
  stage: string,
  state = 'not_run',
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO video_stage (project_id, stage, state) VALUES ($1, $2, $3) RETURNING id`,
    [projectId, stage, state],
  );
  return result.rows[0]!.id;
}

/** Insert scenes in pipeline order; returns scene_no → id. */
export async function insertScenes(
  pool: Pool,
  projectId: string,
  sceneNos: readonly string[],
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const [index, sceneNo] of sceneNos.entries()) {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO scene (project_id, scene_no, position, image_prompt)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [projectId, sceneNo, index + 1, `prompt for ${sceneNo}`],
    );
    ids[sceneNo] = result.rows[0]!.id;
  }
  return ids;
}

export interface StageStateSnapshot {
  readonly state: string;
  readonly series_version_id: string | null;
  readonly last_event: string | null;
}

export async function readVideoStage(
  pool: Pool,
  projectId: string,
  stage: string,
): Promise<StageStateSnapshot | null> {
  const result = await pool.query<StageStateSnapshot>(
    `SELECT state, series_version_id, last_event FROM video_stage
      WHERE project_id = $1 AND stage = $2`,
    [projectId, stage],
  );
  return result.rows[0] ?? null;
}

export interface ProjectSnapshot {
  readonly status: string;
  readonly current_stage: string | null;
}

export async function readProject(pool: Pool, projectId: string): Promise<ProjectSnapshot | null> {
  const result = await pool.query<ProjectSnapshot>(
    `SELECT status, current_stage FROM project WHERE id = $1`,
    [projectId],
  );
  return result.rows[0] ?? null;
}

/**
 * Deterministic narration of exactly `count` words ("w1 w2 … wN."). Short words
 * keep the character alignment cheap while the count drives the fake adapter's
 * 3.035 words/s duration, which is what the ±5 % band is measured against.
 */
export function narrationText(count: number): string {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`narration word count must be a positive integer, got ${String(count)}`);
  }
  const words: string[] = [];
  for (let index = 1; index <= count; index += 1) words.push(`w${index}`);
  return `${words.join(' ')}.`;
}
