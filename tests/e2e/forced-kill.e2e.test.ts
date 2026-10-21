/**
 * QA-owned e2e case #1 — forced kill between the provider call and asset
 * persistence (Milestone A exit criterion; US-013, R-012-3).
 *
 * Unlike `src/workers/reconciler.test.ts` (which constructs the crashed state
 * with INSERTs), this suite runs the real attempt path in a **separate OS
 * process** and kills it with SIGKILL while the provider request is in flight:
 *
 *   1. the child calls `runProviderAttempt`, which commits the `job_attempt` +
 *      `generation_run` pair before the adapter may open a socket (R-012-1);
 *   2. the adapter POSTs to a loopback fake provider, which records the request
 *      and deliberately never answers;
 *   3. the parent SIGKILLs the child in that window — provider called, no asset
 *      persisted, no outcome written;
 *   4. the parent runs the startup reconciler, which is the resume path a
 *      restarted worker takes;
 *   5. the assertions are the requirement's own words: exactly **1** billable
 *      request reached the provider, and the attempt is recorded as
 *      **unknown charge**.
 *
 * No network egress and no paid provider: the "provider" is an http.Server on
 * 127.0.0.1 that counts requests.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../src/db/runner.js';
import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../helpers/pg.js';
import { seedProject, type SeededProject } from '../helpers/fixtures.js';
import { reconcileStalledJobs } from '../../src/workers/reconciler.js';
import type { EnqueuePort, EnqueueRequest } from '../../src/workers/queues.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[QA e2e forced-kill skipped] ${SKIP_REASON}`);

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TSX_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CHILD = join(REPO_ROOT, 'tests', 'e2e', 'fixtures', 'forced-kill-child.ts');

/** Records every enqueue the reconciler attempts; must stay empty. */
class RecordingEnqueuer implements EnqueuePort {
  readonly requests: EnqueueRequest[] = [];

  async enqueue(request: EnqueueRequest): Promise<void> {
    this.requests.push(request);
  }
}

/** A loopback provider that counts requests and never answers. */
interface FakeProvider {
  readonly url: string;
  readonly requests: readonly { readonly body: string }[];
  /** Resolves the first time a request body has been fully received. */
  readonly firstRequest: Promise<void>;
  readonly server: Server;
}

