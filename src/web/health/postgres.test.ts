import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AttemptRowSchema,
  HealthReportSchema,
  ProviderSettingsViewSchema,
} from '../../../contract/api.js';
import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../../../tests/helpers/pg.js';
import { seedProject, sha256For } from '../../../tests/helpers/web-gateway-seed.js';
import { runMigrations } from '../../db/runner.js';
import { createPostgresOpsGateway } from './postgres.js';

const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[ops gateway tests skipped] ${SKIP_REASON}`);

const DB_TEST_TIMEOUT_MS = 120_000;

interface AttemptSeed {
  readonly stage: string;
  readonly provider: string;
  readonly model: string;
  readonly createdAt: Date;
  readonly chargeStatus?: string;
  readonly attemptStatus?: string;
  readonly attemptNo?: number;
  readonly backoffS?: number | null;
}

describe.skipIf(!hasDatabase)('Postgres OpsGateway', { timeout: DB_TEST_TIMEOUT_MS }, () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.pool);
  }, DB_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await db?.close();
  });

  async function seedAttempt(projectId: string, input: AttemptSeed): Promise<string> {
    const job = await db.pool.query<{ id: string }>(
      `INSERT INTO job (project_id, stage, status) VALUES ($1, $2, 'succeeded') RETURNING id`,
      [projectId, input.stage],
    );
    const attempt = await db.pool.query<{ id: string }>(
      `INSERT INTO job_attempt (job_id, attempt_no, status, started_at, finished_at, backoff_s, created_at)
         VALUES ($1, $2, $3, $4, $4, $5, $4)
         RETURNING id`,
      [
        job.rows[0]!.id,
        input.attemptNo ?? 1,
        input.attemptStatus ?? 'succeeded',
        input.createdAt,
        input.backoffS ?? null,
      ],
    );
    const run = await db.pool.query<{ id: string }>(
      `INSERT INTO generation_run
           (job_attempt_id, project_id, stage, provider, model, prompt_hash, provider_request_id,
            idempotency_protected, charge_status, status, error_class, http_status, attempt_no,
            created_at, started_at, ended_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14, $14)
         RETURNING id`,
      [
        attempt.rows[0]!.id,
        projectId,
        input.stage,
        input.provider,
        input.model,
        sha256For('prompt-' + input.stage + '-' + input.createdAt.toISOString()),
        'req-' + input.stage,
        false,
        input.chargeStatus ?? 'billed',
        'succeeded',
        null,
        200,
        input.attemptNo ?? 1,
        input.createdAt,
      ],
    );
    return run.rows[0]!.id;
  }

  it('reports a schema-valid health summary from the migration and job ledgers', async () => {
    const gateway = createPostgresOpsGateway(db.pool, {
      now: () => Date.UTC(2026, 9, 20, 9, 41, 12),
    });

    const report = await gateway.health();

    expect(HealthReportSchema.safeParse(report).success).toBe(true);
    expect(report.ready).toBe(true);
    expect(report.service).toBe('web');
    expect(report.checked_at).toBe('2026-10-20T09:41:12.000Z');
    expect(report.migration.status).toBe('up_to_date');
    expect(report.migration.version).toBe('M-006');
    expect(report.components.find((component) => component.name === 'postgres')?.status).toBe('ok');
    expect(report.providers).toHaveLength(3);
    for (const provider of report.providers) {
      // No credential in this environment; the check must not claim one.
      expect(provider.key_present).toBe(false);
      expect(provider.idempotency_protected).toBe(false);
      expect(provider.qualified).toBe(false);
    }
    expect(report.disk).toBeNull();
    expect(report.queue).toEqual({ waiting: 0, active: 0, failed: 0 });
  });

  it('reports provider qualification from the ledger and never a key value', async () => {
    await db.pool.query(
      `INSERT INTO provider_qualification (provider, adapter, passed, run_at)
         VALUES ('deepseek', 'text.deepseek.chat', true, '2026-10-19T10:00:00Z')`,
    );
    // A configured credential is an environment fact: the page must say so even
    // though no column exists for it.
    const gateway = createPostgresOpsGateway(db.pool, { keyPresent: () => true });

    const settings = await gateway.settings();

    expect(ProviderSettingsViewSchema.safeParse(settings).success).toBe(true);
    expect(settings.read_only).toBe(true);
    expect(settings.key_values_exposed).toBe(false);
    const deepseek = settings.providers.find((provider) => provider.provider === 'deepseek');
    expect(deepseek?.qualified).toBe(true);
    expect(deepseek?.qualified_at).toBe('2026-10-19T10:00:00.000Z');
    expect(deepseek?.key_present).toBe(true);
  });

  it('returns no attempt rows for a project with none', async () => {
    const { projectId } = await seedProject(db.pool, { slug: 'ops-attempts-empty' });
    const gateway = createPostgresOpsGateway(db.pool);

    await expect(gateway.attempts(projectId, { stage: null, limit: 50 })).resolves.toEqual([]);
  });

  it('maps attempt rows newest-first, filtered by stage and limit', async () => {
    const { projectId } = await seedProject(db.pool, { slug: 'ops-attempts' });
    await seedAttempt(projectId, {
      stage: 'T',
      provider: 'deepseek',
      model: 'deepseek-chat',
      createdAt: new Date('2026-10-20T09:00:00Z'),
      attemptNo: 1,
    });
    await seedAttempt(projectId, {
      stage: 'IM',
      provider: 'gemini',
      model: 'imagen-3',
      createdAt: new Date('2026-10-20T09:30:00Z'),
      attemptNo: 1,
    });
    await seedAttempt(projectId, {
      stage: 'T',
      provider: 'deepseek',
      model: 'deepseek-chat',
      createdAt: new Date('2026-10-20T10:00:00Z'),
      attemptNo: 2,
      backoffS: 4,
      chargeStatus: 'unbilled',
    });

    const gateway = createPostgresOpsGateway(db.pool);

    const all = await gateway.attempts(projectId, { stage: null, limit: 50 });
    expect(all).toHaveLength(3);
    expect(all[0]!.created_at).toBe('2026-10-20T10:00:00.000Z');
    expect(all[2]!.created_at).toBe('2026-10-20T09:00:00.000Z');

    for (const row of all) {
      expect(AttemptRowSchema.safeParse(row).success).toBe(true);
      expect(row.max_attempts).toBe(3);
      expect(row.idempotency_protected).toBe(false);
    }
    expect(all[0]!.backoff_s).toBe(4);
    expect(all[0]!.charge_status).toBe('unbilled');
    expect(all[0]!.attempt_no).toBe(2);

    const topicOnly = await gateway.attempts(projectId, { stage: 'T', limit: 50 });
    expect(topicOnly).toHaveLength(2);
    expect(topicOnly.every((row) => row.stage === 'T')).toBe(true);

    const limited = await gateway.attempts(projectId, { stage: null, limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited[0]!.created_at).toBe('2026-10-20T10:00:00.000Z');
  });
});
