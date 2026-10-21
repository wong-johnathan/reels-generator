import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedProject } from '../../tests/helpers/fixtures.js';
import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../../tests/helpers/pg.js';
import { MIGRATIONS } from './migrations/index.js';
import {
  MigrationChecksumMismatchError,
  MigrationFailedError,
  migrationStatus,
  runMigrations,
} from './runner.js';

/**
 * B-02 Signal: `migrate up` applies every bundled migration idempotently.
 * B-14 adds M-006 (the series_version guards), so the pinned list is M-001…M-006.
 *
 * These tests run against a real Postgres 16 (see tests/helpers/pg.ts). They
 * assert the acceptance shape of the schema itself — the 22 tables of
 * TECH_DESIGN §3, the seed of §4.3, and the constraints that make the state
 * vocabularies and the content-addressed object key structural rather than
 * convention.
 */
const DESIGNED_TABLES = [
  'asset',
  'asset_ref',
  'batch',
  'claim',
  'generation_run',
  'invalidation_rule',
  'job',
  'job_attempt',
  'operator',
  'project',
  'provider_qualification',
  'publication_log',
  'reference',
  'review_decision',
  'scene',
  'script_revision',
  'series',
  'series_version',
  'session',
  'source',
  'topic',
  'video_stage',
] as const;

const MIGRATION_IDS = ['M-001', 'M-002', 'M-003', 'M-004', 'M-005', 'M-006'] as const;

