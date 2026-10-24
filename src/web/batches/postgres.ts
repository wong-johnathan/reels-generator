/**
 * The Batches page (nav key `batches`).
 *
 * The navigation has linked to `/batches` since the shell was written, but no
 * route existed: the link fell through to the authenticated 404. This is the
 * read model behind it — every batch, newest first, with its videos and whether
 * each one has a rendered MP4 to download.
 */
import type { Queryable } from '../../db/client.js';

export interface BatchVideo {
  readonly projectId: string;
  readonly position: number;
  readonly status: string;
  readonly currentStage: string | null;
  readonly videoAssetId: string | null;
}

export interface BatchSummary {
  readonly id: string;
  readonly ordinal: number;
  readonly status: string;
  readonly targetCount: number;
  readonly createdAt: string;
  readonly seriesId: string;
  readonly seriesName: string;
  readonly seriesSlug: string;
  readonly videos: readonly BatchVideo[];
}

export const EMPTY_BATCHES: readonly BatchSummary[] = [];

/** Newest batch first; videos in their position order. */
export async function loadBatches(db: Queryable): Promise<readonly BatchSummary[]> {
  return loadBatchesWhere(db, null);
}

/** Every batch for one series, newest first; videos in their position order. */
export async function loadBatchesForSeries(
  db: Queryable,
  seriesId: string,
): Promise<readonly BatchSummary[]> {
  return loadBatchesWhere(db, seriesId);
}

/**
 * Shared batch loader. A `null` series reads every batch (the old S-05 flat
 * list); a concrete series reads only that series' batches, so the series page
 * can never leak another series' work. Newest first, then by the stored
 * `ordinal` so two batches minted in the same instant keep a stable order.
 */
async function loadBatchesWhere(
  db: Queryable,
  seriesId: string | null,
): Promise<readonly BatchSummary[]> {
  const filter = seriesId === null ? '' : ' WHERE b.series_id = $1';
  const values = seriesId === null ? [] : [seriesId];

  const batches = await db.query<{
    id: string;
    ordinal: number;
    status: string;
    target_count: number;
    created_at: Date | string;
    series_id: string;
    series_name: string;
    series_slug: string;
  }>(
    /* sql */ `
    SELECT b.id, b.ordinal, b.status, b.target_count, b.created_at,
           s.id AS series_id, s.name AS series_name, s.slug AS series_slug
      FROM batch b
      JOIN series s ON s.id = b.series_id
     ${filter}
     ORDER BY b.created_at DESC, b.ordinal DESC`,
    values,
  );

  if (batches.rows.length === 0) return EMPTY_BATCHES;

  const videos = await db.query<{
    batch_id: string;
    id: string;
    position_in_batch: number;
    status: string;
    current_stage: string | null;
    video_asset_id: string | null;
  }>(
    /* sql */ `
    SELECT p.batch_id, p.id, p.position_in_batch, p.status, p.current_stage,
           (SELECT a.id
              FROM asset a
              JOIN asset_ref r ON r.asset_id = a.id
             WHERE r.project_id = p.id AND r.role = 'video' AND a.stage = 'RE'
             ORDER BY a.created_at DESC
             LIMIT 1) AS video_asset_id
      FROM project p
     WHERE p.batch_id = ANY($1::uuid[])
     ORDER BY p.position_in_batch ASC`,
    [batches.rows.map((row) => row.id)],
  );

  const byBatch = new Map<string, BatchVideo[]>();
  for (const row of videos.rows) {
    const list = byBatch.get(row.batch_id) ?? [];
    list.push({
      projectId: row.id,
      position: row.position_in_batch,
      status: row.status,
      currentStage: row.current_stage,
      videoAssetId: row.video_asset_id,
    });
    byBatch.set(row.batch_id, list);
  }

  return batches.rows.map((row) => ({
    id: row.id,
    ordinal: row.ordinal,
    status: row.status,
    targetCount: row.target_count,
    createdAt: new Date(row.created_at).toISOString(),
    seriesId: row.series_id,
    seriesName: row.series_name,
    seriesSlug: row.series_slug,
    videos: byBatch.get(row.id) ?? [],
  }));
}

