import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { autoApproveStoryboard } from '../../worker/auto-approval.js';

import { StoryboardViewSchema } from '../../../contract/api.js';
import { runMigrations } from '../../db/runner.js';
import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../../../tests/helpers/pg.js';
import { seedProject } from '../../../tests/helpers/fixtures.js';
import { insertVideoStage, readVideoStage } from '../../../tests/helpers/stage-fixtures.js';
import { createPostgresSceneGateway } from './postgres.js';
import { SceneConflictError, SceneNotFoundError } from './gateway.js';

/**
 * `SceneGateway` over Postgres — the S-11/S-12/S-13 surfaces. These tests pin
 * the three properties the adapter must guarantee:
 *   1. reads return the documented null for an unknown id, and a schema-valid
 *      view for seeded rows (no field is invented);
 *   2. `approveStoryboard` flips the SB gate exactly once and a retry is a
 *      no-op, not a duplicate decision;
 *   3. mutating members throw the gateway's own typed errors, not pg errors.
 */
const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[scene postgres adapter tests skipped] ${SKIP_REASON}`);

const DB_TEST_TIMEOUT_MS = 120_000;

describe.skipIf(!hasDatabase)('SceneGateway (postgres)', { timeout: DB_TEST_TIMEOUT_MS }, () => {
  let db: TestDatabase;
  afterEach(() => vi.unstubAllEnvs());

  it('serializes concurrent automatic SB confirmations into one decision and one IM job', async () => {
    vi.stubEnv('AUTO_APPROVE_ALL', 'true');
    const { projectId } = await seedStoryboard();
    await insertVideoStage(db.pool, projectId, 'SB', 'awaiting_approval');
    await Promise.all([
      autoApproveStoryboard(db.pool, projectId),
      autoApproveStoryboard(db.pool, projectId),
    ]);
    const decisions = await db.pool.query(
      "SELECT reason FROM review_decision WHERE project_id = $1 AND stage = 'SB'",
      [projectId],
    );
    expect(decisions.rows).toEqual([{ reason: 'auto_approve_all' }]);
    const jobs = await db.pool.query("SELECT id FROM job WHERE project_id = $1 AND stage = 'IM'", [
      projectId,
    ]);
    expect(jobs.rows).toHaveLength(1);
  });

  it.each(['true', 'false'])(
    'SB automatic confirmation flag=%s persists one decision and mints IM only when ON',
    async (flag) => {
      vi.stubEnv('AUTO_APPROVE_ALL', flag);
      const { projectId } = await seedStoryboard();
      await insertVideoStage(db.pool, projectId, 'SB', 'awaiting_approval');
      expect(await autoApproveStoryboard(db.pool, projectId)).toBe(flag === 'true');
      await autoApproveStoryboard(db.pool, projectId); // duplicate delivery
      const decisions = await db.pool.query(
        "SELECT decision, reason, revision_at_decision FROM review_decision WHERE project_id = $1 AND stage = 'SB'",
        [projectId],
      );
      expect(decisions.rows).toEqual(
        flag === 'true'
          ? [{ decision: 'approve', reason: 'auto_approve_all', revision_at_decision: 1 }]
          : [],
      );
      const jobs = await db.pool.query(
        "SELECT stage FROM job WHERE project_id = $1 AND stage = 'IM'",
        [projectId],
      );
      expect(jobs.rows).toHaveLength(flag === 'true' ? 1 : 0);
    },
  );

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.pool);
  }, DB_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await db?.close();
  });

  /** A project plus three fully-populated scenes; scene 1 carries an image asset. */
  async function seedStoryboard() {
    const seeded = await seedProject(db.pool);
    await db.pool.query(
      'UPDATE project SET target_duration_s = 75, storyboard_revision = 1 WHERE id = $1',
      [seeded.projectId],
    );

    const sceneIds: string[] = [];
    for (const index of [1, 2, 3]) {
      const sceneNo = `S0${index}`;
      const result = await db.pool.query<{ id: string }>(
        `INSERT INTO scene
             (project_id, scene_no, position, narration_start_ms, narration_end_ms,
              image_prompt, camera_move, caption_emphasis, fallback_text,
              uses_protagonist, revision)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1) RETURNING id`,
        [
          seeded.projectId,
          sceneNo,
          index,
          (index - 1) * 4400,
          index * 4400,
          `prompt for ${sceneNo}`,
          index === 1 ? 'zoom_in' : 'static',
          index === 1 ? 'narration' : null,
          `fallback ${sceneNo}`,
          true,
        ],
      );
      sceneIds.push(result.rows[0]!.id);
    }

    // One content-addressed image on scene 1, so the asset mapping and the
    // `done` state derivation are both exercised. The hash is unique per seed
    // (asset has UNIQUE(content_sha256), R-026).
    const assetSha = randomBytes(32).toString('hex');
    const asset = await db.pool.query<{ id: string }>(
      `INSERT INTO asset
           (project_id, stage, kind, content_sha256, object_key, object_size_bytes, width, height,
            provider, model, prompt_hash, prompt_text, seed, series_version_id)
         VALUES ($1, 'IM', 'image', $2, 'sha256:' || $2, 184320, 768, 1376,
                 'gemini', 'gemini-nano-banana-2.1', 'ph-1', 'ink illustration', '1729411200', $3)
         RETURNING id`,
      [seeded.projectId, assetSha, seeded.seriesVersionId],
    );
    await db.pool.query('UPDATE scene SET asset_id = $1 WHERE id = $2', [
      asset.rows[0]!.id,
      sceneIds[0]!,
    ]);

    return { ...seeded, sceneIds, assetSha };
  }

  it('returns null for an unknown video', async () => {
    const gateway = createPostgresSceneGateway(db.pool);
    await expect(gateway.storyboard(randomUUID())).resolves.toBeNull();
    await expect(gateway.scene(randomUUID(), randomUUID())).resolves.toBeNull();
  });

  it('maps seeded scenes to a schema-valid storyboard view', async () => {
    const { projectId, assetSha } = await seedStoryboard();
    const gateway = createPostgresSceneGateway(db.pool);
    const board = await gateway.storyboard(projectId);

    expect(board).not.toBeNull();
    const parsed = StoryboardViewSchema.safeParse(board);
    expect(parsed.success).toBe(true);

    expect(board!.project_id).toBe(projectId);
    expect(board!.revision).toBe(1);
    expect(board!.scene_count).toBe(3);
    expect(board!.target_scene_count).toBe(17); // targetSceneCount(75)
    expect(board!.approved).toBe(false);
    expect(board!.approved_at).toBeNull();
    expect(board!.first_three_reviewed).toBe(false);

    const [first, second] = board!.scenes;
    expect(first).toBeDefined();
    expect(first!.scene_no).toBe('S01');
    expect(first!.position).toBe(1);
    expect(first!.camera_move).toBe('zoom_in');
    expect(first!.caption_emphasis).toBe('narration');
    expect(first!.uses_protagonist).toBe(true);
    expect(first!.narration).toEqual({ start_ms: 0, end_ms: 4400 });
    expect(first!.asset).not.toBeNull();
    expect(first!.state).toBe('done');
    expect(first!.asset!.content_sha256).toBe(assetSha);
    expect(first!.asset!.size_bytes).toBe(184320);
    expect(first!.asset!.provenance.series_version).toBe(1);

    expect(second!.asset).toBeNull();
    expect(second!.state).toBe('not_run');
  });

  it('maps a single seeded scene to a schema-valid view', async () => {
    const { projectId, sceneIds } = await seedStoryboard();
    const gateway = createPostgresSceneGateway(db.pool);
    const scene = await gateway.scene(projectId, sceneIds[1]!);

    expect(scene).not.toBeNull();
    expect(scene!.id).toBe(sceneIds[1]!);
    expect(scene!.scene_no).toBe('S02');
    expect(scene!.position).toBe(2);
  });

  it('approves the storyboard once and is idempotent on retry', async () => {
    const { projectId } = await seedStoryboard();
    await insertVideoStage(db.pool, projectId, 'SB', 'awaiting_approval');
    const gateway = createPostgresSceneGateway(db.pool);

    const approved = await gateway.approveStoryboard(projectId, { revision: 1, note: 'ship it' });
    expect(approved.approved).toBe(true);
    expect(approved.approved_at).not.toBeNull();
    expect(approved.revision).toBe(2);

    const sbStage = await readVideoStage(db.pool, projectId, 'SB');
    expect(sbStage?.state).toBe('done');

    const decisions = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM review_decision
          WHERE project_id = $1 AND stage = 'SB' AND decision = 'approve'`,
      [projectId],
    );
    expect(decisions.rows[0]!.n).toBe(1);

    // Retry with the fresh revision: no duplicate decision, no error, no bump.
    const retried = await gateway.approveStoryboard(projectId, { revision: 2 });
    expect(retried.approved).toBe(true);
    expect(retried.revision).toBe(2);

    const decisionsAfter = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM review_decision
          WHERE project_id = $1 AND stage = 'SB' AND decision = 'approve'`,
      [projectId],
    );
    expect(decisionsAfter.rows[0]!.n).toBe(1);
    expect((await readVideoStage(db.pool, projectId, 'SB'))?.state).toBe('done');
  });

  it('throws typed errors for unknown ids and stale revisions', async () => {
    const { projectId, sceneIds } = await seedStoryboard();
    const gateway = createPostgresSceneGateway(db.pool);

    await expect(gateway.approveStoryboard(randomUUID(), { revision: 1 })).rejects.toBeInstanceOf(
      SceneNotFoundError,
    );
    await expect(gateway.approveStoryboard(projectId, { revision: 99 })).rejects.toBeInstanceOf(
      SceneConflictError,
    );

    await expect(
      gateway.replaceImage(projectId, randomUUID(), { revision: 1 }),
    ).rejects.toBeInstanceOf(SceneNotFoundError);
    await expect(
      gateway.replaceImage(projectId, sceneIds[0]!, { revision: 99 }),
    ).rejects.toBeInstanceOf(SceneConflictError);
  });

  it('applies a prompt override and enqueues the replacement job transactionally', async () => {
    const { projectId, sceneIds } = await seedStoryboard();
    const gateway = createPostgresSceneGateway(db.pool);

    await gateway.replaceImage(projectId, sceneIds[1]!, {
      revision: 1,
      image_prompt: 'replacement prompt',
    });

    const scene = await db.pool.query<{ image_prompt: string; revision: number }>(
      'SELECT image_prompt, revision FROM scene WHERE id = $1',
      [sceneIds[1]!],
    );
    expect(scene.rows[0]!.image_prompt).toBe('replacement prompt');
    expect(scene.rows[0]!.revision).toBe(2);

    const job = await db.pool.query<{ stage: string; status: string }>(
      `SELECT stage, status FROM job WHERE project_id = $1 AND scene_id = $2 AND stage = 'IM'`,
      [projectId, sceneIds[1]!],
    );
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0]!.status).toBe('queued');
  });
});