async function startFakeProvider(): Promise<FakeProvider> {
  const requests: { body: string }[] = [];
  let release: () => void = () => undefined;
  const firstRequest = new Promise<void>((resolve) => {
    release = resolve;
  });

  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      requests.push({ body });
      release();
      // Deliberately no response: the child must still be inside the call when
      // SIGKILL arrives. The socket dies with the client.
      void response;
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/v1/images`,
    get requests() {
      return requests;
    },
    firstRequest,
    server,
  };
}

interface ChildRun {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function startChild(env: Record<string, string>): ChildRun {
  const child = spawn(TSX_BIN, [CHILD], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, stdout: () => stdout, stderr: () => stderr, exited };
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

describe.skipIf(!hasDatabase)('QA e2e #1 — forced kill mid-call (US-013, R-012-3)', () => {
  let db: TestDatabase;
  let seeded: SeededProject;
  let provider: FakeProvider | undefined;
  let run: ChildRun | undefined;

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.pool);
  });

  afterEach(async () => {
    if (run !== undefined && run.child.exitCode === null && run.child.signalCode === null) {
      run.child.kill('SIGKILL');
      await run.exited;
    }
    run = undefined;
    if (provider !== undefined) {
      await closeServer(provider.server);
      provider = undefined;
    }
  });

  afterAll(async () => {
    await db?.close();
  });

  async function seedImageJob(pool: Pool): Promise<string> {
    seeded = await seedProject(pool);
    // seedProject adds a running "T" job; cancel it so the scan sees only this test's job.
    await pool.query(`UPDATE job SET status = 'cancelled' WHERE project_id = $1`, [
      seeded.projectId,
    ]);
    const job = await pool.query<{ id: string }>(
      `INSERT INTO job (project_id, stage, status) VALUES ($1, 'IM', 'queued') RETURNING id`,
      [seeded.projectId],
    );
    return job.rows[0]!.id;
  }

  it('resumes with exactly 1 billable request and records unknown charge', async () => {
    const jobId = await seedImageJob(db.pool);
    provider = await startFakeProvider();
    const fakeProvider = provider;

    run = startChild({
      DATABASE_URL: db.url,
      FAKE_PROVIDER_URL: fakeProvider.url,
      JOB_ID: jobId,
      PROJECT_ID: seeded.projectId,
    });
    const childRun = run;

    // The provider saw the request: the attempt row is committed and the call is
    // in flight. Wait for the body, then kill without letting it answer.
    await Promise.race([
      fakeProvider.firstRequest,
      childRun.exited.then((seen) => {
        const detail = [
          `child exited before the provider call (code ${String(seen.code)}, signal ${String(seen.signal)})`,
          `stdout:\n${childRun.stdout()}`,
          `stderr:\n${childRun.stderr()}`,
        ].join('\n');
        throw new Error(detail);
      }),
    ]);

    childRun.child.kill('SIGKILL');
    const exit = await childRun.exited;

    expect(exit.signal).toBe('SIGKILL');
    expect(childRun.stdout()).not.toContain('CALL_RETURNED');
    expect(childRun.stdout()).not.toContain('PERSISTING_ASSET');
    expect(childRun.stdout()).not.toContain('OUTCOME');

    // Pre-resume state: a committed run with no outcome and no asset.
    const runRows = await db.pool.query<{
      id: string;
      status: string;
      charge_status: string;
      provider_request_id: string | null;
      started_at: Date | null;
    }>(`SELECT id, status, charge_status, provider_request_id, started_at FROM generation_run`);
    expect(runRows.rowCount).toBe(1);
    const killed = runRows.rows[0]!;
    expect(killed.status).toBe('pending');
    expect(killed.charge_status).toBe('pending');
    expect(killed.provider_request_id).toBeNull();
    expect(killed.started_at).not.toBeNull();

    const assetsBefore = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM asset WHERE project_id = $1`,
      [seeded.projectId],
    );
    expect(assetsBefore.rows[0]!.n).toBe(0);

    // Resume: the reconciler is what a restarted worker runs at startup. The
    // clock is moved past the lease TTL rather than waiting for it.
    const enqueuer = new RecordingEnqueuer();
    const report = await reconcileStalledJobs({
      pool: db.pool,
      enqueuer,
      now: new Date(Date.now() + 3_600_000),
    });

    expect(report.scanned).toBe(1);
    expect(report.failedUnknownCharge).toBe(1);
    expect(report.requeued).toBe(0);
    expect(report.unknownChargeRunIds).toEqual([killed.id]);
    expect(report.jobs[0]?.decision).toBe('failed_unknown_charge');
    // The load-bearing assertion: nothing was handed back to the queue, so the
    // provider call cannot be reissued.
    expect(enqueuer.requests).toEqual([]);

    // R-012-4: the attempt is recorded as unknown charge, never unbilled.
    const after = await db.pool.query<{ status: string; charge_status: string }>(
      `SELECT status, charge_status FROM generation_run WHERE id = $1`,
      [killed.id],
    );
    expect(after.rows[0]).toEqual({ status: 'unknown', charge_status: 'unknown' });

    const attempt = await db.pool.query<{ status: string }>(
      `SELECT status FROM job_attempt WHERE job_id = $1`,
      [jobId],
    );
    expect(attempt.rows[0]!.status).toBe('unknown_charge');

    const job = await db.pool.query<{ status: string }>(`SELECT status FROM job WHERE id = $1`, [
      jobId,
    ]);
    expect(job.rows[0]!.status).toBe('failed');

    // Exactly one billable request, before and after the resume.
    expect(fakeProvider.requests.length).toBe(1);

    // A second reconcile (worker restarted twice) must not change that.
    const second = await reconcileStalledJobs({
      pool: db.pool,
      enqueuer,
      now: new Date(Date.now() + 3_600_000),
    });
    expect(second.scanned).toBe(0);
    expect(enqueuer.requests).toEqual([]);
    expect(fakeProvider.requests.length).toBe(1);
  });
});
