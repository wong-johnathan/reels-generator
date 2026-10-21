/**
 * R-019: batch minting is atomic — one batch, its projects, per-project stage
 * rows and the first jobs all commit together or not at all. Batch size comes
 * from the series snapshot (`videos_per_batch`, commit dbac061), not from the
 * caller; an explicit override exists only for tests.
 *
 * Skipped without a throwaway Postgres (see `tests/helpers/pg.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../../tests/helpers/pg.js';
import { runMigrations } from '../db/runner.js';
import { BatchSeriesArchivedError, BatchSeriesNotFoundError, createBatch } from './batch.js';

const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[batch tests skipped] ${SKIP_REASON}`);

describe.skipIf(!hasDatabase)('createBatch (R-019)', { timeout: 120_000 }, () => {
  let db: TestDatabase;
  let slugCounter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.pool);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  async function seedSeries(snapshot: Record<string, unknown>): Promise<string> {
    slugCounter += 1;
    const slug = `batch-series-${slugCounter}`;
    const series = await db.pool.query<{ id: string }>(
      `INSERT INTO series (name, slug, niche, mode, target_duration_s)
       VALUES ($1, $2, '{}'::jsonb, 'creative', 75)
       RETURNING id`,
      [slug, slug],
    );
    const seriesId = series.rows[0]!.id;
    await db.pool.query(
      `INSERT INTO series_version (series_id, version, snapshot, mode, target_duration_s)
       VALUES ($1, 1, $2::jsonb, 'creative', 75)`,
      [seriesId, JSON.stringify(snapshot)],
    );
    return seriesId;
  }

  it('mints one batch, one project, 11 stage rows and the first job, atomically', async () => {
    const seriesId = await seedSeries({ target_duration_s: 75, videos_per_batch: 1 });

    const result = await createBatch(db.pool, { seriesId });
    expect(result.projectIds).toHaveLength(1);
    expect(result.firstJobIds).toHaveLength(1);

    const projectId = result.projectIds[0]!;
    const batch = await db.pool.query<{ target_count: number }>(
      `SELECT target_count FROM batch WHERE id = $1`,
      [result.batchId],
    );
    expect(batch.rows[0]!.target_count).toBe(1);

    const stages = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM video_stage WHERE project_id = $1`,
      [projectId],
    );
    expect(stages.rows[0]!.n).toBe(11);

    const jobs = await db.pool.query<{ stage: string; status: string }>(
      `SELECT stage, status FROM job WHERE project_id = $1`,
      [projectId],
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]).toMatchObject({ stage: 'T', status: 'queued' });
  });

  it('reads the batch size from the snapshot videos_per_batch', async () => {
    const seriesId = await seedSeries({ target_duration_s: 75, videos_per_batch: 3 });
    const result = await createBatch(db.pool, { seriesId });
    expect(result.projectIds).toHaveLength(3);
    expect(result.firstJobIds).toHaveLength(3);
  });

  it('falls back to 1 for snapshots written before videos_per_batch existed', async () => {
    const seriesId = await seedSeries({ target_duration_s: 75 });
    const result = await createBatch(db.pool, { seriesId });
    expect(result.projectIds).toHaveLength(1);
  });

  it('honours an explicit test override', async () => {
    const seriesId = await seedSeries({ target_duration_s: 75, videos_per_batch: 1 });
    const result = await createBatch(db.pool, { seriesId, targetCount: 2 });
    expect(result.projectIds).toHaveLength(2);
  });

  it('allocates batch.ordinal 1, 2, … per series (the readable path number)', async () => {
    const seriesId = await seedSeries({ target_duration_s: 75, videos_per_batch: 1 });
    await createBatch(db.pool, { seriesId });
    await createBatch(db.pool, { seriesId });
    const ordinals = await db.pool.query<{ ordinal: number }>(
      `SELECT ordinal FROM batch WHERE series_id = $1 ORDER BY ordinal ASC`,
      [seriesId],
    );
    expect(ordinals.rows.map((row) => row.ordinal)).toEqual([1, 2]);
  });

  it('refuses an archived series', async () => {
    const seriesId = await seedSeries({ target_duration_s: 75, videos_per_batch: 1 });
    await db.pool.query(`UPDATE series SET status = 'archived' WHERE id = $1`, [seriesId]);
    await expect(createBatch(db.pool, { seriesId })).rejects.toBeInstanceOf(
      BatchSeriesArchivedError,
    );
  });

  it('refuses an unknown series', async () => {
    await expect(
      createBatch(db.pool, { seriesId: 'aaaaaaaa-0000-4000-8000-000000000000' }),
    ).rejects.toBeInstanceOf(BatchSeriesNotFoundError);
  });
});
