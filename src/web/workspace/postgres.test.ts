import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { VideoDetailSchema } from '../../../contract/api.js';
import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../../../tests/helpers/pg.js';
import { runMigrations } from '../../db/runner.js';
import { createVideoGateway } from './postgres.js';

/**
 * The Postgres `VideoGateway` against a real Postgres. A video IS a `project`
 * row, so the tests seed `series`/`series_version`/`project`/`video_stage`
 * (plus `scene` and `script_revision` for the derived counts) and assert the
 * workspace shell round-trips into a contract-valid `VideoDetail`.
 */
const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[workspace postgres tests skipped] ${SKIP_REASON}`);

const DB_TEST_TIMEOUT_MS = 120_000;

const STAGES = ['T', 'RS', 'SC', 'SB', 'IM', 'NA', 'TC', 'RE', 'QC', 'FA', 'EX'] as const;

const SNAPSHOT = {
  niche: { subject: 'psychology' },
  script_style: null,
  voice_config: null,
  art_style: null,
  default_aspect_ratio: '9:16',
  target_duration_s: 75,
  narration_language: 'en',
  captions_preset: null,
  music_config: null,
  image_resolution: '1K',
  mode: 'creative',
};

interface Seed {
  readonly seriesId: string;
  readonly versionId: string;
}

async function seedSeries(pool: TestDatabase['pool'], slug: string): Promise<Seed> {
  const series = await pool.query<{ id: string }>(
    `INSERT INTO series (name, slug, niche, default_aspect_ratio, target_duration_s, narration_language, image_resolution, mode)
     VALUES ($1, $2, $3::jsonb, '9:16', 75, 'en', '1K', 'creative') RETURNING id`,
    ['Test Series', slug, JSON.stringify(SNAPSHOT.niche)],
  );
  const seriesId = series.rows[0]?.id;
  if (seriesId === undefined) throw new Error('series insert returned no id');

  const version = await pool.query<{ id: string }>(
    `INSERT INTO series_version (series_id, version, snapshot, mode, target_duration_s)
     VALUES ($1, 1, $2::jsonb, 'creative', 75) RETURNING id`,
    [seriesId, JSON.stringify(SNAPSHOT)],
  );
  const versionId = version.rows[0]?.id;
  if (versionId === undefined) throw new Error('series_version insert returned no id');

  return { seriesId, versionId };
}

async function seedProject(
  pool: TestDatabase['pool'],
  seriesId: string,
  options: { status?: string; currentStage?: string | null; position?: number | null } = {},
): Promise<string> {
  const project = await pool.query<{ id: string }>(
    `INSERT INTO project (series_id, status, current_stage, position_in_batch)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      seriesId,
      options.status === undefined ? 'RUNNING' : options.status,
      options.currentStage === undefined ? 'IM' : options.currentStage,
      options.position === undefined ? 1 : options.position,
    ],
  );
  const projectId = project.rows[0]?.id;
  if (projectId === undefined) throw new Error('project insert returned no id');
  return projectId;
}

async function seedStages(
  pool: TestDatabase['pool'],
  projectId: string,
  versionId: string,
): Promise<void> {
  // T/RS/SC done and pinned to v1; the rest untouched. Mirrors a project whose
  // first three stages have run.
  await pool.query(
    `INSERT INTO video_stage (project_id, stage, state, series_version_id)
     SELECT $1, stage,
            CASE WHEN stage IN ('T', 'RS', 'SC') THEN 'done' ELSE 'not_run' END,
            CASE WHEN stage IN ('T', 'RS', 'SC') THEN $2::uuid ELSE NULL END
       FROM unnest($3::text[]) AS stage`,
    [projectId, versionId, STAGES],
  );
}

