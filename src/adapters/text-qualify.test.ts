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
  assertLatestQualificationPassed,
  latestQualification,
  ProviderNotQualifiedError,
} from '../db/repositories/provider-qualifications.js';
import { openAttempt } from '../domain/generation-run.js';
import { FakeTextAdapter } from './fake-text.js';
import { QUIET_MACHINES_FIXTURES } from './text-fixtures.js';
import { TEXT_SCHEMAS } from './text-schemas.js';
import { TEXT_ADAPTER_VERSION, type TextQualificationDeps } from './text.js';

/**
 * B-04 Signal, part 3: `qualify()` writes a `provider_qualification` pass row.
 *
 * This is the DB-backed half of the signal: the row must be durable (read back
 * on a second connection) and every qualification call must go through a
 * committed `generation_run` (R-008-3 + R-012-1). The adapter under test is the
 * deterministic fake, so no provider is called.
 *
 * The schema is migrated once for the file (each DDL statement commits, so a
 * per-test migration costs ~45 s). Cleanup between tests removes only the rows
 * this file writes, inside a throwaway database — nothing outside it is touched.
 */
const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[text qualification tests skipped] ${SKIP_REASON}`);

describe.skipIf(!hasDatabase)('text adapter qualification (R-008-3, US-012)', () => {
  let db: TestDatabase;
  let project: SeededProject;
  let deps: TextQualificationDeps;

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.pool);
    project = await seedProject(db.pool);
  }, 180_000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    // A qualification call is its own job (a fresh `job` + `job_attempt` per run),
    // so clearing everything except the fixture project's job is enough.
    await db.pool.query('DELETE FROM provider_qualification');
    await db.pool.query('DELETE FROM job WHERE id <> $1', [project.jobId]);

    deps = {
      db: db.pool,
      openRun: async (input) => {
        const job = await db.pool.query<{ id: string }>(
          `INSERT INTO job (project_id, stage, status) VALUES ($1, $2, 'running') RETURNING id`,
          [project.projectId, input.stage],
        );
        return openAttempt(db.pool, {
          jobId: job.rows[0]!.id,
          attemptNo: 1,
          projectId: project.projectId,
          stage: input.stage,
          provider: 'deepseek',
          model: 'fake-text',
          promptHash: input.promptHash,
          schemaVersion: input.schemaVersion,
        });
      },
    };
  }, 30_000);

  it('writes a passing provider_qualification row for the text adapter', async () => {
    const fake = new FakeTextAdapter();
    const outcome = await fake.qualify(deps);

    expect(outcome.passed).toBe(true);
    expect(outcome.row).toMatchObject({
      provider: 'deepseek',
      adapter: 'text',
      passed: true,
    });
    expect(outcome.row.run_at).toBeInstanceOf(Date);
    expect(outcome.details).toMatchObject({
      adapter: 'text',
      adapter_version: TEXT_ADAPTER_VERSION,
      provider: 'deepseek',
      model: 'fake-text',
    });
    expect(outcome.details.checks.map((check) => [check.stage, check.passed])).toEqual([
      ['T', true],
      ['SC', true],
      ['SB', true],
    ]);
    expect(outcome.details.schema_hashes).toMatchObject({
      topic: expect.stringMatching(/^[0-9a-f]{64}$/),
      script: expect.stringMatching(/^[0-9a-f]{64}$/),
      storyboard: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    // The row is durable and visible to a session that did not write it.
    const total = await withSecondConnection(db.pool, (client) =>
      client.query<{ count: string }>('SELECT count(*)::text AS count FROM provider_qualification'),
    );
    expect(total.rows[0]!.count).toBe('1');

    const latest = await latestQualification(db.pool, 'deepseek', 'text');
    expect(latest?.passed).toBe(true);
    expect(latest?.details).toMatchObject({ adapter_version: TEXT_ADAPTER_VERSION });
    await expect(
      assertLatestQualificationPassed(db.pool, 'deepseek', 'text'),
    ).resolves.toMatchObject({ passed: true });
  }, 30_000);

  it('opened one committed generation_run per schema before each qualification call', async () => {
    const fake = new FakeTextAdapter();
    await fake.qualify(deps);

    const runs = await db.pool.query<{
      stage: string;
      status: string;
      charge_status: string;
      schema_version: string;
      provider: string;
    }>(
      `SELECT stage, status, charge_status, schema_version, provider
         FROM generation_run ORDER BY stage`,
    );

    expect(runs.rowCount).toBe(3);
    expect(runs.rows.map((row) => row.stage)).toEqual(['SB', 'SC', 'T']);
    for (const row of runs.rows) {
      expect(row.status).toBe('pending');
      expect(row.charge_status).toBe('pending');
      expect(row.provider).toBe('deepseek');
    }
    expect(runs.rows.map((row) => row.schema_version).sort()).toEqual(
      [
        TEXT_SCHEMAS.script.version,
        TEXT_SCHEMAS.storyboard.version,
        TEXT_SCHEMAS.topic.version,
      ].sort(),
    );

    expect(fake.calls).toHaveLength(3);
    // One qualification call per schema, each against its own persisted run.
    expect(new Set(fake.calls.map((call) => call.runId)).size).toBe(3);
  }, 30_000);

  it('records a failing row when a schema check fails, and the gate then refuses', async () => {
    const failing = new FakeTextAdapter({
      responses: [{ kind: 'invalid-schema', content: { title: 7 } }],
    });
    const outcome = await failing.qualify(deps);

    expect(outcome.passed).toBe(false);
    expect(outcome.row.passed).toBe(false);
    expect(outcome.details.checks[0]).toMatchObject({
      stage: 'T',
      schema: 'topic',
      schema_version: TEXT_SCHEMAS.topic.version,
      passed: false,
      error_class: 'non_retryable',
      error_code: 'schema_invalid',
    });
    expect(outcome.details.checks[0]!.field_errors.join(' ')).toContain('title');
    expect(outcome.details.checks.slice(1).every((check) => check.passed)).toBe(true);

    await expect(
      assertLatestQualificationPassed(db.pool, 'deepseek', 'text'),
    ).rejects.toBeInstanceOf(ProviderNotQualifiedError);
  }, 30_000);

  it('uses the newest row for the gate, so a later pass unblocks the adapter', async () => {
    const failing = new FakeTextAdapter({
      responses: [{ kind: 'http', status: 500 }],
    });
    await failing.qualify(deps);

    // Let the second qualification's clock_timestamp advance past the first row.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const passing = new FakeTextAdapter();
    const recovered = await passing.qualify(deps);
    expect(recovered.passed).toBe(true);

    const rows = await db.pool.query<{ passed: boolean }>(
      'SELECT passed FROM provider_qualification ORDER BY run_at DESC',
    );
    expect(rows.rows.map((row) => row.passed)).toEqual([true, false]);

    await expect(
      assertLatestQualificationPassed(db.pool, 'deepseek', 'text'),
    ).resolves.toMatchObject({ passed: true });
  }, 30_000);

  it('refuses the gate when no qualification has ever been recorded', async () => {
    await expect(
      assertLatestQualificationPassed(db.pool, 'deepseek', 'text'),
    ).rejects.toBeInstanceOf(ProviderNotQualifiedError);
    expect(await latestQualification(db.pool, 'deepseek', 'text')).toBeNull();
  }, 30_000);

  it('sends a deterministic qualification prompt per schema and serves the fixtures', async () => {
    const fake = new FakeTextAdapter();
    const outcome = await fake.qualify(deps);

    expect(fake.calls.map((call) => call.stage)).toEqual(['T', 'SC', 'SB']);
    for (const call of fake.calls) {
      expect(call.messages.length).toBeGreaterThan(0);
      expect(call.messages.every((message) => message.content.length > 0)).toBe(true);
    }

    // The same adapter run again produces the same verdict for the same schema set.
    const second = await new FakeTextAdapter().qualify(deps);
    expect(second.details.checks).toEqual(outcome.details.checks);
    expect(second.details.schema_hashes).toEqual(outcome.details.schema_hashes);
    expect(QUIET_MACHINES_FIXTURES.script.narration.length).toBeGreaterThan(0);
  }, 30_000);
});