// ── S-05 series index (`/batches` lists series, not a flat batch list) ───────

export interface SeriesBatchIndexEntry {
  readonly seriesId: string;
  readonly seriesName: string;
  readonly seriesSlug: string;
  readonly batchCount: number;
  readonly activeBatches: number;
  readonly completeBatches: number;
  readonly cancelledBatches: number;
  readonly videoCount: number;
  readonly downloadableCount: number;
  readonly newestBatchAt: string | null;
}

export const EMPTY_SERIES_INDEX: readonly SeriesBatchIndexEntry[] = [];

/**
 * Deterministic series order for the index: case-insensitive name, then the
 * series id as a stable tie-breaker. Kept pure so the ordering rule is testable
 * without a database, and applied after the query so there is exactly one
 * implementation of it.
 */
export function compareSeriesIndexEntries(
  a: Pick<SeriesBatchIndexEntry, 'seriesName' | 'seriesId'>,
  b: Pick<SeriesBatchIndexEntry, 'seriesName' | 'seriesId'>,
): number {
  const nameA = a.seriesName.toLowerCase();
  const nameB = b.seriesName.toLowerCase();
  if (nameA < nameB) return -1;
  if (nameA > nameB) return 1;
  if (a.seriesId < b.seriesId) return -1;
  if (a.seriesId > b.seriesId) return 1;
  return 0;
}

/**
 * One row per series, with its batch status breakdown and video progress.
 * Only columns that exist are read — a series with no batches contributes zero
 * counts, and a batch with no rendered video contributes no downloadable count.
 */
export async function loadSeriesBatchIndex(
  db: Queryable,
): Promise<readonly SeriesBatchIndexEntry[]> {
  const rows = await db.query<{
    series_id: string;
    series_name: string;
    series_slug: string;
    batch_count: number;
    active_batches: number;
    complete_batches: number;
    cancelled_batches: number;
    video_count: number;
    downloadable_count: number;
    newest_batch_at: Date | string | null;
  }>(/* sql */ `
    SELECT s.id AS series_id, s.name AS series_name, s.slug AS series_slug,
           count(DISTINCT b.id)::int AS batch_count,
           count(DISTINCT b.id) FILTER (WHERE b.status = 'ACTIVE')::int AS active_batches,
           count(DISTINCT b.id) FILTER (WHERE b.status = 'COMPLETE')::int AS complete_batches,
           count(DISTINCT b.id) FILTER (WHERE b.status = 'CANCELLED')::int AS cancelled_batches,
           count(p.id)::int AS video_count,
           count(v.video_asset_id)::int AS downloadable_count,
           max(b.created_at) AS newest_batch_at
      FROM series s
      LEFT JOIN batch b ON b.series_id = s.id
      LEFT JOIN project p ON p.batch_id = b.id
      LEFT JOIN LATERAL (
        SELECT a.id AS video_asset_id
          FROM asset a
          JOIN asset_ref r ON r.asset_id = a.id
         WHERE r.project_id = p.id AND r.role = 'video' AND a.stage = 'RE'
         ORDER BY a.created_at DESC
         LIMIT 1
      ) v ON true
     GROUP BY s.id, s.name, s.slug`);

  return rows.rows
    .map((row) => ({
      seriesId: row.series_id,
      seriesName: row.series_name,
      seriesSlug: row.series_slug,
      batchCount: row.batch_count,
      activeBatches: row.active_batches,
      completeBatches: row.complete_batches,
      cancelledBatches: row.cancelled_batches,
      videoCount: row.video_count,
      downloadableCount: row.downloadable_count,
      newestBatchAt:
        row.newest_batch_at === null ? null : new Date(row.newest_batch_at).toISOString(),
    }))
    .sort(compareSeriesIndexEntries);
}

