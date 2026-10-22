/**
 * D-H: an operator can regenerate a failed batch in place.
 *
 * The point of the test is the promise the button makes: the failed job runs
 * again, the attempt is recorded as operator-triggered rather than as a fourth
 * automatic retry, and nothing that already succeeded is touched.
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
import { createBatch } from './batch.js';
import { BatchCancelledError, BatchNotFoundError, regenerateBatch } from './regenerate.js';

const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[regenerate tests skipped] ${SKIP_REASON}`);

describe.skipIf(!hasDatabase)('regenerateBatch (D-H)', { timeout: 120_000 }, () => {
  let db: TestDatabase;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.pool);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  async function seedBatch(): Promise<{ batchId: string; projectId: string; jobId: string }> {
    counter += 1;
    const slug = `regen-series-${counter}`;
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
      [seriesId, JSON.stringify({ target_duration_s: 75, videos_per_batch: 1 })],
    );
    const created = await createBatch(db.pool, { seriesId });
    const job = await db.pool.query<{ id: string }>(
      `SELECT id FROM job WHERE project_id = $1 AND stage = 'T'`,
      [created.projectIds[0]!],
    );
    return {
      batchId: created.batchId,
      projectId: created.projectIds[0]!,
      jobId: job.rows[0]!.id,
    };
  }

  /** Mark the T job failed the way the worker does, with one attempt recorded. */
  async function failFirstJob(jobId: string): Promise<void> {
    await db.pool.query(
      `INSERT INTO job_attempt (job_id, attempt_no, status, error_class, error_message, finished_at)
       VALUES ($1, 1, 'failed', 'non_retryable', 'deepseek answered HTTP 401', now())`,
      [jobId],
    );
    await db.pool.query(`UPDATE job SET status = 'failed' WHERE id = $1`, [jobId]);
    await db.pool.query(
      `UPDATE video_stage SET state = 'failed' WHERE stage = 'T' AND project_id =
         (SELECT project_id FROM job WHERE id = $1)`,
      [jobId],
    );
  }

  it('requeues a failed job and records the attempt as operator-triggered', async () => {
    const { batchId, projectId, jobId } = await seedBatch();
    await failFirstJob(jobId);

    const result = await regenerateBatch(db.pool, {
      batchId,
      operatorUsername: null,
    });

    expect(result.requeued).toBe(1);
    expect(result.projectIds).toEqual([projectId]);

    const job = await db.pool.query<{ status: string }>('SELECT status FROM job WHERE id = $1', [
      jobId,
    ]);
    expect(job.rows[0]!.status).toBe('queued');

    const attempts = await db.pool.query<{
      attempt_no: number;
      status: string;
      triggered_kind: string;
    }>(
      'SELECT attempt_no, status, triggered_kind FROM job_attempt WHERE job_id = $1 ORDER BY attempt_no',
      [jobId],
    );
    // Attempt 2 exists at all only because M-008 lifted the 1..3 cap for operators.
    expect(attempts.rows.map((row) => row.attempt_no)).toEqual([1, 2]);
    expect(attempts.rows[1]).toMatchObject({ status: 'pending', triggered_kind: 'operator' });

    const project = await db.pool.query<{ status: string }>(
      'SELECT status FROM project WHERE id = $1',
      [projectId],
    );
    expect(project.rows[0]!.status).toBe('RUNNING');
  });

  it('leaves a job that never failed alone', async () => {
    const { batchId } = await seedBatch();
    const result = await regenerateBatch(db.pool, { batchId });
    expect(result.requeued).toBe(0);
  });

  it('refuses a cancelled batch, because cancellation is final', async () => {
    const { batchId } = await seedBatch();
    await db.pool.query("UPDATE batch SET status = 'CANCELLED' WHERE id = $1", [batchId]);
    await expect(regenerateBatch(db.pool, { batchId })).rejects.toBeInstanceOf(BatchCancelledError);
  });

  it('refuses an unknown batch', async () => {
    await expect(
      regenerateBatch(db.pool, { batchId: '00000000-0000-0000-0000-000000000000' }),
    ).rejects.toBeInstanceOf(BatchNotFoundError);
  });

  it('does not requeue a succeeded stage', async () => {
    const { batchId, jobId } = await seedBatch();
    await db.pool.query("UPDATE job SET status = 'succeeded' WHERE id = $1", [jobId]);
    const result = await regenerateBatch(db.pool, { batchId });
    expect(result.requeued).toBe(0);
    const job = await db.pool.query<{ status: string }>('SELECT status FROM job WHERE id = $1', [
      jobId,
    ]);
    expect(job.rows[0]!.status).toBe('succeeded');
  });
});
