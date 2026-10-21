/**
 * B-15 acceptance tests — per-scene image replace (US-020, RULINGS L-2).
 *
 * Signal (card t_167e32e7): replacing scene 7 of a 17-scene video fires exactly
 * one image call, survives reorder (scene id stable), and marks only the render
 * stale.
 *
 * The provider is B-06's deterministic FakeImageAdapter and the object store is
 * the in-memory content-addressed fake: no network, no paid call. "0 TTS calls"
 * is asserted twice — the adapter never sees a narration request, and no
 * generation_run row carries stage 'NA'.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ProviderRequestError } from '../adapters/errors.js';
import { FakeImageAdapter } from '../adapters/fake-image.js';
import { encodePng } from '../adapters/image-bytes.js';
import { InMemoryImageQualificationStore } from '../adapters/image-qualification.js';
import type {
  ImageAdapter,
  ImageCallContext,
  ImageGenerateRequest,
  ImageGenerateResult,
} from '../adapters/image.js';
import { runMigrations } from '../db/runner.js';
import { createSceneReplaceHandler } from '../api/scene-replace-route.js';
import { InMemoryContentAddressedStore, sha256Hex } from '../storage/object-store.js';
import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../../tests/helpers/pg.js';
import { seedProject, type SeededProject } from '../../tests/helpers/fixtures.js';
import {
  planSceneReplace,
  runSceneReplace,
  type SceneReplaceDeps,
  type SceneReplaceJob,
} from './scene-replace.js';

vi.setConfig({ testTimeout: 120_000 });
const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn('[B-15 scene replace tests skipped] ' + SKIP_REASON);
const SCENE_COUNT = 17;
const TARGET_POSITION = 7;
const NEW_PROMPT = 'scene 7, same subject, corrected wardrobe';

function sceneNo(position: number): string {
  return 'S' + String(position).padStart(2, '0');
}

interface Fixture {
  readonly seed: SeededProject;
  readonly blobs: InMemoryContentAddressedStore;
  readonly adapter: ImageAdapter;
  readonly qualification: InMemoryImageQualificationStore;
  readonly deps: SceneReplaceDeps;
  readonly sceneIdsByNo: ReadonlyMap<string, string>;
  readonly targetSceneId: string;
  readonly oldAssetIdBySceneNo: ReadonlyMap<string, string>;
}

async function seedSceneImage(
  db: TestDatabase,
  blobs: InMemoryContentAddressedStore,
  projectId: string,
  sceneId: string,
  sceneNoValue: string,
): Promise<string> {
  const bytes = encodePng({
    width: 16,
    height: 16,
    pixel: (x, y) => [x, y, sceneNoValue.charCodeAt(1)],
    text: { reels_scene: sceneNoValue + '-' + projectId.slice(0, 8) },
  });
  const hash = sha256Hex(bytes);
  const key = 'scenes/' + sceneNoValue + '.png';
  await blobs.put(key, bytes, 'image/png');
  const asset = await db.pool.query<{ id: string }>(
    'INSERT INTO asset (project_id, stage, scene_id, kind, content_sha256, object_key, ' +
      'object_size_bytes, mime_type, width, height, provider, model, prompt_text) ' +
      "VALUES ($1, 'IM', $2, 'image', $3, $4, $5, 'image/png', 16, 16, 'fake', 'fake-nano-banana', $6) " +
      'RETURNING id',
    [projectId, sceneId, hash, key, bytes.byteLength, sceneNoValue + ' prompt'],
  );
  const assetId = asset.rows[0]!.id;
  await db.pool.query('UPDATE scene SET asset_id = $2 WHERE id = $1', [sceneId, assetId]);
  return assetId;
}

async function createFixture(
  db: TestDatabase,
  options: {
    readonly projectStatus?: 'RUNNING' | 'COMPLETE';
    readonly adapter?: ImageAdapter;
  } = {},
): Promise<Fixture> {
  const seed = await seedProject(db.pool);
  const projectId = seed.projectId;
  if (options.projectStatus !== undefined) {
    await db.pool.query('UPDATE project SET status = $2 WHERE id = $1', [
      projectId,
      options.projectStatus,
    ]);
  }
  const sceneIdsByNo = new Map<string, string>();
  for (let position = 1; position <= SCENE_COUNT; position += 1) {
    const inserted = await db.pool.query<{ id: string }>(
      'INSERT INTO scene (project_id, scene_no, position, image_prompt) VALUES ($1, $2, $3, $4) ' +
        'RETURNING id',
      [projectId, sceneNo(position), position, 'scene ' + position + ' prompt'],
    );
    sceneIdsByNo.set(sceneNo(position), inserted.rows[0]!.id);
  }

  for (const stage of ['IM', 'NA', 'RE'] as const) {
    await db.pool.query(
      'INSERT INTO video_stage (project_id, stage, state, progress_current, progress_total) ' +
        "VALUES ($1, $2, 'done', $3, $3)",
      [projectId, stage, SCENE_COUNT],
    );
  }

  const blobs = new InMemoryContentAddressedStore();
  const oldAssetIdBySceneNo = new Map<string, string>();
  for (const [no, sceneId] of sceneIdsByNo) {
    oldAssetIdBySceneNo.set(no, await seedSceneImage(db, blobs, projectId, sceneId, no));
  }

  const adapter = options.adapter ?? new FakeImageAdapter();
  const qualification = new InMemoryImageQualificationStore();
  await qualification.record({
    provider: adapter.provider,
    adapter: adapter.adapterName,
    passed: true,
    details: { scenes: 3 },
  });

  const deps: SceneReplaceDeps = {
    pool: db.pool,
    adapter,
    blobs,
    qualification,
    retentionDays: 30,
    now: () => new Date('2026-10-21T13:00:00.000Z'),
  };

  return {
    seed,
    blobs,
    adapter,
    qualification,
    deps,
    sceneIdsByNo,
    targetSceneId: sceneIdsByNo.get(sceneNo(TARGET_POSITION))!,
    oldAssetIdBySceneNo,
  };
}

/** Enqueue through the real route handler, then run the queued job. */
async function enqueue(
  db: TestDatabase,
  fixture: Fixture,
  sceneId: string,
  imagePrompt?: string,
): Promise<{ readonly jobId: string; readonly body: Record<string, unknown> }> {
  const revision = await db.pool.query<{ revision: number }>(
    'SELECT revision FROM scene WHERE id = $1',
    [sceneId],
  );
  const handler = createSceneReplaceHandler({ pool: db.pool });
  const response = await handler({
    method: 'POST',
    url: `/api/videos/${fixture.seed.projectId}/scenes/${sceneId}/replace-image`,
    body: {
      revision: revision.rows[0]!.revision,
      ...(imagePrompt === undefined ? {} : { image_prompt: imagePrompt }),
    },
  });
  expect(response.status, response.body).toBe(202);
  const job = await db.pool.query<{ id: string }>(
    "SELECT id FROM job WHERE project_id = $1 AND stage = 'IM' AND scene_id = $2 " +
      "AND status = 'queued' ORDER BY created_at DESC LIMIT 1",
    [fixture.seed.projectId, sceneId],
  );
  return { jobId: job.rows[0]!.id, body: JSON.parse(response.body) as Record<string, unknown> };
}

