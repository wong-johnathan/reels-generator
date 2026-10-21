/**
 * B-08 reconciler tests (TECH_DESIGN §7.4, R-023, R-012-3/4; US-013, US-031).
 *
 * The forced-kill case is exercised against real Postgres because the claim is
 * about persisted state: a `pending` generation_run must become `unknown` and
 * the job must fail — the provider adapter must not be called again.
 *
 * Signal: "forced-kill resume never auto-reissues a pending run".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../../tests/helpers/pg.js';
import { seedProject, type SeededProject } from '../../tests/helpers/fixtures.js';
import { runMigrations } from '../db/runner.js';
import { openAttempt } from '../domain/generation-run.js';
import { DEFAULT_LEASE_TTL_SECONDS, reconcileStalledJobs } from './reconciler.js';
import type { EnqueuePort, EnqueueRequest } from './queues.js';

const DB_TEST_TIMEOUT_MS = 240_000;
vi.setConfig({ testTimeout: 120_000 });

const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[B-08 reconciler tests skipped] ${SKIP_REASON}`);

/** Records every enqueue and can observe the row at enqueue time. */
class RecordingEnqueuer implements EnqueuePort {
  readonly requests: EnqueueRequest[] = [];
  onEnqueue?: (request: EnqueueRequest) => Promise<void> | void;

  async enqueue(request: EnqueueRequest): Promise<void> {
    await this.onEnqueue?.(request);
    this.requests.push(request);
  }
}

