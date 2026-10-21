/**
 * B-08 acceptance tests, against real Postgres (R-011-2, R-012-1/3/4, US-013).
 *
 * The provider is B-07's deterministic `FakeTtsAdapter` — no network, no paid
 * call, no clock dependence. The database is real because the claims are about
 * constraints and visibility: three `job_attempt` rows, one `generation_run`
 * per call, `charge_status='unknown'` where a call may have billed.
 *
 * Signal (LEAD_PLAN §4 B-08):
 *   - fake 503 series → exactly 3 attempts, then failed;
 *   - 401 fails fast with no requeue;
 *   - a pending run from a dead process is never auto-reissued.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../../tests/helpers/pg.js';
import { seedProject, type SeededProject } from '../../tests/helpers/fixtures.js';
import {
  FakeTtsAdapter,
  TtsTimeoutError,
  asProviderAdapter,
  ttsPromptHash,
  type TtsConvertRequest,
} from '../adapters/tts.js';
import { runMigrations } from '../db/runner.js';
import { openAttempt } from '../domain/generation-run.js';
import {
  heartbeatAttemptLease,
  runAttemptSequence,
  runProviderAttempt,
  type AttemptOutcome,
} from './attempt.js';

const DB_TEST_TIMEOUT_MS = 240_000;
// Each attempt commits a transaction and then re-reads the run on a fresh
// session (B-02's commit guard); on the vendor-embedded Postgres that is a few
// seconds per attempt, so the default 5 s per-test budget is not enough.
vi.setConfig({ testTimeout: 120_000 });
const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[B-08 attempt tests skipped] ${SKIP_REASON}`);

const TTS_REQUEST: TtsConvertRequest = {
  text: 'One short line for the attempt test.',
  voice_id: 'fake-voice',
  model_id: 'fake-tts-model',
};

interface Harness {
  readonly adapter: FakeTtsAdapter;
  readonly request: TtsConvertRequest;
  /** `ProviderAdapter` binding B-07's `convert(request, run)` into the guard. */
  readonly bound: ReturnType<typeof asProviderAdapter>;
}

function harness(failures: readonly number[] = []): Harness {
  const adapter = new FakeTtsAdapter({ rateLimitPerMinute: 600, failures });
  return { adapter, request: TTS_REQUEST, bound: asProviderAdapter(adapter, TTS_REQUEST) };
}

