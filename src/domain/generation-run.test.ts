import { createServer, connect, type AddressInfo, type Server } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { seedProject, type SeededProject } from '../../tests/helpers/fixtures.js';
import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  withSecondConnection,
  type TestDatabase,
} from '../../tests/helpers/pg.js';
import { runMigrations } from '../db/runner.js';
import {
  AdapterStageMismatchError,
  executePersisted,
  GenerationRunNotCommittedError,
  openAttempt,
  type PersistedGenerationRun,
  type ProviderAdapter,
} from './generation-run.js';

/**
 * B-02 Signal: the two-connection test proves a committed `generation_run` id
 * exists before any adapter socket (TECH_DESIGN §3.5, R-012-1).
 *
 * "Socket" is literal here: the fake provider is a real loopback TCP server.
 * The adapter records, per call, (a) whether a *separate* database session sees
 * the run row and (b) when the provider socket was accepted. The assertion is
 * ordering plus visibility, not the adapter's good intentions.
 */
const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[attempt-guard tests skipped] ${SKIP_REASON}`);

interface Observation {
  readonly runId: string;
  readonly visibleOnSecondConnection: boolean;
  readonly verifiedOnBackendPid: number;
  readonly observedAtMs: number;
  readonly socketAcceptedAtMs: number;
}

/** A loopback stand-in for a provider endpoint. It counts accepted sockets. */
class FakeProviderSocket {
  private server: Server | null = null;
  readonly acceptedAtMs: number[] = [];
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((socket) => {
      this.acceptedAtMs.push(Date.now());
      socket.end('{"fake":"provider","ok":true}');
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    this.port = (this.server!.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = null;
  }

  get connections(): number {
    return this.acceptedAtMs.length;
  }
}

function callProvider(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let body = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      body += chunk;
    });
    socket.on('end', () => resolve(body));
    socket.on('error', reject);
  });
}

class RecordingAdapter implements ProviderAdapter<{ readonly message: string }> {
  readonly provider = 'fake-provider';
  readonly stage = 'T' as const;
  readonly observations: Observation[] = [];

  constructor(
    private readonly pool: TestDatabase['pool'],
    private readonly socketServer: FakeProviderSocket,
  ) {}

  async execute(run: PersistedGenerationRun): Promise<{ readonly message: string }> {
    // 1. A separate session — never part of the pool that wrote the row — looks for it.
    const { visibleOnSecondConnection, verifiedOnBackendPid } = await withSecondConnection(
      this.pool,
      async (client) => {
        const pid = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const row = await client.query('SELECT 1 FROM generation_run WHERE id = $1', [run.id]);
        return {
          visibleOnSecondConnection: (row.rowCount ?? 0) === 1,
          verifiedOnBackendPid: pid.rows[0]!.pid,
        };
      },
    );
    const observedAtMs = Date.now();

    // 2. Only now does the provider socket open.
    const body = await callProvider(this.socketServer.port);
    this.observations.push({
      runId: run.id,
      visibleOnSecondConnection,
      verifiedOnBackendPid,
      observedAtMs,
      socketAcceptedAtMs: this.socketServer.acceptedAtMs.at(-1) ?? 0,
    });
    return { message: body };
  }
}

// DDL commits per statement, so a single migrate run on a slow disk takes tens
// of seconds; a generous timeout keeps the assertion about ordering, not speed.
const DB_TEST_TIMEOUT_MS = 120_000;

describe.skipIf(!hasDatabase)(
  'attempt row before provider call (TECH_DESIGN §3.5)',
  { timeout: DB_TEST_TIMEOUT_MS },
  () => {
    let db: TestDatabase;
    let seeded: SeededProject;
    let provider: FakeProviderSocket;

    beforeAll(async () => {
      db = await createTestDatabase();
      await runMigrations(db.pool);
      provider = new FakeProviderSocket();
      await provider.start();
    }, DB_TEST_TIMEOUT_MS);

    beforeEach(async () => {
      // Each test seeds its own project chain so counts are unambiguous.
      seeded = await seedProject(db.pool);
    });

    afterAll(async () => {
      await provider.stop();
      await db.close();
    }, DB_TEST_TIMEOUT_MS);

    it('commits generation_run and job_attempt together, pending on both, before the adapter exists', async () => {
      const run = await openAttempt(db.pool, {
        jobId: seeded.jobId,
        attemptNo: 1,
        projectId: seeded.projectId,
        stage: 'T',
        provider: 'fake-provider',
        model: 'fake-model',
        promptHash: 'prompt-hash-1',
        seriesVersionId: seeded.seriesVersionId,
      });

      expect(run.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(run.status).toBe('pending');
      expect(run.chargeStatus).toBe('pending');
      expect(run.idempotencyProtected).toBe(false);
      expect(run.committedAt).toBeInstanceOf(Date);

      // Read it back on a session that never wrote it: the row is committed, not merely inserted.
      await withSecondConnection(db.pool, async (verifier) => {
        const pid = await verifier.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        expect(pid.rows[0]!.pid).not.toBe(run.committedByBackendPid);

        const row = await verifier.query<{
          status: string;
          charge_status: string;
          idempotency_protected: boolean;
          created_at: Date;
        }>(
          `SELECT status, charge_status, idempotency_protected, created_at
           FROM generation_run WHERE id = $1`,
          [run.id],
        );
        expect(row.rowCount).toBe(1);
        expect(row.rows[0]).toMatchObject({
          status: 'pending',
          charge_status: 'pending',
          idempotency_protected: false,
        });
        expect(row.rows[0]!.created_at).toBeInstanceOf(Date);

        const attempt = await verifier.query<{ attempt_no: number; status: string }>(
          `SELECT attempt_no, status FROM job_attempt WHERE id = $1`,
          [run.jobAttemptId],
        );
        expect(attempt.rows[0]).toEqual({ attempt_no: 1, status: 'pending' });
      });
    });

    it('opens the provider socket only after the run id is visible to a second connection', async () => {
      const run = await openAttempt(db.pool, {
        jobId: seeded.jobId,
        attemptNo: 1,
        projectId: seeded.projectId,
        stage: 'T',
        provider: 'fake-provider',
        model: 'fake-model',
        promptHash: 'prompt-hash-2',
        seriesVersionId: seeded.seriesVersionId,
      });
      const adapter = new RecordingAdapter(db.pool, provider);
      const connectionsBefore = provider.connections;

      const result = await executePersisted({ pool: db.pool }, adapter, run);

      expect(result.message).toContain('"ok":true');
      expect(provider.connections - connectionsBefore).toBe(1);
      expect(adapter.observations).toHaveLength(1);

      const observation = adapter.observations[0]!;
      expect(observation.runId).toBe(run.id);
      expect(observation.visibleOnSecondConnection).toBe(true);
      expect(observation.verifiedOnBackendPid).not.toBe(run.committedByBackendPid);
      expect(observation.observedAtMs).toBeLessThanOrEqual(observation.socketAcceptedAtMs);
    });

    it('refuses to call the adapter when the run was never committed', async () => {
      const forged = {
        id: '00000000-0000-4000-8000-000000000000',
        committedByBackendPid: 0,
        stage: 'T',
      } as unknown as PersistedGenerationRun;
      const adapter = new RecordingAdapter(db.pool, provider);
      const connectionsBefore = provider.connections;

      await expect(executePersisted({ pool: db.pool }, adapter, forged)).rejects.toBeInstanceOf(
        GenerationRunNotCommittedError,
      );
      expect(provider.connections).toBe(connectionsBefore);
      expect(adapter.observations).toHaveLength(0);
    });

    it('refuses to call the adapter when the committed row is gone (deleted after commit)', async () => {
      const run = await openAttempt(db.pool, {
        jobId: seeded.jobId,
        attemptNo: 1,
        projectId: seeded.projectId,
        stage: 'T',
        provider: 'fake-provider',
        model: 'fake-model',
        promptHash: 'prompt-hash-3',
        seriesVersionId: seeded.seriesVersionId,
      });
      await db.pool.query('DELETE FROM generation_run WHERE id = $1', [run.id]);
      const adapter = new RecordingAdapter(db.pool, provider);
      const connectionsBefore = provider.connections;

      await expect(executePersisted({ pool: db.pool }, adapter, run)).rejects.toBeInstanceOf(
        GenerationRunNotCommittedError,
      );
      expect(provider.connections).toBe(connectionsBefore);
    });

    it('rolls back both rows when the attempt cannot be written', async () => {
      const before = await db.pool.query<{ runs: string; attempts: string }>(
        `SELECT (SELECT count(*)::text FROM generation_run) AS runs,
              (SELECT count(*)::text FROM job_attempt) AS attempts`,
      );

      await expect(
        openAttempt(db.pool, {
          jobId: seeded.jobId,
          // 0 is illegal in both ledgers. Attempt 4 is *legal* since M-010: an
          // operator retry may exceed R-011-2's automatic budget, so the old
          // "4 is invalid" example stopped testing the rollback at all.
          attemptNo: 0,
          projectId: seeded.projectId,
          stage: 'T',
          provider: 'fake-provider',
          model: 'fake-model',
          promptHash: 'prompt-hash-4',
          seriesVersionId: seeded.seriesVersionId,
        }),
      ).rejects.toThrow(/attempt_no/);

      const after = await db.pool.query<{ runs: string; attempts: string }>(
        `SELECT (SELECT count(*)::text FROM generation_run) AS runs,
              (SELECT count(*)::text FROM job_attempt) AS attempts`,
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
    });

    it('rejects an adapter registered for a different stage than the run', async () => {
      const run = await openAttempt(db.pool, {
        jobId: seeded.jobId,
        attemptNo: 1,
        projectId: seeded.projectId,
        stage: 'T',
        provider: 'fake-provider',
        model: 'fake-model',
        promptHash: 'prompt-hash-5',
        seriesVersionId: seeded.seriesVersionId,
      });
      const wrongStageAdapter: ProviderAdapter<never> = {
        provider: 'fake-provider',
        stage: 'IM',
        execute: () => {
          throw new Error('the adapter must not be called');
        },
      };
      const connectionsBefore = provider.connections;

      await expect(
        executePersisted({ pool: db.pool }, wrongStageAdapter, run),
      ).rejects.toBeInstanceOf(AdapterStageMismatchError);
      expect(provider.connections).toBe(connectionsBefore);
    });

    it('cannot be handed a plain row literal (the persisted run is a distinct type)', () => {
      const adapter: ProviderAdapter<never> = {
        provider: 'fake-provider',
        stage: 'T',
        execute: () => {
          throw new Error('not called');
        },
      };
      const call = () =>
        // @ts-expect-error a plain object is not a PersistedGenerationRun: only openAttempt produces one
        executePersisted({ pool: db.pool }, adapter, { id: 'not-a-persisted-run', stage: 'T' });
      expect(call).toBeTypeOf('function');
    });
  },
);
