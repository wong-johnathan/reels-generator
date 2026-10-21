/**
 * The worker job loop: concurrency-safe claiming (FOR UPDATE SKIP LOCKED),
 * stage-filtered claims per worker role, terminal job status on dispatch, and
 * clean exit when the stop flag is set. Claiming is a Postgres property, so the
 * tests run against a throwaway database; the pure dispatch mapping is covered
 * by the orchestrator and the end-to-end test.
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
import { seedProject } from '../../tests/helpers/web-gateway-seed.js';
import { CONTENT_STAGES, RENDER_STAGES, type ClaimedJob } from './orchestrator.js';
import { claimNextJob, runWorkerLoop } from './loop.js';

const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[worker loop tests skipped] ${SKIP_REASON}`);

describe.skipIf(!hasDatabase)('worker job loop', { timeout: 120_000 }, () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.pool);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  async function queueJob(projectId: string, stage: string, priority = 0): Promise<string> {
    const job = await db.pool.query<{ id: string }>(
      `INSERT INTO job (project_id, stage, status, priority)
       VALUES ($1, $2, 'queued', $3)
       RETURNING id`,
      [projectId, stage, priority],
    );
    return job.rows[0]!.id;
  }

  it('claims a queued job atomically and moves it to running', async () => {
    const { projectId } = await seedProject(db.pool);
    const jobId = await queueJob(projectId, 'T');

    const claimed = await claimNextJob(db.pool, CONTENT_STAGES);
    expect(claimed).toMatchObject({ id: jobId, projectId, stage: 'T' });

    const row = await db.pool.query<{ status: string }>(`SELECT status FROM job WHERE id = $1`, [
      jobId,
    ]);
    expect(row.rows[0]!.status).toBe('running');
  });

  it('filters claims by the worker role stage set', async () => {
    const { projectId } = await seedProject(db.pool);
    await queueJob(projectId, 'T');

    await expect(claimNextJob(db.pool, RENDER_STAGES)).resolves.toBeNull();
    await expect(claimNextJob(db.pool, CONTENT_STAGES)).resolves.not.toBeNull();
  });

  it('returns null when the queue is empty', async () => {
    await expect(claimNextJob(db.pool, CONTENT_STAGES)).resolves.toBeNull();
  });

  it('dispatches a job, marks it succeeded and advances the pipeline', async () => {
    const { projectId } = await seedProject(db.pool);
    const jobId = await queueJob(projectId, 'T');

    const advanced: string[] = [];
    const processed = await runWorkerLoop({
      pool: db.pool,
      stages: CONTENT_STAGES,
      runStage: async (job: ClaimedJob) => ({ status: 'succeeded', message: job.id }),
      advanceAfterStage: async (job: ClaimedJob) => {
        advanced.push(job.id);
      },
      maxJobs: 1,
      pollIntervalMs: 5,
    });

    expect(processed).toBe(1);
    expect(advanced).toEqual([jobId]);
    const row = await db.pool.query<{ status: string }>(`SELECT status FROM job WHERE id = $1`, [
      jobId,
    ]);
    expect(row.rows[0]!.status).toBe('succeeded');
  });

  it('exits immediately without processing when the stop flag is already set', async () => {
    const { projectId } = await seedProject(db.pool);
    await queueJob(projectId, 'T');

    const processed = await runWorkerLoop({
      pool: db.pool,
      stages: CONTENT_STAGES,
      runStage: async () => {
        throw new Error('must not run');
      },
      advanceAfterStage: async () => {},
      shouldStop: () => true,
      maxJobs: 10,
      pollIntervalMs: 5,
    });

    expect(processed).toBe(0);
  });
});
