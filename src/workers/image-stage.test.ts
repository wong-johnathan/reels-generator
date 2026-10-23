/**
 * B-10 acceptance tests — image stage, provenance, first-three checkpoint (US-019).
 *
 * The provider is B-06 deterministic FakeImageAdapter; the object store is the
 * in-memory content-addressed fake. No network, no paid call: the card forbids
 * both, and a deterministic fake is the only way to assert byte-level dedupe.
 *
 * Signal (LEAD_PLAN 4 B-10): one image per scene with full provenance; the
 * first-three checkpoint blocks scenes 4+ until review.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ProviderRequestError } from '../adapters/errors.js';
import { FakeImageAdapter } from '../adapters/fake-image.js';
import { QualificationGateError } from '../adapters/qualification.js';
import { encodePng } from '../adapters/image-bytes.js';
import { InMemoryImageQualificationStore } from '../adapters/image-qualification.js';
import type {
  ImageAdapter,
  ImageCallContext,
  ImageGenerateRequest,
  ImageGenerateResult,
} from '../adapters/image.js';
import { findVideoStage } from '../db/repositories/video-stages.js';
import { listScenes } from '../db/repositories/scenes.js';
import { recordReviewDecision } from '../db/repositories/review-decisions.js';
import { runMigrations } from '../db/runner.js';
import { InMemoryContentAddressedStore, sha256Hex } from '../storage/object-store.js';
import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../../tests/helpers/pg.js';
import { seedProject, type SeededProject } from '../../tests/helpers/fixtures.js';
import {
  buildImageRequest,
  FIRST_THREE_CHECKPOINT_SCENES,
  ImageStagePreconditionError,
  planImageStage,
  runImageStage,
  type ImageStageDeps,
  type PlannerScene,
} from './image-stage.js';

vi.setConfig({ testTimeout: 120_000 });
const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn('[B-10 image stage tests skipped] ' + SKIP_REASON);
const SCENE_COUNT = 17;

function sceneNo(position: number): string {
  return 'S' + String(position).padStart(2, '0');
}

interface FixtureOptions {
  readonly sceneCount?: number;
  readonly protagonist?: boolean;
  readonly references?: boolean;
  readonly referenceRights?: string | null;
  readonly scriptStatus?: 'draft' | 'approved';
  readonly identicalFirstTwoPrompts?: boolean;
  readonly adapter?: ImageAdapter;
  readonly qualify?: boolean;
}

interface Fixture {
  readonly seed: SeededProject;
  readonly jobId: string;
  readonly adapter: ImageAdapter;
  readonly blobs: InMemoryContentAddressedStore;
  readonly qualification: InMemoryImageQualificationStore;
  readonly deps: ImageStageDeps;
}

async function seedReference(
  db: TestDatabase,
  blobs: InMemoryContentAddressedStore,
  projectId: string,
  rightsNote: string | null,
): Promise<string> {
  const bytes = encodePng({
    width: 64,
    height: 96,
    pixel: (x, y) => [x % 256, y % 256, 40],
    text: { reels_refs: 'reference-set-' + projectId },
  });
  const hash = sha256Hex(bytes);
  const key = 'references/' + hash + '.png';
  await blobs.put(key, bytes, 'image/png');
  const asset = await db.pool.query<{ id: string }>(
    'INSERT INTO asset (project_id, stage, kind, content_sha256, object_key, object_size_bytes, ' +
      'mime_type, width, height, rights_metadata) ' +
      "VALUES ($1, 'REF', 'image', $2, $3, $4, 'image/png', 64, 96, $5::jsonb) RETURNING id",
    [
      projectId,
      hash,
      key,
      bytes.byteLength,
      rightsNote === null ? null : JSON.stringify({ rights_note: rightsNote }),
    ],
  );
  const assetId = asset.rows[0]!.id;
  await db.pool.query(
    "INSERT INTO asset_ref (asset_id, project_id, role) VALUES ($1, $2, 'reference')",
    [assetId, projectId],
  );
  return assetId;
}

async function createFixture(db: TestDatabase, options: FixtureOptions = {}): Promise<Fixture> {
  const seed = await seedProject(db.pool);
  const sceneCount = options.sceneCount ?? SCENE_COUNT;
  const scriptStatus = options.scriptStatus ?? 'approved';
  const tag = seed.projectId.slice(0, 8);
  await db.pool.query(
    'INSERT INTO script_revision (project_id, revision, content, schema_version, status) ' +
      "VALUES ($1, 1, $2::jsonb, 'script.v1', $3)",
    [seed.projectId, JSON.stringify({ hook: '', narration: '', ending: '' }), scriptStatus],
  );
  for (let position = 1; position <= sceneCount; position += 1) {
    const prompt =
      options.identicalFirstTwoPrompts === true && position <= 2
        ? 'identical prompt ' + tag
        : 'scene ' + position + ' prompt ' + tag;
    await db.pool.query(
      'INSERT INTO scene (project_id, scene_no, position, image_prompt, uses_protagonist) ' +
        'VALUES ($1, $2, $3, $4, $5)',
      [seed.projectId, sceneNo(position), position, prompt, options.protagonist ?? false],
    );
  }
  await db.pool.query(
    "INSERT INTO video_stage (project_id, stage, state) VALUES ($1, 'IM', 'not_run')",
    [seed.projectId],
  );
  const job = await db.pool.query<{ id: string }>(
    "INSERT INTO job (project_id, stage, status) VALUES ($1, 'IM', 'queued') RETURNING id",
    [seed.projectId],
  );

  const blobs = new InMemoryContentAddressedStore();
  if (options.references ?? true) {
    await seedReference(
      db,
      blobs,
      seed.projectId,
      'referenceRights' in options
        ? (options.referenceRights ?? null)
        : 'operator-owned character sheet',
    );
  }

  const adapter = options.adapter ?? new FakeImageAdapter();
  const qualification = new InMemoryImageQualificationStore();
  if (options.qualify ?? true) {
    await qualification.record({
      provider: adapter.provider,
      adapter: adapter.adapterName,
      passed: true,
      details: { scenes: 3 },
    });
  }

  const deps: ImageStageDeps = {
    pool: db.pool,
    adapter,
    blobs,
    qualification,
    retentionDays: 30,
    sleep: async () => undefined,
    now: () => new Date('2026-10-21T12:00:00.000Z'),
  };
  return { seed, jobId: job.rows[0]!.id, adapter, blobs, qualification, deps };
}

function plannerScene(
  position: number,
  assetId: string | null = null,
  prompt = 'scene ' + position + ' prompt',
): PlannerScene {
  return {
    id: 'scene-' + position,
    scene_no: sceneNo(position),
    position,
    image_prompt: prompt,
    asset_id: assetId,
  };
}

function fullPlan(sceneCount: number, generatedFirst: number, reviewed: boolean, applies = true) {
  return planImageStage({
    scenes: Array.from({ length: sceneCount }, (_, index) =>
      plannerScene(index + 1, index < generatedFirst ? 'asset-' + index : null),
    ),
    checkpointApplies: applies,
    checkpointReviewed: reviewed,
  });
}

describe('buildImageRequest art-direction binding', () => {
  it('turns the configured comic preset into a mandatory non-photorealistic image instruction', () => {
    const request = buildImageRequest(
      plannerScene(1, null, 'A person at a doorway'),
      { images: [], rights: [], digest: 'empty' },
      '1K',
      false,
      { preset: 'comic' },
    );
    expect(request.prompt).toContain('comic');
    expect(request.prompt).toContain('2D illustration');
    expect(request.prompt).toContain('not photorealistic');
  });
});

describe('planImageStage (PRD 10 first-three checkpoint)', () => {
  it('refuses scenes 4+ while the checkpoint is open', () => {
    const plan = fullPlan(17, 0, false);
    expect(plan.status).toBe('generate');
    expect(plan.to_generate.map((scene) => scene.position)).toEqual([1, 2, 3]);
    expect(plan.blocked_by_checkpoint).toBe(14);
    expect(plan.checkpoint).toMatchObject({
      applies: true,
      reviewed: false,
      open: true,
      first_three_total: FIRST_THREE_CHECKPOINT_SCENES,
      first_three_generated: 0,
      remaining: 17,
    });
  });

  it('stops at awaiting_review with nothing left it may call', () => {
    const plan = fullPlan(17, 3, false);
    expect(plan.status).toBe('awaiting_review');
    expect(plan.to_generate).toEqual([]);
    expect(plan.blocked_by_checkpoint).toBe(14);
  });

  it('releases the remaining scenes once the checkpoint is reviewed', () => {
    const plan = fullPlan(17, 3, true);
    expect(plan.status).toBe('generate');
    expect(plan.to_generate).toHaveLength(14);
    expect(plan.checkpoint.open).toBe(false);
  });

  it('generates every scene in one pass without a recurring protagonist', () => {
    const plan = fullPlan(17, 0, false, false);
    expect(plan.status).toBe('generate');
    expect(plan.to_generate).toHaveLength(17);
    expect(plan.checkpoint.applies).toBe(false);
  });

  it('reports complete when every scene already has an image', () => {
    expect(fullPlan(17, 17, false).status).toBe('complete');
  });

  it('refuses a blank prompt before anything can be billed', () => {
    const scene = plannerScene(1, null, '   ');
    expect(() =>
      planImageStage({ scenes: [scene], checkpointApplies: false, checkpointReviewed: false }),
    ).toThrow(ImageStagePreconditionError);
  });

  it('refuses duplicate scene ids (R-007-2)', () => {
    const scenes = [plannerScene(1), plannerScene(2)];
    const duplicate = { ...scenes[1]!, scene_no: scenes[0]!.scene_no };
    expect(() =>
      planImageStage({
        scenes: [scenes[0]!, duplicate],
        checkpointApplies: false,
        checkpointReviewed: false,
      }),
    ).toThrow(ImageStagePreconditionError);
  });
});

describe.skipIf(!hasDatabase)('image stage (US-019)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.pool);
  }, 240_000);

  afterAll(async () => {
    await db?.close();
  });

  async function imageAssets(projectId: string) {
    const result = await db.pool.query(
      "SELECT * FROM asset WHERE project_id = $1 AND stage = 'IM' ORDER BY created_at ASC, id ASC",
      [projectId],
    );
    return result.rows;
  }

  async function runs(projectId: string) {
    const result = await db.pool.query(
      'SELECT * FROM generation_run WHERE project_id = $1 ORDER BY created_at ASC, id ASC',
      [projectId],
    );
    return result.rows;
  }

  async function projectStatus(projectId: string): Promise<string> {
    const result = await db.pool.query<{ status: string }>(
      'SELECT status FROM project WHERE id = $1',
      [projectId],
    );
    return result.rows[0]!.status;
  }

  it('generates scenes 1-3 only, with full provenance, and parks at the checkpoint', async () => {
    const fixture = await createFixture(db);
    const projectId = fixture.seed.projectId;
    const result = await runImageStage(fixture.deps, { jobId: fixture.jobId, projectId });

    expect(result.status).toBe('awaiting_review');
    expect(result.calls).toBe(3);
    expect((fixture.adapter as FakeImageAdapter).calls).toHaveLength(3);
    expect(result.checkpoint).toMatchObject({
      applies: true,
      reviewed: false,
      open: true,
      first_three_generated: 3,
      remaining: 14,
    });

    const scenes = await listScenes(db.pool, projectId);
    expect(scenes).toHaveLength(17);
    expect(
      scenes.filter((scene) => scene.asset_id !== null).map((scene) => scene.scene_no),
    ).toEqual(['S01', 'S02', 'S03']);

    const images = await imageAssets(projectId);
    expect(images).toHaveLength(3);
    for (const [index, asset] of images.entries()) {
      const scene = scenes[index]!;
      expect(asset.scene_id).toBe(scene.id);
      expect(asset.kind).toBe('image');
      expect(asset.mime_type).toBe('image/png');
      expect(asset.width).toBe(768);
      expect(asset.height).toBe(1376);
      expect(asset.content_sha256).toMatch(/^[0-9a-f]{64}$/);
      // D-F: the key is a readable path, not a hash — <slug>/batch-0001/scenes/S0N.png.
      expect(asset.object_key.endsWith('/batch-0001/scenes/' + scene.scene_no + '.png')).toBe(true);
      expect(Number(asset.object_size_bytes)).toBeGreaterThan(0);
      expect(asset.series_version_id).toBe(fixture.seed.seriesVersionId);
      expect(asset.provider).toBe('fake');
      expect(asset.model).toBe('fake-nano-banana');
      expect(String(asset.seed)).toMatch(/^[0-9]+$/);
      expect(asset.provider_request_id).toMatch(/^fake-image-/);
      expect(asset.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(asset.prompt_text).toBe(scene.image_prompt);
      expect(asset.generation_run_id).not.toBeNull();
      expect(asset.retention_eligible_at).not.toBeNull();
      expect(await fixture.blobs.has(asset.object_key)).toBe(true);

      const rights = asset.rights_metadata as {
        kind: string;
        series_version_id: string;
        reference_rights: Array<{ rights_note: string; asset_id: string }>;
      };
      expect(rights.kind).toBe('generated');
      expect(rights.series_version_id).toBe(fixture.seed.seriesVersionId);
      expect(rights.reference_rights[0]!.rights_note).toBe('operator-owned character sheet');
    }

    const imageRuns = await runs(projectId);
    expect(imageRuns).toHaveLength(3);
    for (const run of imageRuns) {
      expect(run.stage).toBe('IM');
      expect(run.status).toBe('succeeded');
      expect(run.charge_status).toBe('billed');
      expect(run.provider_request_id).toMatch(/^fake-image-/);
      expect(run.asset_id).not.toBeNull();
      expect(run.idempotency_protected).toBe(false);
      expect(run.series_version_id).toBe(fixture.seed.seriesVersionId);
    }
    // TECH_DESIGN 4.7: N scene calls share ONE job attempt row.
    expect(new Set(imageRuns.map((run) => run.job_attempt_id)).size).toBe(1);

    const stage = await findVideoStage(db.pool, projectId, 'IM');
    expect(stage?.state).toBe('running');
    expect(stage?.progress_current).toBe(3);
    expect(stage?.progress_total).toBe(17);
    expect(stage?.series_version_id).toBe(fixture.seed.seriesVersionId);
    expect(await projectStatus(projectId)).toBe('NEEDS_ATTENTION');

    // Signal: the checkpoint blocks scenes 4+ until review, even on a re-run.
    const again = await runImageStage(fixture.deps, { jobId: fixture.jobId, projectId });
    expect(again.status).toBe('awaiting_review');
    expect(again.calls).toBe(0);
    expect((fixture.adapter as FakeImageAdapter).calls).toHaveLength(3);
    expect(await imageAssets(projectId)).toHaveLength(3);
  });

  async function newJob(projectId: string): Promise<string> {
    const result = await db.pool.query<{ id: string }>(
      "INSERT INTO job (project_id, stage, status) VALUES ($1, 'IM', 'queued') RETURNING id",
      [projectId],
    );
    return result.rows[0]!.id;
  }

  it('releases the remaining 14 scenes once the checkpoint is approved', async () => {
    const fixture = await createFixture(db);
    const projectId = fixture.seed.projectId;
    await runImageStage(fixture.deps, { jobId: fixture.jobId, projectId });

    // The operator looked at scenes 1-3 and released the rest (S-12 action).
    await recordReviewDecision(db.pool, { projectId, stage: 'IM', decision: 'approve' });
    const released = await runImageStage(fixture.deps, {
      jobId: await newJob(projectId),
      projectId,
    });

    expect(released.status).toBe('complete');
    expect(released.calls).toBe(14);
    expect(released.checkpoint.open).toBe(false);
    expect((fixture.adapter as FakeImageAdapter).calls).toHaveLength(17);

    const scenes = await listScenes(db.pool, projectId);
    expect(scenes.every((scene) => scene.asset_id !== null)).toBe(true);
    expect(await imageAssets(projectId)).toHaveLength(17);

    const stage = await findVideoStage(db.pool, projectId, 'IM');
    expect(stage?.state).toBe('done');
    expect(stage?.progress_current).toBe(17);
    expect(stage?.stale).toBe(false);
    expect(await projectStatus(projectId)).toBe('RUNNING');
  });

  it('does not honour an approval recorded before the images it claims to review', async () => {
    const fixture = await createFixture(db);
    const projectId = fixture.seed.projectId;
    await recordReviewDecision(db.pool, {
      projectId,
      stage: 'IM',
      decision: 'approve',
      decidedAt: new Date(Date.now() - 3_600_000),
    });

    const first = await runImageStage(fixture.deps, { jobId: fixture.jobId, projectId });
    expect(first.calls).toBe(3);

    const again = await runImageStage(fixture.deps, { jobId: fixture.jobId, projectId });
    expect(again.status).toBe('awaiting_review');
    expect(again.calls).toBe(0);
    expect(await imageAssets(projectId)).toHaveLength(3);
  });

  class FlakyImageAdapter implements ImageAdapter {
    readonly inner = new FakeImageAdapter();
    readonly provider = this.inner.provider;
    readonly adapterName = this.inner.adapterName;
    readonly stage = this.inner.stage;
    readonly idempotencyProtected = this.inner.idempotencyProtected;
    readonly model = this.inner.model;
    readonly imageSize = this.inner.imageSize;
    readonly calls: ImageGenerateRequest[] = [];
    private failuresLeft: number;

    constructor(
      failures: number,
      private readonly error: () => Error,
    ) {
      this.failuresLeft = failures;
    }

    async generate(
      request: ImageGenerateRequest,
      run: ImageCallContext,
    ): Promise<ImageGenerateResult> {
      this.calls.push(request);
      if (this.failuresLeft > 0) {
        this.failuresLeft -= 1;
        throw this.error();
      }
      return this.inner.generate(request, run);
    }

    bind(request: ImageGenerateRequest) {
      return {
        provider: this.provider,
        stage: this.stage,
        execute: (run: ImageCallContext) => this.generate(request, run),
      };
    }
  }

  it('stores one asset per scene even when two prompts are identical (D-F)', async () => {
    const fixture = await createFixture(db, {
      sceneCount: 4,
      identicalFirstTwoPrompts: true,
      references: false,
    });
    const projectId = fixture.seed.projectId;
    const result = await runImageStage(fixture.deps, { jobId: fixture.jobId, projectId });

    expect(result.status).toBe('complete');
    expect(result.calls).toBe(4);
    const scenes = await listScenes(db.pool, projectId);
    // R-026 deduped identical bytes to one asset row. Keys are readable paths now
    // (D-F), so scene 1 and scene 2 are separate objects under separate names —
    // which is the point: a reader must be able to tell which file is which scene.
    expect(scenes[0]!.asset_id).not.toBe(scenes[1]!.asset_id);
    expect(scenes[0]!.asset_id).not.toBe(scenes[2]!.asset_id);
    expect(await imageAssets(projectId)).toHaveLength(4);
    expect(await runs(projectId)).toHaveLength(4);
    expect(fixture.blobs.size).toBe(4);

    const keys = await db.pool.query<{ object_key: string }>(
      'SELECT object_key FROM asset WHERE project_id = $1 ORDER BY object_key',
      [projectId],
    );
    expect(keys.rows.map((row) => row.object_key.split('/').pop())).toEqual([
      'S01.png',
      'S02.png',
      'S03.png',
      'S04.png',
    ]);
  });

  it('retries a transient failure and never regenerates a persisted scene', async () => {
    const flaky = new FlakyImageAdapter(
      1,
      () =>
        new ProviderRequestError('provider answered HTTP 503', {
          failureClass: 'transient',
          httpStatus: 503,
          billedUnknown: false,
        }),
    );
    const fixture = await createFixture(db, { adapter: flaky });
    const projectId = fixture.seed.projectId;
    const result = await runImageStage(fixture.deps, { jobId: fixture.jobId, projectId });

    expect(result.status).toBe('awaiting_review');
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'succeeded']);
    // attempt 1: scene 1 billed, scene 2 threw (no image). attempt 2: scenes 2 and 3.
    expect(result.calls).toBe(3);
    expect(flaky.calls).toHaveLength(4);
    expect(await imageAssets(projectId)).toHaveLength(3);

    const calls = await runs(projectId);
    expect(calls.map((run) => run.status).sort()).toEqual([
      'failed',
      'succeeded',
      'succeeded',
      'succeeded',
    ]);

    const attempts = await db.pool.query(
      'SELECT attempt_no, status, error_class, backoff_s FROM job_attempt WHERE job_id = $1 ORDER BY attempt_no',
      [fixture.jobId],
    );
    expect(
      attempts.rows.map((row) => [row.attempt_no, row.status, row.error_class, row.backoff_s]),
    ).toEqual([
      [1, 'failed', 'transient', 1],
      [2, 'succeeded', null, null],
    ]);
  });

  it('fails the stage on a non-retryable error with no requeue and no asset', async () => {
    const failing = new FlakyImageAdapter(
      99,
      () =>
        new ProviderRequestError('provider answered HTTP 401', {
          failureClass: 'non_retryable',
          httpStatus: 401,
          billedUnknown: false,
        }),
    );
    const fixture = await createFixture(db, { adapter: failing });
    const projectId = fixture.seed.projectId;
    const result = await runImageStage(fixture.deps, { jobId: fixture.jobId, projectId });

    expect(result.status).toBe('failed');
    expect(result.attempts).toHaveLength(1);
    expect(failing.calls).toHaveLength(1);
    expect(await imageAssets(projectId)).toHaveLength(0);

    const calls = await runs(projectId);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe('failed');
    expect(calls[0]!.charge_status).toBe('unbilled');
    expect((await findVideoStage(db.pool, projectId, 'IM'))?.state).toBe('failed');
    expect(await projectStatus(projectId)).toBe('NEEDS_ATTENTION');
    const job = await db.pool.query<{ status: string }>('SELECT status FROM job WHERE id = $1', [
      fixture.jobId,
    ]);
    expect(job.rows[0]!.status).toBe('failed');
  });

  it('refuses to call the provider when the adapter is not qualified (5.6)', async () => {
    const fixture = await createFixture(db, { qualify: false });
    const projectId = fixture.seed.projectId;

    await expect(
      runImageStage(fixture.deps, { jobId: fixture.jobId, projectId }),
    ).rejects.toBeInstanceOf(QualificationGateError);

    expect((fixture.adapter as FakeImageAdapter).calls).toHaveLength(0);
    expect(await imageAssets(projectId)).toHaveLength(0);
    expect((await findVideoStage(db.pool, projectId, 'IM'))?.state).toBe('blocked');
    expect(await projectStatus(projectId)).toBe('NEEDS_ATTENTION');
  });

  it('refuses to generate before the script is approved (R-005-2)', async () => {
    const fixture = await createFixture(db, { scriptStatus: 'draft' });
    const projectId = fixture.seed.projectId;

    await expect(
      runImageStage(fixture.deps, { jobId: fixture.jobId, projectId }),
    ).rejects.toBeInstanceOf(ImageStagePreconditionError);

    expect((fixture.adapter as FakeImageAdapter).calls).toHaveLength(0);
    expect((await findVideoStage(db.pool, projectId, 'IM'))?.state).toBe('blocked');
    expect(await projectStatus(projectId)).toBe('NEEDS_ATTENTION');
  });

  it('refuses a reference image without a rights note (PRD 10)', async () => {
    const fixture = await createFixture(db, { referenceRights: null });
    const projectId = fixture.seed.projectId;

    await expect(
      runImageStage(fixture.deps, { jobId: fixture.jobId, projectId }),
    ).rejects.toBeInstanceOf(ImageStagePreconditionError);

    expect((fixture.adapter as FakeImageAdapter).calls).toHaveLength(0);
    expect(await projectStatus(projectId)).toBe('NEEDS_ATTENTION');
  });

  it('generates all 17 scenes in one pass without a recurring protagonist', async () => {
    const fixture = await createFixture(db, { references: false, protagonist: false });
    const projectId = fixture.seed.projectId;
    const result = await runImageStage(fixture.deps, { jobId: fixture.jobId, projectId });

    expect(result.status).toBe('complete');
    expect(result.calls).toBe(17);
    expect(result.checkpoint.applies).toBe(false);
    expect(await imageAssets(projectId)).toHaveLength(17);
    expect((await findVideoStage(db.pool, projectId, 'IM'))?.state).toBe('done');
    expect(await projectStatus(projectId)).toBe('RUNNING');
  });
});