describe.skipIf(!hasDatabase)(
  'Postgres VideoGateway (video.get workspace shell)',
  { timeout: DB_TEST_TIMEOUT_MS },
  () => {
    let db: TestDatabase;

    beforeAll(async () => {
      db = await createTestDatabase();
      await runMigrations(db.pool);
    }, DB_TEST_TIMEOUT_MS);

    afterAll(async () => {
      await db?.close();
    });

    it('returns null for an unknown video id instead of throwing', async () => {
      const gateway = createVideoGateway(db.pool);
      await expect(gateway.get('aaaaaaaa-0000-4000-8000-000000000000')).resolves.toBeNull();
    });

    it('round-trips a seeded project into a schema-valid VideoDetail', async () => {
      const gateway = createVideoGateway(db.pool);
      const { seriesId, versionId } = await seedSeries(db.pool, `video-series-${process.pid}`);
      const projectId = await seedProject(db.pool, seriesId, {
        status: 'RUNNING',
        currentStage: 'IM',
        position: 2,
      });
      await seedStages(db.pool, projectId, versionId);

      // Derived counts: two scenes, one script revision, and a topic pointer.
      await db.pool.query(
        `INSERT INTO scene (project_id, scene_no, position) VALUES ($1, 'S01', 1), ($1, 'S02', 2)`,
        [projectId],
      );
      await db.pool.query(
        `INSERT INTO script_revision (project_id, revision, content, schema_version)
         VALUES ($1, 2, '{}'::jsonb, '1.0.0')`,
        [projectId],
      );

      const detail = await gateway.get(projectId);
      expect(detail).not.toBeNull();

      const parsed = VideoDetailSchema.parse(detail);
      expect(parsed.id).toBe(projectId);
      expect(parsed.series_id).toBe(seriesId);
      expect(parsed.series_name).toBe('Test Series');
      expect(parsed.batch_id).toBeNull();
      expect(parsed.position_in_batch).toBe(2);
      expect(parsed.status).toBe('RUNNING');
      expect(parsed.current_stage).toBe('IM');
      expect(parsed.stage_state).toBe('not_run');
      expect(parsed.attention_kind).toBe('none');
      expect(parsed.attention_reason).toBeNull();
      expect(parsed.topic_id).toBeNull();
      expect(parsed.script_revision).toBe(2);
      expect(parsed.scene_count).toBe(2);
      expect(parsed.target_duration_s).toBe(75);

      // All 11 stages in pipeline order, with the uniform v1 pin.
      expect(parsed.stages).toHaveLength(11);
      expect(parsed.stages.map((stage) => stage.stage)).toEqual([...STAGES]);
      expect(parsed.stages.find((stage) => stage.stage === 'T')?.series_version).toBe(1);
      expect(parsed.stages.find((stage) => stage.stage === 'IM')?.state).toBe('not_run');
      expect(parsed.pins).toEqual({
        text: 'v1',
        uniform: true,
        versions: [{ version: 1, count: 3, stages: ['T', 'RS', 'SC'] }],
      });

      expect(parsed.links.topic).toBe('/videos/' + projectId);
      expect(parsed.links.export).toBe('/videos/' + projectId + '/export');
    });

    it('maps a NOT_STARTED project with no stage rows to the documented fallbacks', async () => {
      const gateway = createVideoGateway(db.pool);
      const { seriesId } = await seedSeries(db.pool, `not-started-${process.pid}`);
      // No current_stage, no batch position, no stage rows — the Milestone-A
      // single-video slice before anything has run.
      const projectId = await seedProject(db.pool, seriesId, {
        status: 'NOT_STARTED',
        currentStage: null,
        position: null,
      });

      const detail = await gateway.get(projectId);
      const parsed = VideoDetailSchema.parse(detail);

      expect(parsed.status).toBe('NOT_STARTED');
      expect(parsed.current_stage).toBe('T');
      expect(parsed.stage_state).toBe('not_run');
      expect(parsed.position_in_batch).toBe(0);
      expect(parsed.stages).toHaveLength(11);
      expect(parsed.stages.every((stage) => stage.state === 'not_run')).toBe(true);
      expect(parsed.pins.text).toBe('');
      expect(parsed.pins.versions).toEqual([]);
    });
  },
);
