import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ScriptViewSchema } from '../../../contract/api.js';
import { runMigrations } from '../../db/runner.js';
import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../../../tests/helpers/pg.js';
import { seedProject } from '../../../tests/helpers/fixtures.js';
import { createPostgresScriptGateway } from './postgres.js';

/**
 * `ScriptGateway` over Postgres — the S-10 surface. Two properties under test:
 * an unknown id reads null, and a seeded script revision maps to a
 * schema-valid `ScriptView` with its budget re-derived from the project's
 * target duration and its claims joined to their sources.
 */
const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[script postgres adapter tests skipped] ${SKIP_REASON}`);

const DB_TEST_TIMEOUT_MS = 120_000;

describe.skipIf(!hasDatabase)('ScriptGateway (postgres)', { timeout: DB_TEST_TIMEOUT_MS }, () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.pool);
  }, DB_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await db?.close();
  });

  async function seedScript() {
    const seeded = await seedProject(db.pool);
    await db.pool.query('UPDATE project SET target_duration_s = 75 WHERE id = $1', [
      seeded.projectId,
    ]);

    const content = {
      script: 'You are not stuck. You are narrating. Say less.',
      title: 'The cost of narrating your own work',
      description: 'A short note on explaining early.',
      hashtags: ['#psychology', '#founders'],
    };

    const script = await db.pool.query<{ id: string }>(
      `INSERT INTO script_revision
           (project_id, revision, content, schema_version, word_count, estimated_runtime_s,
            eight_gram_scan_pass, eight_gram_violations, status, approved_at)
         VALUES ($1, 1, $2::jsonb, 'script.v2', 228, 75.1, true, '[]'::jsonb, 'approved', $3)
         RETURNING id`,
      [seeded.projectId, JSON.stringify(content), new Date('2026-10-20T09:41:12.000Z')],
    );
    const scriptId = script.rows[0]!.id;

    const source = await db.pool.query<{ id: string }>(
      `INSERT INTO source (project_id, url, title, domain, rerank_score, status)
         VALUES ($1, 'https://example.org/study', 'Self-explanation and focus',
                 'example.org', 2.31, 'accepted') RETURNING id`,
      [seeded.projectId],
    );
    const sourceId = source.rows[0]!.id;

    await db.pool.query(
      `INSERT INTO claim
           (project_id, script_revision_id, text, is_factual, status, source_id, url_status, url_reachable_at)
         VALUES ($1, $2, 'Participants spent 23% longer on the task.', true, 'sourced', $3, '200', $4)`,
      [seeded.projectId, scriptId, sourceId, new Date('2026-10-20T09:41:12.000Z')],
    );
    await db.pool.query(
      `INSERT INTO claim
           (project_id, script_revision_id, text, is_factual, status)
         VALUES ($1, $2, 'Most founders quit in month nine.', true, 'unsourced')`,
      [seeded.projectId, scriptId],
    );

    return { ...seeded, scriptId };
  }

  it('returns null for an unknown video', async () => {
    const gateway = createPostgresScriptGateway(db.pool);
    await expect(gateway.get(randomUUID())).resolves.toBeNull();
  });

  it('maps a seeded script revision to a schema-valid view', async () => {
    const { projectId } = await seedScript();
    const gateway = createPostgresScriptGateway(db.pool);
    const script = await gateway.get(projectId);

    expect(script).not.toBeNull();
    const parsed = ScriptViewSchema.safeParse(script);
    expect(parsed.success).toBe(true);

    expect(script!.project_id).toBe(projectId);
    expect(script!.revision).toBe(1);
    expect(script!.schema_version).toBe('script.v2');
    expect(script!.status).toBe('approved');
    expect(script!.word_count).toBe(228);
    expect(script!.estimated_runtime_s).toBeCloseTo(75.1, 1);
    expect(script!.content.script).toBe('You are not stuck. You are narrating. Say less.');
    expect(script!.content.hashtags).toEqual(['#psychology', '#founders']);

    // budget is re-derived from target_duration_s=75: round(75 * 3.035) = 228.
    expect(script!.budget.target_words).toBe(228);
    expect(script!.budget.within_band).toBe(true);

    expect(script!.eight_gram.pass).toBe(true);
    expect(script!.eight_gram.violations).toEqual([]);

    expect(script!.claims).toHaveLength(2);
    const sourced = script!.claims.find((claim) => claim.status === 'sourced');
    expect(sourced).toBeDefined();
    expect(sourced!.source).not.toBeNull();
    expect(sourced!.source!.domain).toBe('example.org');
    expect(sourced!.source!.rerank_score).toBeCloseTo(2.31, 2);
    expect(sourced!.url_status).toBe(200);

    const unsourced = script!.claims.find((claim) => claim.status === 'unsourced');
    expect(unsourced).toBeDefined();
    expect(unsourced!.source).toBeNull();
    expect(unsourced!.url_status).toBeNull();

    expect(script!.approved_at).toBe('2026-10-20T09:41:12.000Z');
  });
});