const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[schema tests skipped] ${SKIP_REASON}`);

/** TECH_DESIGN §4.3 verbatim: the invalidation matrix is data, seeded by M-005. */
const INVALIDATION_MATRIX = {
  script_wording: {
    invalidated_stages: ['SB', 'NA', 'TC', 'RE'],
    survives: ['IM'],
    image_calls: 0,
    tts_calls: 1,
    render_passes: 1,
    text_action: 're-derive 17 scene prompts',
    conditional_check: null,
  },
  duration: {
    invalidated_stages: ['SC', 'SB', 'NA', 'TC', 'RE'],
    survives: ['IM'],
    image_calls: 0,
    tts_calls: 1,
    render_passes: 1,
    text_action: 're-derive script + storyboard',
    conditional_check: null,
  },
  aspect_ratio: {
    invalidated_stages: ['RE'],
    survives: ['IM'],
    image_calls: 0,
    tts_calls: 0,
    render_passes: 1,
    text_action: null,
    conditional_check: 'reframe',
  },
  image_replace: {
    invalidated_stages: ['IM', 'RE'],
    survives: ['NA'],
    image_calls: 1,
    tts_calls: 0,
    render_passes: 1,
    text_action: null,
    conditional_check: null,
  },
  captions_music: {
    invalidated_stages: ['RE'],
    survives: ['IM', 'NA'],
    image_calls: 0,
    tts_calls: 0,
    render_passes: 1,
    text_action: null,
    conditional_check: null,
  },
  voice_speed: {
    invalidated_stages: ['NA', 'TC', 'RE'],
    survives: ['IM'],
    image_calls: 0,
    tts_calls: 1,
    render_passes: 1,
    text_action: null,
    conditional_check: null,
  },
  topic_after_research: {
    invalidated_stages: ['SC', 'SB', 'NA', 'TC', 'RE'],
    survives: [],
    image_calls: 0,
    tts_calls: 1,
    render_passes: 1,
    text_action: 're-derive script + storyboard',
    conditional_check: null,
  },
  reorder: {
    invalidated_stages: ['TC', 'RE'],
    survives: ['IM', 'NA'],
    image_calls: 0,
    tts_calls: 0,
    render_passes: 1,
    text_action: 'captions remap to new order',
    conditional_check: null,
  },
} as const;

async function tableNames(db: TestDatabase): Promise<string[]> {
  const result = await db.pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  return result.rows.map((row) => row.tablename);
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the query to be rejected, but it succeeded');
}

// DDL commits per statement, so a single migrate run on a slow disk takes tens
// of seconds; a generous timeout keeps the assertion about ordering, not speed.
const DB_TEST_TIMEOUT_MS = 120_000;

describe.skipIf(!hasDatabase)(
  'migration baseline M-001…M-006 (B-02 Signal + B-14 guards)',
  { timeout: DB_TEST_TIMEOUT_MS },
  () => {
    let db: TestDatabase;

    beforeAll(async () => {
      db = await createTestDatabase();
    }, DB_TEST_TIMEOUT_MS);

    afterAll(async () => {
      await db.close();
    }, DB_TEST_TIMEOUT_MS);

    it('applies M-001…M-006 in order and creates exactly the 22 designed tables', async () => {
      const result = await runMigrations(db.pool);

      expect(result.applied).toEqual([...MIGRATION_IDS]);
      expect(result.alreadyApplied).toEqual([]);

      const tables = await tableNames(db);
      expect(tables).toEqual([...DESIGNED_TABLES, 'schema_migration'].sort());
    });

    it('is idempotent: a second `up` applies nothing and reports every migration as applied', async () => {
      const before = await db.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM schema_migration`,
      );

      const second = await runMigrations(db.pool);

      expect(second.applied).toEqual([]);
      expect(second.alreadyApplied).toEqual([...MIGRATION_IDS]);

      const after = await db.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM schema_migration`,
      );
      expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
      // Re-running must not re-execute DDL: the table set is unchanged.
      expect(await tableNames(db)).toEqual([...DESIGNED_TABLES, 'schema_migration'].sort());
    });

    it('reports applied migrations through migrationStatus', async () => {
      const status = await migrationStatus(db.pool);

      expect(status.map((row) => row.id)).toEqual([...MIGRATION_IDS]);
      for (const row of status) {
        expect(row.appliedAt).toBeInstanceOf(Date);
        expect(row.checksumMatches).toBe(true);
      }
    });

    it('records a checksum per migration and refuses to run a changed, already-applied migration', async () => {
      const tampered = MIGRATIONS.map((migration) =>
        migration.id === 'M-001'
          ? { ...migration, sql: `${migration.sql}\n-- an edit after it was applied\n` }
          : migration,
      );

      const error = await rejection(runMigrations(db.pool, tampered));

      expect(error).toBeInstanceOf(MigrationChecksumMismatchError);
      expect(error.message).toContain('M-001');
    });

    it('installs pgcrypto and pgvector in M-001', async () => {
      const extensions = await db.pool.query<{ extname: string; extversion: string }>(
        `SELECT extname, extversion FROM pg_extension WHERE extname IN ('pgcrypto', 'vector') ORDER BY 1`,
      );

      expect(extensions.rows.map((row) => row.extname)).toEqual(['pgcrypto', 'vector']);
      const probe = await db.pool.query<{ uuid: string; distance: string }>(
        `SELECT gen_random_uuid()::text AS uuid, ('[1,2,3]'::vector <-> '[1,2,4]'::vector)::text AS distance`,
      );
      expect(probe.rows[0]!.uuid).toMatch(/^[0-9a-f-]{36}$/);
      expect(Number(probe.rows[0]!.distance)).toBeCloseTo(1, 6);
    });

    it('seeds the eight invalidation_rule rows of TECH_DESIGN §4.3 exactly', async () => {
      const rows = await db.pool.query<{ edit_kind: string } & Record<string, unknown>>(
        `SELECT edit_kind, invalidated_stages, survives, image_calls, tts_calls, render_passes,
              text_action, conditional_check
         FROM invalidation_rule ORDER BY edit_kind`,
      );

      expect(rows.rows).toHaveLength(8);
      for (const row of rows.rows) {
        const expected = INVALIDATION_MATRIX[row.edit_kind as keyof typeof INVALIDATION_MATRIX];
        expect(expected, `unexpected edit_kind ${row.edit_kind}`).toBeDefined();
        expect({
          invalidated_stages: row.invalidated_stages,
          survives: row.survives,
          image_calls: row.image_calls,
          tts_calls: row.tts_calls,
          render_passes: row.render_passes,
          text_action: row.text_action,
          conditional_check: row.conditional_check,
        }).toEqual(expected);
      }
    });

    it('applies each migration in one transaction: a failing migration leaves no table and no ledger row', async () => {
      const broken = [
        {
          id: 'M-900',
          description: 'deliberately broken: half the DDL is valid',
          sql: 'CREATE TABLE half_applied (id int PRIMARY KEY);\nSELECT * FROM a_table_that_does_not_exist;',
        },
      ];

      const error = await rejection(runMigrations(db.pool, broken));

      expect(error).toBeInstanceOf(MigrationFailedError);
      expect(error.message).toContain('M-900');

      const table = await db.pool.query<{ regclass: string | null }>(
        `SELECT to_regclass('public.half_applied')::text AS regclass`,
      );
      expect(table.rows[0]!.regclass).toBeNull();

      const ledger = await db.pool.query(`SELECT 1 FROM schema_migration WHERE id = 'M-900'`);
      expect(ledger.rowCount).toBe(0);
    });
  },
);

describe.skipIf(!hasDatabase)(
  'schema constraints (TECH_DESIGN §3)',
  { timeout: DB_TEST_TIMEOUT_MS },
  () => {
    let db: TestDatabase;
    let seeded: Awaited<ReturnType<typeof seedProject>>;

    beforeAll(async () => {
      db = await createTestDatabase();
      await runMigrations(db.pool);
      seeded = await seedProject(db.pool);
    }, DB_TEST_TIMEOUT_MS);

    afterAll(async () => {
      await db.close();
    }, DB_TEST_TIMEOUT_MS);

    it('keeps exactly one operator row (D3: single seeded operator, no registration path)', async () => {
      const error = await rejection(
        db.pool.query(`INSERT INTO operator (username, password_hash) VALUES ('second', 'x')`),
      );
      expect(error.message).toContain('operator');
    });

    it('rejects state values outside the documented vocabularies', async () => {
      const badMode = await rejection(
        db.pool.query(
          `INSERT INTO series (name, slug, niche, mode) VALUES ('x', 'x-slug', '{}'::jsonb, 'documentary')`,
        ),
      );
      expect(badMode.message).toContain('series_mode_check');

      const badBatch = await rejection(
        db.pool.query(
          `INSERT INTO batch (series_id, series_version_id, target_count, status)
                     VALUES ($1, $2, 31, 'ACTIVE')`,
          [seeded.seriesId, seeded.seriesVersionId],
        ),
      );
      expect(badBatch.message).toContain('batch_target_count_check');

      const badStage = await rejection(
        db.pool.query(`INSERT INTO video_stage (project_id, stage) VALUES ($1, 'ZZ')`, [
          seeded.projectId,
        ]),
      );
      expect(badStage.message).toContain('video_stage_stage_check');
    });

    it('keeps scene_no stable and unique per project (R-007-2)', async () => {
      await db.pool.query(
        `INSERT INTO scene (project_id, scene_no, position, camera_move)
       VALUES ($1, 'S01', 1, 'zoom_in')`,
        [seeded.projectId],
      );
      const duplicate = await rejection(
        db.pool.query(`INSERT INTO scene (project_id, scene_no, position) VALUES ($1, 'S01', 2)`, [
          seeded.projectId,
        ]),
      );
      expect(duplicate.message).toContain('scene_project_scene_no_key');
    });

    it('derives asset.object_key from content_sha256 (R-026) and enforces uniqueness', async () => {
      const sha = 'a'.repeat(64);
      const mismatched = await rejection(
        db.pool.query(
          `INSERT INTO asset (stage, kind, content_sha256, object_key) VALUES ('IM', 'image', $1, $2)`,
          [sha, `sha256:${'b'.repeat(64)}`],
        ),
      );
      expect(mismatched.message).toContain('asset_object_key_matches_hash');

      await db.pool.query(
        `INSERT INTO asset (stage, kind, content_sha256, object_key) VALUES ('IM', 'image', $1, $2)`,
        [sha, `sha256:${sha}`],
      );
      const duplicate = await rejection(
        db.pool.query(
          `INSERT INTO asset (stage, kind, content_sha256, object_key) VALUES ('IM', 'image', $1, $2)`,
          [sha, `sha256:${sha}`],
        ),
      );
      expect(duplicate.message).toContain('uq_asset_content_sha256');
    });

    it('forbids billed_units on an unbilled charge and unbilled on a timeout (R-012-4)', async () => {
      const attempt = await db.pool.query<{ id: string }>(
        `INSERT INTO job_attempt (job_id, attempt_no, status) VALUES ($1, 1, 'running') RETURNING id`,
        [seeded.jobId],
      );
      const insertRun = (charge: string, status: string, billed: string | null) =>
        db.pool.query(
          `INSERT INTO generation_run (job_attempt_id, project_id, stage, prompt_hash, charge_status, status, billed_units)
         VALUES ($1, $2, 'T', 'hash', $3, $4, $5)`,
          [attempt.rows[0]!.id, seeded.projectId, charge, status, billed],
        );

      const billedButPending = await rejection(insertRun('pending', 'succeeded', '12'));
      expect(billedButPending.message).toContain('generation_run_billed_units_check');

      const timedOutUnbilled = await rejection(insertRun('unbilled', 'timed_out', null));
      expect(timedOutUnbilled.message).toContain('generation_run_timeout_charge_check');

      // A timeout that may have billed is recorded as unknown, never unbilled.
      const ok = await insertRun('unknown', 'timed_out', null);
      expect(ok.rowCount).toBe(1);
    });

    it('allows only the six provider stages in generation_run (X-7: RE/QC/EX never appear)', async () => {
      const attempt = await db.pool.query<{ id: string }>(`SELECT id FROM job_attempt LIMIT 1`);
      const error = await rejection(
        db.pool.query(
          `INSERT INTO generation_run (job_attempt_id, project_id, stage, prompt_hash)
         VALUES ($1, $2, 'RE', 'hash')`,
          [attempt.rows[0]!.id, seeded.projectId],
        ),
      );
      expect(error.message).toContain('generation_run_stage_check');
    });

    it('requires a reason and a return stage on a rejected review decision (R-005-4)', async () => {
      const noReason = await rejection(
        db.pool.query(
          `INSERT INTO review_decision (project_id, stage, decision, target_stage)
         VALUES ($1, 'SC', 'reject', 'SC')`,
          [seeded.projectId],
        ),
      );
      expect(noReason.message).toContain('review_decision_reject_check');

      const ok = await db.pool.query(
        `INSERT INTO review_decision (project_id, stage, decision, target_stage, reason, revision_at_decision)
       VALUES ($1, 'SC', 'reject', 'SC', 'word budget over the band', 3)`,
        [seeded.projectId],
      );
      expect(ok.rowCount).toBe(1);
    });
  },
);
