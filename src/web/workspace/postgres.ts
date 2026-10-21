/**
 * Postgres-backed `VideoGateway` — the `video.get` workspace shell against
 * `project`, `series`, `video_stage`, `script_revision`, `scene`, `job` and
 * `job_attempt`.
 *
 * A video IS a `project` row; there is no `video` table. Fields the worker
 * computes but never stores are returned as their documented empty value and
 * listed below rather than invented:
 *
 *   - `attention_kind` / `attention_reason` — derived by the worker from the
 *     review/attempt ledger; this shell reports `none` / `null`.
 *   - `blocked_reason` — no column exists; the worker names the blocking
 *     precondition at transition time, so it is `null` here.
 *   - `stage.label` — the canonical human label from `STAGE_LABELS`.
 *
 * `project.current_stage` is NULL until the first stage starts; the contract
 * requires a stage code, so NULL maps to the first stage `T` and the video's
 * `stage_state` to `not_run` (the honest state of a not-yet-started video).
 * `project.position_in_batch` is NULL for the Milestone-A single-video slice
 * and maps to `0` (the contract's `min(0)` value).
 */
import type { Pool } from 'pg';

import { VideoDetailSchema } from '../../../contract/api.js';
import {
  STAGE_CODES,
  STAGE_LABELS,
  STAGE_ORDER,
  type StageCode,
  type StageState,
} from '../../shared/stages.js';
import type { ErrorClass } from '../../shared/states.js';
import type { VideoDetail, VideoGateway } from './gateway.js';

/** R-011-2: `job_attempt.attempt_no` is bounded 1..3 — the fixed retry budget. */
const MAX_ATTEMPTS = 3;

interface ProjectRow {
  readonly id: string;
  readonly batch_id: string | null;
  readonly series_id: string;
  readonly series_name: string;
  readonly position_in_batch: number | null;
  readonly status: string;
  readonly current_stage: string | null;
  readonly target_duration_s: number | null;
  readonly series_target_duration_s: number;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly topic_id: string | null;
  readonly script_revision: number | null;
  readonly scene_count: number;
}

interface StageRow {
  readonly stage: StageCode;
  readonly state: StageState;
  readonly series_version_id: string | null;
  readonly series_version: number | null;
  readonly stale: boolean;
  readonly stale_cause: string | null;
  readonly stale_at: Date | null;
  readonly last_event: string | null;
  readonly last_event_at: Date | null;
  readonly progress_current: number | null;
  readonly progress_total: number | null;
}

interface AttemptRow {
  readonly stage: string;
  readonly attempt_count: number;
  readonly last_error_class: ErrorClass | null;
}

const PROJECT_SELECT = /* sql */ `
  SELECT p.id, p.batch_id, p.series_id, s.name AS series_name,
         p.position_in_batch, p.status, p.current_stage,
         p.target_duration_s, s.target_duration_s AS series_target_duration_s,
         p.created_at, p.updated_at, p.topic_id,
         (SELECT max(sr.revision) FROM script_revision sr WHERE sr.project_id = p.id)
           AS script_revision,
         (SELECT count(*)::int FROM scene sc WHERE sc.project_id = p.id) AS scene_count
    FROM project p
    JOIN series s ON s.id = p.series_id
`;

const STAGE_SELECT = /* sql */ `
  SELECT vs.stage, vs.state, vs.series_version_id, sv.version AS series_version,
         vs.stale, vs.stale_cause, vs.stale_at, vs.last_event, vs.last_event_at,
         vs.progress_current, vs.progress_total
    FROM video_stage vs
    LEFT JOIN series_version sv ON sv.id = vs.series_version_id
`;

const ATTEMPT_SELECT = /* sql */ `
  SELECT j.stage,
         count(ja.id)::int AS attempt_count,
         (SELECT ja2.error_class
            FROM job_attempt ja2
            JOIN job j2 ON j2.id = ja2.job_id
           WHERE j2.project_id = $1 AND j2.stage = j.stage
           ORDER BY ja2.attempt_no DESC, ja2.created_at DESC
           LIMIT 1) AS last_error_class
    FROM job j
    LEFT JOIN job_attempt ja ON ja.job_id = j.id
   WHERE j.project_id = $1
   GROUP BY j.stage
`;

function byStageOrder(left: StageCode, right: StageCode): number {
  return STAGE_ORDER[left] - STAGE_ORDER[right];
}

/**
 * RULING C-3 pin summary, rendered exactly like the contract fixture:
 * `versions` is oldest-first, `text` is newest-first (`v3 ×4 · v2 ×3`), bare
 * `v13` when every pinned stage agrees.
 */