// ── batch detail (S-06) ──────────────────────────────────────────────────────

export interface BatchTopic {
  readonly title: string | null;
  readonly description: string | null;
  readonly rationale: string | null;
}

export interface BatchScript {
  readonly revision: number;
  readonly wordCount: number | null;
  readonly estimatedRuntimeS: number | null;
  readonly title: string | null;
  readonly script: string | null;
  readonly description: string | null;
  readonly hashtags: readonly string[];
}

export interface BatchFailure {
  readonly stage: string;
  readonly attemptNo: number;
  /** Stored job_attempt.status; timed_out/unknown_charge must not read as unbilled. */
  readonly attemptStatus: string;
  /** Latest generation_run.status; timed_out is direct timeout evidence. */
  readonly runStatus: 'pending' | 'succeeded' | 'failed' | 'timed_out' | 'unknown' | null;
  /** Latest provider call in this attempt, not a total across retained scene calls.
   * Null means no provider call exists; pending is not evidence of no charge.
   */
  readonly chargeStatus: 'pending' | 'unknown' | 'billed' | 'unbilled' | null;
  readonly errorClass: string | null;
  readonly message: string | null;
  readonly at: string;
}

export interface BatchVideoDetail extends BatchVideo {
  readonly topic: BatchTopic | null;
  readonly script: BatchScript | null;
  readonly sceneCount: number;
  readonly failure: BatchFailure | null;
}