function jobFor(fixture: Fixture, jobId: string, sceneId: string): SceneReplaceJob {
  return { jobId, projectId: fixture.seed.projectId, sceneId };
}

describe('planSceneReplace', () => {
  it('plans exactly one image call and zero TTS calls from the image_replace matrix row', () => {
    const plan = planSceneReplace({
      scene: {
        id: 'scene-7',
        project_id: 'project-1',
        scene_no: 'S07',
        position: 7,
        image_prompt: 'scene 7 prompt',
        asset_id: 'asset-old',
        revision: 1,
      },
    });
    expect(plan.calls).toEqual({ image: 1, tts: 0, text: 0, render_passes: 1 });
    expect(plan.prompt).toBe('scene 7 prompt');
    expect(plan.prompt_changed).toBe(false);
    expect(plan.previous_asset_id).toBe('asset-old');
  });

  it('uses the operator prompt when one is supplied', () => {
    const plan = planSceneReplace({
      scene: {
        id: 'scene-7',
        project_id: 'project-1',
        scene_no: 'S07',
        position: 7,
        image_prompt: 'old',
        asset_id: 'asset-old',
        revision: 3,
      },
      imagePrompt: '  new prompt  ',
    });
    expect(plan.prompt).toBe('new prompt');
    expect(plan.prompt_changed).toBe(true);
  });

  it('refuses a blank prompt before anything can be billed', () => {
    expect(() =>
      planSceneReplace({
        scene: {
          id: 'scene-7',
          project_id: 'project-1',
          scene_no: 'S07',
          position: 7,
          image_prompt: '   ',
          asset_id: 'asset-old',
          revision: 1,
        },
      }),
    ).toThrow(/no image prompt/);
  });
});