function buildPins(rows: readonly StageRow[]): VideoDetail['pins'] {
  const byVersion = new Map<number, { version: number; stages: StageCode[] }>();
  for (const row of rows) {
    if (row.series_version_id === null || row.series_version === null) continue;
    const entry = byVersion.get(row.series_version) ?? { version: row.series_version, stages: [] };
    entry.stages.push(row.stage);
    byVersion.set(row.series_version, entry);
  }

  const versions = [...byVersion.values()]
    .sort((left, right) => left.version - right.version)
    .map((entry) => ({
      version: entry.version,
      count: entry.stages.length,
      stages: [...entry.stages].sort(byStageOrder),
    }));

  const uniform = versions.length <= 1;
  const text =
    versions.length === 0
      ? ''
      : uniform
        ? 'v' + versions[0]?.version
        : [...versions]
            .sort((left, right) => right.version - left.version)
            .map((entry) => 'v' + entry.version + ' ×' + entry.count)
            .join(' · ');

  return { text, uniform, versions };
}

function buildStages(
  stageRows: readonly StageRow[],
  attemptRows: readonly AttemptRow[],
): VideoDetail['stages'] {
  const byCode = new Map(stageRows.map((row) => [row.stage, row]));
  const attemptsByCode = new Map(attemptRows.map((row) => [row.stage, row]));

  return STAGE_CODES.map((code) => {
    const row = byCode.get(code);
    const attempts = attemptsByCode.get(code);
    return {
      stage: code,
      label: STAGE_LABELS[code],
      state: row?.state ?? 'not_run',
      series_version_id: row?.series_version_id ?? null,
      series_version: row?.series_version ?? null,
      stale: row?.stale ?? false,
      stale_cause: row?.stale_cause ?? null,
      stale_at: row?.stale_at?.toISOString() ?? null,
      last_event: row?.last_event ?? null,
      last_event_at: row?.last_event_at?.toISOString() ?? null,
      progress: { current: row?.progress_current ?? 0, total: row?.progress_total ?? 0 },
      attempts: {
        count: attempts?.attempt_count ?? 0,
        max_attempts: MAX_ATTEMPTS,
        last_error_class: attempts?.last_error_class ?? null,
      },
      blocked_reason: null,
    };
  });
}

function buildDetail(
  project: ProjectRow,
  stageRows: readonly StageRow[],
  attemptRows: readonly AttemptRow[],
): VideoDetail {
  const currentStage = project.current_stage ?? 'T';
  const currentStageRow = stageRows.find((row) => row.stage === currentStage);

  return VideoDetailSchema.parse({
    id: project.id,
    batch_id: project.batch_id,
    series_id: project.series_id,
    series_name: project.series_name,
    position_in_batch: project.position_in_batch ?? 0,
    status: project.status,
    current_stage: currentStage,
    stage_state: currentStageRow?.state ?? 'not_run',
    attention_kind: 'none',
    attention_reason: null,
    pins: buildPins(stageRows),
    updated_at: project.updated_at.toISOString(),
    topic_id: project.topic_id,
    script_revision: project.script_revision,
    scene_count: project.scene_count,
    target_duration_s: project.target_duration_s ?? project.series_target_duration_s,
    created_at: project.created_at.toISOString(),
    stages: buildStages(stageRows, attemptRows),
    links: {
      topic: '/videos/' + project.id,
      script: '/videos/' + project.id + '/script',
      storyboard: '/videos/' + project.id + '/storyboard',
      scenes: '/videos/' + project.id + '/scenes',
      audio: '/videos/' + project.id + '/audio',
      render: '/videos/' + project.id + '/render',
      export: '/videos/' + project.id + '/export',
    },
  });
}

export function createVideoGateway(pool: Pool): VideoGateway {
  return {
    async get(videoId: string): Promise<VideoDetail | null> {
      const project = await pool.query<ProjectRow>(`${PROJECT_SELECT} WHERE p.id = $1`, [videoId]);
      const row = project.rows[0];
      if (row === undefined) return null;

      const [stages, attempts] = await Promise.all([
        pool.query<StageRow>(`${STAGE_SELECT} WHERE vs.project_id = $1 ORDER BY vs.stage`, [
          videoId,
        ]),
        pool.query<AttemptRow>(ATTEMPT_SELECT, [videoId]),
      ]);

      return buildDetail(row, stages.rows, attempts.rows);
    },
  };
}