export interface BatchDetail {
  readonly id: string;
  readonly ordinal: number;
  readonly status: string;
  readonly targetCount: number;
  readonly createdAt: string;
  readonly seriesId: string;
  readonly seriesName: string;
  readonly videos: readonly BatchVideoDetail[];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * One batch with everything the pipeline produced for each video: the topic it
 * chose, the script it wrote, how many scenes it split that into, and why the last
 * attempt failed if it did.
 *
 * Every field is read from a column that exists. A missing topic or script is
 * `null` and the page says the stage has not run — it is never filled with a
 * plausible placeholder.
 */
export async function loadBatchDetail(db: Queryable, batchId: string): Promise<BatchDetail | null> {
  const batch = await db.query<{
    id: string;
    ordinal: number;
    status: string;
    target_count: number;
    created_at: Date | string;
    series_id: string;
    series_name: string;
  }>(
    /* sql */ `
    SELECT b.id, b.ordinal, b.status, b.target_count, b.created_at,
           s.id AS series_id, s.name AS series_name
      FROM batch b
      JOIN series s ON s.id = b.series_id
     WHERE b.id = $1`,
    [batchId],
  );
  const head = batch.rows[0];
  if (head === undefined) return null;

  const projects = await db.query<{
    id: string;
    position_in_batch: number;
    status: string;
    current_stage: string | null;
    video_asset_id: string | null;
  }>(
    /* sql */ `
    SELECT p.id, p.position_in_batch, p.status, p.current_stage,
           (SELECT a.id
              FROM asset a
              JOIN asset_ref r ON r.asset_id = a.id
             WHERE r.project_id = p.id AND r.role = 'video' AND a.stage = 'RE'
             ORDER BY a.created_at DESC
             LIMIT 1) AS video_asset_id
      FROM project p
     WHERE p.batch_id = $1
     ORDER BY p.position_in_batch ASC`,
    [batchId],
  );

  const topics = await db.query<{
    project_id: string;
    title: string | null;
    description: string | null;
    rationale: string | null;
  }>(
    /* sql */ `
    SELECT DISTINCT ON (project_id) project_id, title, description, rationale
      FROM topic
     WHERE project_id = ANY($1::uuid[])
     ORDER BY project_id, created_at DESC`,
    [projects.rows.map((row) => row.id)],
  );

  const scripts = await db.query<{
    project_id: string;
    revision: number;
    content: unknown;
    word_count: number | null;
    estimated_runtime_s: number | null;
  }>(
    /* sql */ `
    SELECT DISTINCT ON (project_id) project_id, revision, content, word_count,
           estimated_runtime_s
      FROM script_revision
     WHERE project_id = ANY($1::uuid[])
     ORDER BY project_id, revision DESC`,
    [projects.rows.map((row) => row.id)],
  );

  const scenes = await db.query<{ project_id: string; n: number }>(
    /* sql */ `
    SELECT project_id, count(*)::int AS n
      FROM scene
     WHERE project_id = ANY($1::uuid[])
     GROUP BY project_id`,
    [projects.rows.map((row) => row.id)],
  );

  const failures = await db.query<{
    project_id: string;
    stage: string;
    attempt_no: number;
    attempt_status: string;
    charge_status: BatchFailure['chargeStatus'];
    run_status: BatchFailure['runStatus'];
    error_class: string | null;
    error_message: string | null;
    finished_at: Date | string | null;
  }>(
    /* sql */ `
    SELECT DISTINCT ON (j.project_id)
           j.project_id, j.stage, a.attempt_no, a.error_class, a.error_message,
           a.status AS attempt_status, gr.charge_status, gr.status AS run_status,
           coalesce(a.finished_at, a.started_at, a.created_at) AS finished_at
      FROM job j
      JOIN job_attempt a ON a.job_id = j.id
      LEFT JOIN LATERAL (
        SELECT r.charge_status, r.status
          FROM generation_run r
         WHERE r.job_attempt_id = a.id
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT 1
      ) gr ON true
     WHERE j.status = 'failed' AND j.project_id = ANY($1::uuid[])
     ORDER BY j.project_id, a.attempt_no DESC`,
    [projects.rows.map((row) => row.id)],
  );

  const topicBy = new Map(topics.rows.map((row) => [row.project_id, row]));
  const scriptBy = new Map(scripts.rows.map((row) => [row.project_id, row]));
  const scenesBy = new Map(scenes.rows.map((row) => [row.project_id, row.n]));
  const failureBy = new Map(failures.rows.map((row) => [row.project_id, row]));

  return {
    id: head.id,
    ordinal: head.ordinal,
    status: head.status,
    targetCount: head.target_count,
    createdAt: new Date(head.created_at).toISOString(),
    seriesId: head.series_id,
    seriesName: head.series_name,
    videos: projects.rows.map((row) => {
      const topic = topicBy.get(row.id);
      const script = scriptBy.get(row.id);
      const content = (script?.content ?? null) as Record<string, unknown> | null;
      const failure = failureBy.get(row.id);
      const hashtags = Array.isArray(content?.['hashtags'])
        ? (content['hashtags'] as unknown[]).filter((tag): tag is string => typeof tag === 'string')
        : [];
      return {
        projectId: row.id,
        position: row.position_in_batch,
        status: row.status,
        currentStage: row.current_stage,
        videoAssetId: row.video_asset_id,
        topic:
          topic === undefined
            ? null
            : {
                title: topic.title,
                description: topic.description,
                rationale: topic.rationale,
              },
        script:
          script === undefined
            ? null
            : {
                revision: script.revision,
                wordCount: script.word_count,
                estimatedRuntimeS: script.estimated_runtime_s,
                title: asString(content?.['title']),
                script: asString(content?.['script']),
                description: asString(content?.['description']),

                hashtags,
              },
        sceneCount: scenesBy.get(row.id) ?? 0,
        failure:
          failure === undefined
            ? null
            : {
                stage: failure.stage,
                attemptNo: failure.attempt_no,
                attemptStatus: failure.attempt_status,
                chargeStatus: failure.charge_status,
                runStatus: failure.run_status,
                errorClass: failure.error_class,
                message: failure.error_message,
                at: new Date(failure.finished_at ?? Date.now()).toISOString(),
              },
      };
    }),
  };
}