describe.skipIf(!hasDatabase)('reconciler (R-023, R-012-3)', () => {
  let db: TestDatabase;
  let seeded: SeededProject;

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.pool);
  }, DB_TEST_TIMEOUT_MS);

  beforeEach(async () => {
    // Prior tests may leave queued jobs behind; cancel them so every reconcile
    // in this file sees exactly the job the test seeded.
    await db.pool.query(`UPDATE job SET status = 'cancelled' WHERE status IN ('queued','running')`);
    seeded = await seedProject(db.pool);
  });

  afterAll(async () => {
    await db?.close();
  });

  async function createStaleJob(
    stage: 'NA' | 'RE' | 'FA',
    status: 'queued' | 'running',
  ): Promise<string> {
    const result = await db.pool.query<{ id: string }>(
      `INSERT INTO job (project_id, stage, status, updated_at)
       VALUES ($1, $2, $3, now() - make_interval(secs => 600)) RETURNING id`,
      [seeded.projectId, stage, status],
    );
    return result.rows[0]!.id;
  }

  async function insertAttempt(
    jobId: string,
    attemptNo: number,
    status: 'pending' | 'running' | 'failed' | 'succeeded',
    heartbeatSecondsAgo: number | null = null,
  ): Promise<string> {
    const result = await db.pool.query<{ id: string }>(
      `INSERT INTO job_attempt (job_id, attempt_no, status, started_at, heartbeat_at)
       VALUES ($1, $2, $3, now() - make_interval(secs => 600),
               CASE WHEN $4::int IS NULL THEN NULL
                    ELSE now() - make_interval(secs => $4::int) END)
       RETURNING id`,
      [jobId, attemptNo, status, heartbeatSecondsAgo],
    );
    return result.rows[0]!.id;
  }

  it('forced-kill mid-call: marks the run unknown charge, fails the job, enqueues nothing', async () => {
    const jobId = await createStaleJob('NA', 'running');
    const enqueuer = new RecordingEnqueuer();

    // The kill happened between COMMIT and outcome: attempt + run are pending.
    const crashed = await openAttempt(db.pool, {
      jobId,
      attemptNo: 1,
      projectId: seeded.projectId,
      stage: 'NA',
      provider: 'fake',
      promptHash: 'sha256:crash',
      workerId: 'killed-worker',
    });

    const report = await reconcileStalledJobs({ pool: db.pool, enqueuer });

    expect(report.scanned).toBe(1);
    expect(report.failedUnknownCharge).toBe(1);
    expect(report.requeued).toBe(0);
    expect(report.unknownChargeRunIds).toEqual([crashed.id]);
    // The load-bearing assertion: no job was handed to the queue, so the
    // provider call cannot be reissued (≤1 billable request, R-012-3).
    expect(enqueuer.requests).toEqual([]);
    expect(report.jobs[0]?.decision).toBe('failed_unknown_charge');

    const run = await db.pool.query<{ status: string; charge_status: string }>(
      `SELECT status, charge_status FROM generation_run WHERE id = $1`,
      [crashed.id],
    );
    expect(run.rows[0]).toEqual({ status: 'unknown', charge_status: 'unknown' });

    const attempt = await db.pool.query<{ status: string }>(
      `SELECT status FROM job_attempt WHERE id = $1`,
      [crashed.jobAttemptId],
    );
    expect(attempt.rows[0]!.status).toBe('unknown_charge');

    const job = await db.pool.query<{ status: string }>(`SELECT status FROM job WHERE id = $1`, [
      jobId,
    ]);
    expect(job.rows[0]!.status).toBe('failed');
  });

  it('resumes a stale job with no in-flight call exactly once, at the next attempt', async () => {
    const jobId = await createStaleJob('NA', 'running');
    const attemptId = await insertAttempt(jobId, 1, 'running');
    const enqueuer = new RecordingEnqueuer();

    const report = await reconcileStalledJobs({ pool: db.pool, enqueuer });

    expect(report.scanned).toBe(1);
    expect(report.requeued).toBe(1);
    expect(report.failedUnknownCharge).toBe(0);
    expect(enqueuer.requests).toEqual([
      {
        jobId,
        projectId: seeded.projectId,
        stage: 'NA',
        attemptNo: 2,
        reason: 'resume',
      },
    ]);

    const job = await db.pool.query<{ status: string }>(`SELECT status FROM job WHERE id = $1`, [
      jobId,
    ]);
    expect(job.rows[0]!.status).toBe('queued');

    const attempt = await db.pool.query<{
      status: string;
      error_class: string | null;
      finished_at: Date | null;
    }>(`SELECT status, error_class, finished_at FROM job_attempt WHERE id = $1`, [attemptId]);
    expect(attempt.rows[0]!.status).toBe('failed');
    expect(attempt.rows[0]!.error_class).toBe('transient');
    expect(attempt.rows[0]!.finished_at).not.toBeNull();

    // A second tick must not enqueue the same work again: the job is fresh now.
    const second = await reconcileStalledJobs({ pool: db.pool, enqueuer });
    expect(second.scanned).toBe(0);
    expect(enqueuer.requests).toHaveLength(1);
  });

  it('leaves a job alone while its heartbeat is live', async () => {
    const jobId = await createStaleJob('NA', 'running');
    await db.pool.query(`UPDATE job SET updated_at = now() WHERE id = $1`, [jobId]);
    await insertAttempt(jobId, 1, 'running', 0);
    const enqueuer = new RecordingEnqueuer();

    const report = await reconcileStalledJobs({ pool: db.pool, enqueuer });

    expect(report.scanned).toBe(0);
    expect(enqueuer.requests).toEqual([]);
  });

  it('fails a job whose three attempts are exhausted instead of re-running it', async () => {
    const jobId = await createStaleJob('NA', 'running');
    await insertAttempt(jobId, 1, 'failed', 3_600);
    await insertAttempt(jobId, 2, 'failed', 3_600);
    await insertAttempt(jobId, 3, 'failed', 3_600);
    const enqueuer = new RecordingEnqueuer();

    const report = await reconcileStalledJobs({ pool: db.pool, enqueuer });

    expect(report.failedAttemptsExhausted).toBe(1);
    expect(report.requeued).toBe(0);
    expect(enqueuer.requests).toEqual([]);

    const job = await db.pool.query<{ status: string }>(`SELECT status FROM job WHERE id = $1`, [
      jobId,
    ]);
    expect(job.rows[0]!.status).toBe('failed');
  });

  it('stores the retry scope on the row before enqueueing (R-022-2)', async () => {
    const jobId = await createStaleJob('NA', 'running');
    await insertAttempt(jobId, 1, 'failed', 3_600);
    const scope = { stage: 'NA', will_run: [{ stage: 'NA', calls: { tts: 1 } }], will_not_run: [] };
    const observedAtEnqueue: unknown[] = [];
    const enqueuer = new RecordingEnqueuer();
    enqueuer.onEnqueue = async () => {
      const row = await db.pool.query<{ retry_scope: unknown }>(
        `SELECT retry_scope FROM job WHERE id = $1`,
        [jobId],
      );
      observedAtEnqueue.push(row.rows[0]!.retry_scope);
    };

    const report = await reconcileStalledJobs({
      pool: db.pool,
      enqueuer,
      retryScopeFor: () => scope,
    });

    expect(report.requeued).toBe(1);
    expect(observedAtEnqueue).toEqual([scope]);

    const stored = await db.pool.query<{ retry_scope: unknown }>(
      `SELECT retry_scope FROM job WHERE id = $1`,
      [jobId],
    );
    expect(stored.rows[0]!.retry_scope).toEqual(scope);
  });

  it('never enqueues the FA operator gate', async () => {
    const jobId = await createStaleJob('FA', 'queued');
    const enqueuer = new RecordingEnqueuer();

    const report = await reconcileStalledJobs({ pool: db.pool, enqueuer });

    expect(report.jobs[0]?.decision).toBe('failed_not_queueable');
    expect(enqueuer.requests).toEqual([]);

    const job = await db.pool.query<{ status: string }>(`SELECT status FROM job WHERE id = $1`, [
      jobId,
    ]);
    expect(job.rows[0]!.status).toBe('failed');
  });

  it('uses a 60 s lease by default (twelve missed 5 s heartbeats)', () => {
    expect(DEFAULT_LEASE_TTL_SECONDS).toBe(60);
  });
});
