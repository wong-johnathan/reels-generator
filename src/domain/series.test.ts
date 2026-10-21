import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SKIP_REASON, testDatabaseUrl } from '../../tests/helpers/pg.js';
import { provisionAuth, type AuthFixture } from '../../tests/helpers/auth.js';
import {
  changedProfileFields,
  createSeries,
  defaultProfile,
  DuplicateSlugError,
  effectiveTargetDuration,
  getSeries,
  getSeriesVersion,
  listSeries,
  listSeriesVersions,
  MAX_TARGET_DURATION_S,
  mergeProfile,
  MIN_TARGET_DURATION_S,
  mintSeriesVersion,
  pinStageAtStart,
  resolveProjectTargetDuration,
  RevisionConflictError,
  SeriesNoChangeError,
  seriesVersionForStageStart,
  setProjectTargetDuration,
  TargetDurationError,
  updateSeries,
  type SeriesDetail,
} from './series.js';

/**
 * B-14 — series profile CRUD and versioning against a real Postgres.
 *
 * The invariants under test are database properties (the M-006 triggers, the
 * `unique(series_id, version)` index, the per-series row lock), so there is no
 * in-memory surrogate here: every call goes through the production SQL.
 *
 * No provider is involved, and no test asserts on wall-clock time.
 */