describe.skipIf(!hasDatabase)('scene replace (US-020, RULINGS L-2)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.pool);
  }, 240_000);

  afterAll(async () => {
    await db?.close();
  });

  it('replacing scene 7 of 17 fires 1 image call, 0 TTS calls, and marks only the render stale', async () => {
    const fixture = await createFixture(db);
    const projectId = fixture.seed.projectId;
    const before = await db.pool.query<{ scene_no: string; asset_id: string; position: number }>(
      'SELECT scene_no, asset_id, position FROM scene WHERE project_id = $1 ORDER BY position',
      [projectId],
    );

    const { jobId, body } = await enqueue(db, fixture, fixture.targetSceneId, NEW_PROMPT);
    // QueueResponse: the operator sees the cost before the job runs.
    expect(body).toMatchObject({ queued: true, stage: 'IM' });
    const scope = body['scope'] as Record<string, unknown>;
    expect((scope['will_run'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      stage: 'IM',
      calls: { image: 1, tts: 0, text: 0, render_passes: 1 },
    });

    const result = await runSceneReplace(
      fixture.deps,
      jobFor(fixture, jobId, fixture.targetSceneId),
    );

    // ── exactly one image call, zero TTS calls ────────────────────────────────
    const fake = fixture.adapter as FakeImageAdapter;
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.prompt).toBe(NEW_PROMPT);
    expect(result.calls).toEqual({ image: 1, tts: 0 });
    const runs = await db.pool.query<{ id: string; stage: string; scene_id: string | null }>(
      'SELECT id, stage, scene_id FROM generation_run WHERE project_id = $1',
      [projectId],
    );
    expect(runs.rows.filter((row) => row.stage === 'IM')).toHaveLength(1);
    expect(runs.rows.filter((row) => row.stage === 'NA')).toHaveLength(0);
    expect(runs.rows[0]!.scene_id).toBe(fixture.targetSceneId);

    // ── the scene now points at the new asset, and the old one is retained ───
    expect(result.status).toBe('succeeded');
    expect(result.previous_asset_id).toBe(fixture.oldAssetIdBySceneNo.get('S07'));
    expect(result.asset_id).not.toBe(result.previous_asset_id);
    const scene = await db.pool.query<{
      asset_id: string;
      image_prompt: string;
      revision: number;
      scene_no: string;
    }>('SELECT asset_id, image_prompt, revision, scene_no FROM scene WHERE id = $1', [
      fixture.targetSceneId,
    ]);
    expect(scene.rows[0]).toMatchObject({
      asset_id: result.asset_id,
      image_prompt: NEW_PROMPT,
      revision: 2,
      scene_no: 'S07',
    });

    const oldAsset = await db.pool.query<{ id: string; object_key: string }>(
      'SELECT id, object_key FROM asset WHERE id = $1',
      [fixture.oldAssetIdBySceneNo.get('S07')],
    );
    expect(oldAsset.rowCount).toBe(1);
    expect(await fixture.blobs.has(oldAsset.rows[0]!.object_key)).toBe(true);
    expect(result.orphaned_asset_ids).toEqual([fixture.oldAssetIdBySceneNo.get('S07')]);

    // R-002-2: the replacement records the version/pin that produced it.
    const newAsset = await db.pool.query<Record<string, unknown>>(
      'SELECT * FROM asset WHERE id = $1',
      [result.asset_id],
    );
    expect(newAsset.rows[0]).toMatchObject({
      series_version_id: fixture.seed.seriesVersionId,
      provider: 'fake',
      model: 'fake-nano-banana',
      prompt_text: NEW_PROMPT,
      scene_id: fixture.targetSceneId,
    });
    expect(typeof newAsset.rows[0]!['prompt_hash']).toBe('string');
    expect(newAsset.rows[0]!['generation_run_id']).toBe(runs.rows[0]!.id);

    const stages = await db.pool.query<{
      stage: string;
      state: string;
      stale: boolean;
      stale_cause: string | null;
    }>(
      'SELECT stage, state, stale, stale_cause FROM video_stage WHERE project_id = $1 ORDER BY stage',
      [projectId],
    );
    const byStage = new Map(stages.rows.map((row) => [row.stage, row]));
    // Only the render is stale: the replacement *is* the IM re-run for that scene.
    expect(byStage.get('RE')).toMatchObject({ state: 'stale', stale: true });
    expect(byStage.get('RE')!.stale_cause).toMatch(/image_replace/);
    expect(byStage.get('RE')!.stale_cause).toMatch(/S07/);
    expect(byStage.get('IM')).toMatchObject({ state: 'done', stale: false });
    expect(byStage.get('NA')).toMatchObject({ state: 'done', stale: false });
    expect(result.render_stale).toBe(true);
    expect(result.stage_state).toBe('done');

    // ── the other 16 scenes keep their images ────────────────────────────────
    const after = await db.pool.query<{ scene_no: string; asset_id: string; position: number }>(
      'SELECT scene_no, asset_id, position FROM scene WHERE project_id = $1 ORDER BY position',
      [projectId],
    );
    for (const row of before.rows) {
      const now = after.rows.find((candidate) => candidate.scene_no === row.scene_no)!;
      if (row.scene_no === 'S07') continue;
      expect(now.asset_id).toBe(row.asset_id);
      expect(now.position).toBe(row.position);
    }

    // ── survives reorder: scene id and its image are untouched ───────────────
    const s07 = fixture.sceneIdsByNo.get('S07')!;
    const s08 = fixture.sceneIdsByNo.get('S08')!;
    await db.pool.query('UPDATE scene SET position = 8 WHERE id = $1', [s07]);
    await db.pool.query('UPDATE scene SET position = 7 WHERE id = $1', [s08]);
    const reordered = await db.pool.query<{
      id: string;
      scene_no: string;
      position: number;
      asset_id: string;
    }>(
      'SELECT id, scene_no, position, asset_id FROM scene WHERE project_id = $1 ORDER BY position',
      [projectId],
    );
    const moved = reordered.rows.find((row) => row.id === s07)!;
    expect(moved.scene_no).toBe('S07');
    expect(moved.position).toBe(8);
    expect(moved.asset_id).toBe(result.asset_id);
    // Reorder is not a provider call: still exactly one image call, no TTS call.
    expect(fake.calls).toHaveLength(1);
    expect(result.calls).toEqual({ image: 1, tts: 0 });
  });

  it('refuses a stale revision with a conflict and enqueues nothing (R-024)', async () => {
    const fixture = await createFixture(db);
    const handler = createSceneReplaceHandler({ pool: db.pool });
    const response = await handler({
      method: 'POST',
      url: `/api/videos/${fixture.seed.projectId}/scenes/${fixture.targetSceneId}/replace-image`,
      body: { revision: 99, image_prompt: NEW_PROMPT },
    });
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      error: { code: 'conflict' },
      document: 'scene',
      current_revision: 1,
      your_revision: 99,
    });
    const jobs = await db.pool.query(
      "SELECT id FROM job WHERE project_id = $1 AND stage = 'IM' AND scene_id = $2",
      [fixture.seed.projectId, fixture.targetSceneId],
    );
    expect(jobs.rowCount).toBe(0);
  });

  it('404s a scene that belongs to another video, and never calls the provider', async () => {
    const fixture = await createFixture(db);
    const other = await seedProject(db.pool);
    const handler = createSceneReplaceHandler({ pool: db.pool });
    const response = await handler({
      method: 'POST',
      url: `/api/videos/${other.projectId}/scenes/${fixture.targetSceneId}/replace-image`,
      body: { revision: 1 },
    });
    expect(response.status).toBe(404);
    expect((fixture.adapter as FakeImageAdapter).calls).toHaveLength(0);
  });

  it('leaves the old image, the stage and the render valid when the provider call fails', async () => {
    const reject = (): ProviderRequestError =>
      new ProviderRequestError('provider rejected the request', {
        failureClass: 'non_retryable',
        httpStatus: 400,
        billedUnknown: false,
      });
    const failing: ImageAdapter = {
      provider: 'fake',
      adapterName: 'FailingImageAdapter',
      stage: 'IM',
      idempotencyProtected: false,
      model: 'fake-nano-banana',
      imageSize: '1K',
      async generate(
        _request: ImageGenerateRequest,
        _context: ImageCallContext,
      ): Promise<ImageGenerateResult> {
        throw reject();
      },
      bind() {
        return {
          provider: 'fake',
          stage: 'IM',
          execute: async (): Promise<ImageGenerateResult> => {
            throw reject();
          },
        };
      },
    };
    const fixture = await createFixture(db, { adapter: failing });
    const { jobId } = await enqueue(db, fixture, fixture.targetSceneId, NEW_PROMPT);
    const result = await runSceneReplace(
      fixture.deps,
      jobFor(fixture, jobId, fixture.targetSceneId),
    );

    expect(result.status).toBe('failed');
    expect(result.failure?.errorClass).toBe('non_retryable');
    expect(result.calls).toEqual({ image: 0, tts: 0 });
    const scene = await db.pool.query<{ asset_id: string; image_prompt: string }>(
      'SELECT asset_id, image_prompt FROM scene WHERE id = $1',
      [fixture.targetSceneId],
    );
    expect(scene.rows[0]!.asset_id).toBe(fixture.oldAssetIdBySceneNo.get('S07'));
    // DI-03: the prompt edit is committed with the enqueue, but the image did not change,
    // so nothing downstream (the render) is invalidated by a failed call.
    const re = await db.pool.query<{ state: string }>(
      "SELECT state FROM video_stage WHERE project_id = $1 AND stage = 'RE'",
      [fixture.seed.projectId],
    );
    expect(re.rows[0]!.state).toBe('done');
    const job = await db.pool.query<{ status: string }>('SELECT status FROM job WHERE id = $1', [
      jobId,
    ]);
    expect(job.rows[0]!.status).toBe('failed');
  });

  it('refuses a job that belongs to another video before any provider call', async () => {
    const fixture = await createFixture(db);
    const other = await seedProject(db.pool);
    const foreignJob = await db.pool.query<{ id: string }>(
      "INSERT INTO job (project_id, stage, status) VALUES ($1, 'IM', 'queued') RETURNING id",
      [other.projectId],
    );
    await expect(
      runSceneReplace(fixture.deps, jobFor(fixture, foreignJob.rows[0]!.id, fixture.targetSceneId)),
    ).rejects.toThrow(/is not an IM replace job/);
    expect((fixture.adapter as FakeImageAdapter).calls).toHaveLength(0);
    const foreign = await db.pool.query<{ status: string }>(
      'SELECT status FROM job WHERE id = $1',
      [foreignJob.rows[0]!.id],
    );
    expect(foreign.rows[0]!.status).toBe('queued');
  });

  it('reopens a COMPLETE video when a replace makes the render stale (4.5)', async () => {
    const fixture = await createFixture(db, { projectStatus: 'COMPLETE' });
    const { jobId } = await enqueue(db, fixture, fixture.targetSceneId, NEW_PROMPT);
    const result = await runSceneReplace(
      fixture.deps,
      jobFor(fixture, jobId, fixture.targetSceneId),
    );
    expect(result.status).toBe('succeeded');
    expect(result.project_status).toBe('NEEDS_ATTENTION');
  });
});