describe.skipIf(!hasDatabase)('provider attempt lifecycle (US-013)', () => {
  let db: TestDatabase;
  let seeded: SeededProject;

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.pool);
  }, DB_TEST_TIMEOUT_MS);

  beforeEach(async () => {
    seeded = await seedProject(db.pool);
  });

  afterAll(async () => {
    await db?.close();
  });

  async function createJob(stage: 'NA' | 'SC' | 'IM', status = 'queued'): Promise<string> {
    const result = await db.pool.query<{ id: string }>(
      `INSERT INTO job (project_id, stage, status) VALUES ($1, $2, $3) RETURNING id`,
      [seeded.projectId, stage, status],
    );
    return result.rows[0]!.id;
  }

  function attemptJob(jobId: string): {
    jobId: string;
    projectId: string;
    stage: 'NA';
    promptHash: string;
  } {
    return {
      jobId,
      projectId: seeded.projectId,
      stage: 'NA',
      promptHash: ttsPromptHash(TTS_REQUEST),
    };
  }

  it('commits the attempt row before the call, then bills a success', async () => {
    const jobId = await createJob('NA');
    const { adapter, bound } = harness();
    const observed: { status: string; charge_status: string }[] = [];

    const probe = {
      provider: bound.provider,
      stage: bound.stage,
      execute: async (run: Parameters<typeof bound.execute>[0]) => {
        const seen = await db.pool.query<{ status: string; charge_status: string }>(
          `SELECT status, charge_status FROM generation_run WHERE id = $1`,
          [run.id],
        );
        observed.push(seen.rows[0]!);
        return bound.execute(run);
      },
    };

    const outcome = await runProviderAttempt(
      { pool: db.pool, adapter: probe },
      { ...attemptJob(jobId), attemptNo: 1 },
    );

    expect(outcome.status).toBe('succeeded');
    expect(outcome.charge).toBe('billed');
    expect(outcome.retry.requeue).toBe(false);
    expect(adapter.calls).toHaveLength(1);

    // The row the adapter could see when it ran was committed and still pending.
    expect(observed).toEqual([{ status: 'pending', charge_status: 'pending' }]);

    const run = await db.pool.query<{
      status: string;
      charge_status: string;
      idempotency_protected: boolean;
      started_at: Date | null;
      ended_at: Date | null;
    }>(`SELECT * FROM generation_run WHERE job_attempt_id IS NOT NULL AND project_id = $1`, [
      seeded.projectId,
    ]);
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0]!.status).toBe('succeeded');
    expect(run.rows[0]!.charge_status).toBe('billed');
    expect(run.rows[0]!.idempotency_protected).toBe(false);
    expect(run.rows[0]!.started_at).not.toBeNull();
    expect(run.rows[0]!.ended_at).not.toBeNull();

    const job = await db.pool.query<{ status: string }>(`SELECT status FROM job WHERE id = $1`, [
      jobId,
    ]);
    expect(job.rows[0]!.status).toBe('succeeded');
  });

  it('fake 503 series → exactly 3 attempts at 1 s / 4 s, then failed with unknown charge', async () => {
    const jobId = await createJob('NA');
    const failures = [503, 503, 503] as const;
    const { adapter, bound } = harness(failures);
    const delays: number[] = [];
    const outcomes: AttemptOutcome[] = [];

    const result = await runAttemptSequence({ pool: db.pool, adapter: bound }, attemptJob(jobId), {
      sleep: async (ms) => {
        delays.push(ms);
      },
      onAttempt: (outcome) => outcomes.push(outcome),
    });

    // Exactly three provider calls, two waits (1 s then 4 s), then failed.
    expect(adapter.calls).toHaveLength(3);
    expect(result.attempts).toHaveLength(3);
    expect(delays).toEqual([1_000, 4_000]);
    expect(outcomes.map((o) => o.attemptNo)).toEqual([1, 2, 3]);
    expect(result.final.status).toBe('failed');
    expect(result.final.failure?.errorClass).toBe('transient');
    expect(result.final.failure?.httpStatus).toBe(503);
    expect(result.final.retry.requeue).toBe(false);

    const attempts = await db.pool.query<{
      attempt_no: number;
      status: string;
      error_class: string | null;
      http_status: number | null;
      backoff_s: number | null;
    }>(
      `SELECT attempt_no, status, error_class, http_status, backoff_s
         FROM job_attempt WHERE job_id = $1 ORDER BY attempt_no ASC`,
      [jobId],
    );
    expect(attempts.rows.map((row) => row.attempt_no)).toEqual([1, 2, 3]);
    expect(attempts.rows.map((row) => row.status)).toEqual([
      'unknown_charge',
      'unknown_charge',
      'unknown_charge',
    ]);
    expect(attempts.rows.map((row) => row.backoff_s)).toEqual([1, 4, 16]);
    expect(attempts.rows.every((row) => row.error_class === 'transient')).toBe(true);
    expect(attempts.rows.every((row) => row.http_status === 503)).toBe(true);

    const runs = await db.pool.query<{
      status: string;
      charge_status: string;
      http_status: number | null;
    }>(
      `SELECT gr.status, gr.charge_status, gr.http_status
         FROM generation_run gr JOIN job_attempt ja ON ja.id = gr.job_attempt_id
        WHERE ja.job_id = $1 ORDER BY ja.attempt_no ASC`,
      [jobId],
    );
    expect(runs.rows).toHaveLength(3); // one row per provider call (R-012-1)
    expect(runs.rows.map((row) => row.status)).toEqual(['failed', 'failed', 'failed']);
    // A 5xx may have been processed: never claim it was unbilled (R-012-4).
    expect(runs.rows.map((row) => row.charge_status)).toEqual(['unknown', 'unknown', 'unknown']);

    const job = await db.pool.query<{ status: string }>(`SELECT status FROM job WHERE id = $1`, [
      jobId,
    ]);
    expect(job.rows[0]!.status).toBe('failed');
  });

  it('401 fails fast: one attempt, no requeue, unbilled', async () => {
    const jobId = await createJob('NA');
    const { adapter, bound } = harness([401, 503, 503]);
    const delays: number[] = [];

    const result = await runAttemptSequence({ pool: db.pool, adapter: bound }, attemptJob(jobId), {
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    expect(adapter.calls).toHaveLength(1);
    expect(delays).toEqual([]);
    expect(result.attempts).toHaveLength(1);
    expect(result.final.failure?.errorClass).toBe('non_retryable');
    expect(result.final.retry.requeue).toBe(false);
    expect(result.final.charge).toBe('unbilled');

    const attempts = await db.pool.query<{
      status: string;
      error_class: string | null;
      http_status: number | null;
      backoff_s: number | null;
    }>(`SELECT status, error_class, http_status, backoff_s FROM job_attempt WHERE job_id = $1`, [
      jobId,
    ]);
    expect(attempts.rows).toHaveLength(1);
    expect(attempts.rows[0]).toEqual({
      status: 'failed',
      error_class: 'non_retryable',
      http_status: 401,
      backoff_s: null,
    });

    const runs = await db.pool.query<{ status: string; charge_status: string }>(
      `SELECT gr.status, gr.charge_status
         FROM generation_run gr JOIN job_attempt ja ON ja.id = gr.job_attempt_id
        WHERE ja.job_id = $1`,
      [jobId],
    );
    expect(runs.rows[0]).toEqual({ status: 'failed', charge_status: 'unbilled' });

    const job = await db.pool.query<{ status: string }>(`SELECT status FROM job WHERE id = $1`, [
      jobId,
    ]);
    expect(job.rows[0]!.status).toBe('failed');
  });

  it('429 is transient but unbilled, then the retry succeeds', async () => {
    const jobId = await createJob('NA');
    const { adapter, bound } = harness([429]);
    const delays: number[] = [];

    const result = await runAttemptSequence({ pool: db.pool, adapter: bound }, attemptJob(jobId), {
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    expect(adapter.calls).toHaveLength(2);
    expect(delays).toEqual([1_000]);
    expect(result.final.status).toBe('succeeded');
    expect(result.final.charge).toBe('billed');
    expect(result.attempts[0]!.charge).toBe('unbilled');

    const runs = await db.pool.query<{ status: string; charge_status: string; attempt_no: number }>(
      `SELECT gr.status, gr.charge_status, ja.attempt_no
         FROM generation_run gr JOIN job_attempt ja ON ja.id = gr.job_attempt_id
        WHERE ja.job_id = $1 ORDER BY ja.attempt_no ASC`,
      [jobId],
    );
    expect(runs.rows).toEqual([
      { status: 'failed', charge_status: 'unbilled', attempt_no: 1 },
      { status: 'succeeded', charge_status: 'billed', attempt_no: 2 },
    ]);
  });

  it('a timeout is unknown charge, never unbilled (R-012-4)', async () => {
    const jobId = await createJob('NA');
    const adapter = {
      provider: 'fake',
      stage: 'NA' as const,
      execute: async () => {
        throw new TtsTimeoutError(120_000);
      },
    };

    const outcome = await runProviderAttempt(
      { pool: db.pool, adapter },
      { ...attemptJob(jobId), attemptNo: 1 },
    );

    expect(outcome.status).toBe('failed');
    expect(outcome.charge).toBe('unknown');
    expect(outcome.failure?.timedOut).toBe(true);
    expect(outcome.retry.requeue).toBe(true);

    const run = await db.pool.query<{ status: string; charge_status: string }>(
      `SELECT gr.status, gr.charge_status
         FROM generation_run gr JOIN job_attempt ja ON ja.id = gr.job_attempt_id
        WHERE ja.job_id = $1`,
      [jobId],
    );
    expect(run.rows[0]).toEqual({ status: 'timed_out', charge_status: 'unknown' });
  });

  it('never reissues a pending run left by a dead process', async () => {
    const jobId = await createJob('NA', 'running');
    const { adapter, bound } = harness();

    // The crash residue: the attempt row and its run were committed and the
    // process died before the outcome could be recorded.
    const crashed = await openAttempt(db.pool, {
      jobId,
      attemptNo: 1,
      projectId: seeded.projectId,
      stage: 'NA',
      provider: 'fake',
      promptHash: ttsPromptHash(TTS_REQUEST),
      workerId: 'killed-worker',
    });

    const outcome = await runProviderAttempt(
      { pool: db.pool, adapter: bound },
      { ...attemptJob(jobId), attemptNo: 2 },
    );

    // The adapter is never reached: at most one billable request (R-012-3).
    expect(adapter.calls).toHaveLength(0);
    expect(outcome.status).toBe('failed');
    expect(outcome.runId).toBeNull();
    expect(outcome.charge).toBe('unknown');
    expect(outcome.retry.requeue).toBe(false);

    const run = await db.pool.query<{ status: string; charge_status: string }>(
      `SELECT status, charge_status FROM generation_run WHERE id = $1`,
      [crashed.id],
    );
    expect(run.rows[0]).toEqual({ status: 'unknown', charge_status: 'unknown' });

    const attempts = await db.pool.query<{ attempt_no: number; status: string }>(
      `SELECT attempt_no, status FROM job_attempt WHERE job_id = $1 ORDER BY attempt_no ASC`,
      [jobId],
    );
    expect(attempts.rows).toEqual([{ attempt_no: 1, status: 'unknown_charge' }]);

    const job = await db.pool.query<{ status: string }>(`SELECT status FROM job WHERE id = $1`, [
      jobId,
    ]);
    expect(job.rows[0]!.status).toBe('failed');
  });

  it('heartbeats the lease while the attempt is open and stops once it closes', async () => {
    const jobId = await createJob('NA', 'running');
    const open = await openAttempt(db.pool, {
      jobId,
      attemptNo: 1,
      projectId: seeded.projectId,
      stage: 'NA',
      promptHash: ttsPromptHash(TTS_REQUEST),
      workerId: 'worker-1',
    });

    expect(await heartbeatAttemptLease(db.pool, open.jobAttemptId)).toBe(true);
    const beat = await db.pool.query<{ heartbeat_at: Date | null }>(
      `SELECT heartbeat_at FROM job_attempt WHERE id = $1`,
      [open.jobAttemptId],
    );
    expect(beat.rows[0]!.heartbeat_at).not.toBeNull();

    await db.pool.query(`UPDATE job_attempt SET status = 'succeeded' WHERE id = $1`, [
      open.jobAttemptId,
    ]);
    expect(await heartbeatAttemptLease(db.pool, open.jobAttemptId)).toBe(false);
  });
});