const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[series tests skipped] ${SKIP_REASON}`);

const STAGES = ['T', 'RS', 'SC', 'SB', 'IM', 'NA', 'TC', 'RE', 'QC', 'FA', 'EX'] as const;

describe.skipIf(!hasDatabase)('series versioning (R-001-4, R-002-1…3, R-009-1)', () => {
  let fixture: AuthFixture;
  let slugSeq = 0;

  beforeAll(async () => {
    fixture = await provisionAuth();
  });

  afterAll(async () => {
    await fixture.close();
  });

  function nextSlug(prefix = 'series'): string {
    slugSeq += 1;
    return `${prefix}-${process.pid % 1000}-${slugSeq}`;
  }

  async function newSeries(profile: Record<string, unknown> = {}): Promise<SeriesDetail> {
    return createSeries(fixture.pool, {
      name: `Series ${slugSeq + 1}`,
      slug: nextSlug(),
      profile,
      operatorId: fixture.operatorId,
    });
  }

  /** A project with all 11 stage rows, the first three done and pinned to v1. */
  async function newProject(seriesId: string): Promise<string> {
    const project = await fixture.pool.query<{ id: string }>(
      `INSERT INTO project (series_id) VALUES ($1) RETURNING id`,
      [seriesId],
    );
    const projectId = project.rows[0]?.id;
    if (projectId === undefined) throw new Error('project insert returned no id');

    await fixture.pool.query(
      `INSERT INTO video_stage (project_id, stage, state)
       SELECT $1, stage, CASE WHEN stage IN ('T', 'RS', 'SC') THEN 'done' ELSE 'not_run' END
         FROM unnest($2::text[]) AS stage`,
      [projectId, STAGES],
    );

    const version = await seriesVersionForStageStart(fixture.pool, seriesId);
    await fixture.pool.query(
      `UPDATE video_stage SET series_version_id = $2 WHERE project_id = $1 AND stage = ANY($3::text[])`,
      [projectId, version.id, ['T', 'RS', 'SC']],
    );
    return projectId;
  }

  async function newAsset(projectId: string, versionId: string, hashChar: string): Promise<string> {
    const sha = hashChar.repeat(64);
    const asset = await fixture.pool.query<{ id: string }>(
      `INSERT INTO asset (project_id, stage, kind, content_sha256, object_key, series_version_id)
       VALUES ($1, 'IM', 'image', $2, 'sha256:' || $2, $3) RETURNING id`,
      [projectId, sha, versionId],
    );
    const id = asset.rows[0]?.id;
    if (id === undefined) throw new Error('asset insert returned no id');
    return id;
  }

  async function rowJson(table: string, id: string): Promise<unknown> {
    const result = await fixture.pool.query(
      `SELECT to_jsonb(t) AS row FROM ${table} t WHERE t.id = $1`,
      [id],
    );
    return result.rows[0]?.row;
  }

  it('create mints version 1 and points current_version_id at it', async () => {
    const detail = await newSeries({ niche: { subject: 'psychology' } });

    expect(detail.current_version).toBe(1);
    expect(detail.current_version_id).toEqual(expect.any(String));
    expect(detail.revision).toBe(1);
    expect(detail.version_count).toBe(1);
    expect(detail.in_flight_batches).toBe(0);
    expect(detail.profile.niche).toEqual({ subject: 'psychology' });

    const versions = await listSeriesVersions(fixture.pool, detail.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe(1);
    expect(versions[0]?.id).toBe(detail.current_version_id);
  });

  it('applies the R-009-1 defaults: 75 s, 9:16, 1K, creative, English', async () => {
    const detail = await newSeries();

    expect(detail.target_duration_s).toBe(75);
    expect(detail.profile.target_duration_s).toBe(75);
    expect(detail.profile.default_aspect_ratio).toBe('9:16');
    expect(detail.profile.image_resolution).toBe('1K');
    expect(detail.profile.mode).toBe('creative');
    expect(detail.profile.narration_language).toBe('en');
    expect(effectiveTargetDuration(detail.target_duration_s, null)).toBe(75);
  });

  it('accepts the PRD duration bounds 10 and 180 and refuses 9 or 181', async () => {
    const short = await newSeries({ target_duration_s: MIN_TARGET_DURATION_S });
    const long = await newSeries({ target_duration_s: MAX_TARGET_DURATION_S });
    expect(short.target_duration_s).toBe(10);
    expect(long.target_duration_s).toBe(180);

    await expect(newSeries({ target_duration_s: 9 })).rejects.toThrow(TargetDurationError);
    await expect(newSeries({ target_duration_s: 181 })).rejects.toThrow(TargetDurationError);
    await expect(newSeries({ target_duration_s: 75.5 })).rejects.toThrow(TargetDurationError);
  });

  it('an edit mints a new immutable version with the changed field named', async () => {
    const created = await newSeries({
      voice_config: { voice_id: 'voice-a', speed: 1 },
      target_duration_s: 75,
    });
    const v1 = await getSeriesVersion(fixture.pool, created.id, created.current_version_id);
    const v1RowBefore = await rowJson('series_version', created.current_version_id);

    const edited = await updateSeries(fixture.pool, {
      seriesId: created.id,
      revision: created.revision,
      profile: { voice_config: { speed: 0.92 }, target_duration_s: 90 },
      operatorId: fixture.operatorId,
    });

    expect(edited.current_version).toBe(2);
    expect(edited.revision).toBe(2);
    expect(edited.version_count).toBe(2);
    expect(edited.current_version_id).not.toBe(created.current_version_id);
    expect(edited.target_duration_s).toBe(90);
    // A one-level merge keeps the voice that was already configured.
    expect(edited.profile.voice_config).toEqual({ voice_id: 'voice-a', speed: 0.92 });

    // R-002-1: the old version still says exactly what it said.
    const v1RowAfter = await rowJson('series_version', created.current_version_id);
    expect(v1RowAfter).toEqual(v1RowBefore);
    expect(v1.snapshot.target_duration_s).toBe(75);

    const versions = await listSeriesVersions(fixture.pool, created.id);
    expect(versions.map((version) => version.version)).toEqual([2, 1]);
    expect(versions[0]?.changed_fields.sort()).toEqual(['target_duration_s', 'voice_config.speed']);
    expect(versions[1]?.changed_fields).toEqual([]);
  });

  it('refuses a stale revision and mints nothing (R-024 optimistic lock)', async () => {
    const created = await newSeries();
    await updateSeries(fixture.pool, {
      seriesId: created.id,
      revision: 1,
      profile: { narration_language: 'de' },
      operatorId: fixture.operatorId,
    });

    await expect(
      updateSeries(fixture.pool, {
        seriesId: created.id,
        revision: 1,
        profile: { narration_language: 'fr' },
        operatorId: fixture.operatorId,
      }),
    ).rejects.toBeInstanceOf(RevisionConflictError);

    const versions = await listSeriesVersions(fixture.pool, created.id);
    expect(versions.map((version) => version.version)).toEqual([2, 1]);
  });

  it('serialises concurrent edits: one wins, the other is a conflict', async () => {
    const created = await newSeries();

    const results = await Promise.allSettled([
      updateSeries(fixture.pool, {
        seriesId: created.id,
        revision: 1,
        profile: { narration_language: 'de' },
        operatorId: fixture.operatorId,
      }),
      updateSeries(fixture.pool, {
        seriesId: created.id,
        revision: 1,
        profile: { narration_language: 'fr' },
        operatorId: fixture.operatorId,
      }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(RevisionConflictError);

    const versions = await listSeriesVersions(fixture.pool, created.id);
    expect(versions.map((version) => version.version)).toEqual([2, 1]);

    // The loser can retry with the revision it now holds.
    const retried = await updateSeries(fixture.pool, {
      seriesId: created.id,
      revision: 2,
      profile: { narration_language: 'es' },
      operatorId: fixture.operatorId,
    });
    expect(retried.current_version).toBe(3);
  });

  it('series_version rows are immutable and the version sequence has no gaps', async () => {
    const created = await newSeries();
    const versionsBefore = await listSeriesVersions(fixture.pool, created.id);

    await expect(
      fixture.pool.query(`UPDATE series_version SET snapshot = '{}'::jsonb WHERE id = $1`, [
        created.current_version_id,
      ]),
    ).rejects.toThrow(/immutable \(R-002-1\)/);

    await expect(
      fixture.pool.query(`DELETE FROM series_version WHERE id = $1`, [created.current_version_id]),
    ).rejects.toThrow(/immutable \(R-002-1\)/);

    await expect(
      fixture.pool.query(
        `INSERT INTO series_version (series_id, version, snapshot, mode, target_duration_s)
         VALUES ($1, 7, '{}'::jsonb, 'creative', 75)`,
        [created.id],
      ),
    ).rejects.toThrow(/is not the next version/);

    expect(await listSeriesVersions(fixture.pool, created.id)).toHaveLength(versionsBefore.length);
  });

  it('an explicit mint may snapshot an unchanged profile and bumps the revision', async () => {
    const created = await newSeries();

    await expect(
      updateSeries(fixture.pool, {
        seriesId: created.id,
        revision: created.revision,
        profile: {},
        operatorId: fixture.operatorId,
      }),
    ).rejects.toBeInstanceOf(SeriesNoChangeError);

    const minted = await mintSeriesVersion(fixture.pool, {
      seriesId: created.id,
      revision: created.revision,
      operatorId: fixture.operatorId,
    });
    expect(minted.version).toBe(2);
    expect(minted.changed_fields).toEqual([]);
    expect(minted.pinned_by).toEqual([]);

    const detail = await getSeries(fixture.pool, created.id);
    expect(detail.revision).toBe(2);
    expect(detail.current_version).toBe(2);
  });

  it('a duplicate slug creates neither a series nor a version', async () => {
    const slug = nextSlug('dupe');
    await createSeries(fixture.pool, {
      name: 'First',
      slug,
      operatorId: fixture.operatorId,
    });

    await expect(
      createSeries(fixture.pool, { name: 'Second', slug, operatorId: fixture.operatorId }),
    ).rejects.toBeInstanceOf(DuplicateSlugError);

    const series = await fixture.pool.query(`SELECT id FROM series WHERE slug = $1`, [slug]);
    expect(series.rowCount).toBe(1);
    const versions = await fixture.pool.query(
      `SELECT count(*)::int AS count FROM series_version v JOIN series s ON s.id = v.series_id WHERE s.slug = $1`,
      [slug],
    );
    expect(versions.rows[0]?.count).toBe(1);
  });

  it('an edit never mutates an existing project, its stage pins or its assets (R-001-4)', async () => {
    const created = await newSeries({ target_duration_s: 75 });
    const projectId = await newProject(created.id);
    const v1Id = created.current_version_id;
    const assetId = await newAsset(projectId, v1Id, 'a');

    const projectBefore = await rowJson('project', projectId);
    const stagesBefore = await fixture.pool.query(
      `SELECT stage, state, series_version_id FROM video_stage WHERE project_id = $1 ORDER BY stage`,
      [projectId],
    );
    const assetBefore = await rowJson('asset', assetId);

    const edited = await updateSeries(fixture.pool, {
      seriesId: created.id,
      revision: created.revision,
      profile: { target_duration_s: 90, art_style: { preset: 'flat-comic' } },
      operatorId: fixture.operatorId,
    });
    expect(edited.current_version).toBe(2);

    // Nothing in the video's world moved, including timestamps.
    expect(await rowJson('project', projectId)).toEqual(projectBefore);
    const stagesAfter = await fixture.pool.query(
      `SELECT stage, state, series_version_id FROM video_stage WHERE project_id = $1 ORDER BY stage`,
      [projectId],
    );
    expect(stagesAfter.rows).toEqual(stagesBefore.rows);
    expect(await rowJson('asset', assetId)).toEqual(assetBefore);

    // The three done stages and the generated asset still pin v1.
    for (const row of stagesAfter.rows as Array<{
      stage: string;
      series_version_id: string | null;
    }>) {
      if (['T', 'RS', 'SC'].includes(row.stage)) expect(row.series_version_id).toBe(v1Id);
      else expect(row.series_version_id).toBeNull();
    }

    // No re-generation was triggered by the version change (R-002-3).
    const runs = await fixture.pool.query(
      `SELECT count(*)::int AS count FROM generation_run WHERE project_id = $1`,
      [projectId],
    );
    expect(runs.rows[0]?.count).toBe(0);
  });

  it('a later stage adopts the new version when it starts; earlier pins keep theirs (R-002-3)', async () => {
    const created = await newSeries({ target_duration_s: 75 });
    const projectId = await newProject(created.id);
    const v1 = await seriesVersionForStageStart(fixture.pool, created.id);

    const edited = await updateSeries(fixture.pool, {
      seriesId: created.id,
      revision: created.revision,
      profile: { target_duration_s: 90 },
      operatorId: fixture.operatorId,
    });
    expect(edited.current_version).toBe(2);

    // The not-yet-executed SB stage starts now: it records v2.
    const pinned = await pinStageAtStart(fixture.pool, projectId, 'SB');
    expect(pinned.version).toBe(2);
    expect(pinned.id).toBe(edited.current_version_id);
    expect(pinned.snapshot.target_duration_s).toBe(90);

    const stages = await fixture.pool.query<{
      stage: string;
      state: string;
      series_version_id: string | null;
    }>(
      `SELECT stage, state, series_version_id FROM video_stage WHERE project_id = $1 ORDER BY stage`,
      [projectId],
    );

    for (const row of stages.rows) {
      if (['T', 'RS', 'SC'].includes(row.stage)) {
        expect(row.series_version_id).toBe(v1.id);
        expect(row.state).toBe('done');
      } else if (row.stage === 'SB') {
        expect(row.series_version_id).toBe(edited.current_version_id);
        // Pinning is not a state transition: SB is still not_run.
        expect(row.state).toBe('not_run');
      } else {
        expect(row.series_version_id).toBeNull();
      }
    }

    // v1's inspector output still lists the stages that hold its pin.
    const v1Detail = await getSeriesVersion(fixture.pool, created.id, v1.id);
    expect(v1Detail.pinned_by).toEqual([{ project_id: projectId, stages: ['T', 'RS', 'SC'] }]);
    const v2Detail = await getSeriesVersion(fixture.pool, created.id, edited.current_version_id);
    expect(v2Detail.pinned_by).toEqual([{ project_id: projectId, stages: ['SB'] }]);
  });

  it('a per-video duration overrides the series value; null inherits it (R-009-1)', async () => {
    const created = await newSeries({ target_duration_s: 75 });
    const projectId = await newProject(created.id);

    expect(await resolveProjectTargetDuration(fixture.pool, projectId)).toEqual({
      seriesTargetS: 75,
      projectTargetS: null,
      effectiveTargetS: 75,
    });

    const overridden = await setProjectTargetDuration(fixture.pool, projectId, 30);
    expect(overridden.effectiveTargetS).toBe(30);

    await expect(setProjectTargetDuration(fixture.pool, projectId, 181)).rejects.toThrow(
      TargetDurationError,
    );

    // A series edit changes what an inheriting video renders to, not the override.
    await updateSeries(fixture.pool, {
      seriesId: created.id,
      revision: created.revision,
      profile: { target_duration_s: 90 },
      operatorId: fixture.operatorId,
    });
    expect((await resolveProjectTargetDuration(fixture.pool, projectId)).effectiveTargetS).toBe(30);

    const inherited = await setProjectTargetDuration(fixture.pool, projectId, null);
    expect(inherited).toEqual({ seriesTargetS: 90, projectTargetS: null, effectiveTargetS: 90 });
  });

  it('listSeries returns every series, newest writes included, without leaking versions', async () => {
    const before = await listSeries(fixture.pool);
    const created = await newSeries({ target_duration_s: 42 });
    const after = await listSeries(fixture.pool);

    expect(after.length).toBe(before.length + 1);
    const row = after.find((summary) => summary.id === created.id);
    expect(row).toBeDefined();
    expect(row?.current_version).toBe(1);
    expect(row?.target_duration_s).toBe(42);
  });

  it('changedProfileFields names nested leaves and scalar fields', () => {
    const before = defaultProfile({ voice_config: { voice_id: 'a', speed: 1 } });
    const after = mergeProfile(before, {
      voice_config: { speed: 1.1 },
      target_duration_s: 60,
      music_config: { track_id: 'track-1' },
    });

    expect(changedProfileFields(before, after).sort()).toEqual([
      'music_config',
      'target_duration_s',
      'voice_config.speed',
    ]);
    expect(changedProfileFields(null, after)).toEqual([]);
  });
});
