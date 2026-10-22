import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { autoApproveFinal } from '../../worker/auto-approval.js';

import { RenderViewSchema } from '../../../contract/api.js';
import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../../../tests/helpers/pg.js';
import {
  insertAsset,
  seedProject,
  setStageState,
  sha256For,
} from '../../../tests/helpers/web-gateway-seed.js';
import { runMigrations } from '../../db/runner.js';
import { RenderRefusedError } from './gateway.js';
import { createPostgresRenderGateway } from './postgres.js';

const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[render gateway tests skipped] ${SKIP_REASON}`);

const DB_TEST_TIMEOUT_MS = 120_000;

describe.skipIf(!hasDatabase)('Postgres RenderGateway', { timeout: DB_TEST_TIMEOUT_MS }, () => {
  let db: TestDatabase;
  afterEach(() => vi.unstubAllEnvs());

  it('serializes concurrent automatic FA confirmations into one decision and one export job', async () => {
    vi.stubEnv('AUTO_APPROVE_ALL', 'true');
    const { projectId } = await seedRender('auto-fa-concurrent');
    const results = await Promise.allSettled([
      autoApproveFinal(db.pool, projectId, 1),
      autoApproveFinal(db.pool, projectId, 1),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const decisions = await db.pool.query(
      "SELECT reason FROM review_decision WHERE project_id = $1 AND stage = 'FA'",
      [projectId],
    );
    expect(decisions.rows).toEqual([{ reason: 'auto_approve_all' }]);
    const jobs = await db.pool.query("SELECT id FROM job WHERE project_id = $1 AND stage = 'EX'", [
      projectId,
    ]);
    expect(jobs.rows).toHaveLength(1);
  });

  it.each(['true', 'false'])(
    'FA automatic confirmation flag=%s persists a normal decision only when ON',
    async (flag) => {
      vi.stubEnv('AUTO_APPROVE_ALL', flag);
      const { projectId } = await seedRender('auto-fa-' + flag);
      expect(await autoApproveFinal(db.pool, projectId)).toBe(flag === 'true');
      const decisions = await db.pool.query(
        "SELECT decision, reason, revision_at_decision FROM review_decision WHERE project_id = $1 AND stage = 'FA'",
        [projectId],
      );
      expect(decisions.rows).toEqual(
        flag === 'true'
          ? [{ decision: 'approve', reason: 'auto_approve_all', revision_at_decision: 1 }]
          : [],
      );
      const jobs = await db.pool.query(
        "SELECT stage FROM job WHERE project_id = $1 AND stage = 'EX'",
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

  async function seedRender(
    slug: string,
    options: { readonly faState?: string; readonly qcState?: string } = {},
  ) {
    const { projectId, seriesVersionId } = await seedProject(db.pool, { slug });
    await setStageState(db.pool, projectId, 'RE', 'done');
    await setStageState(db.pool, projectId, 'QC', options.qcState ?? 'done', {
      lastEventAt: new Date('2026-10-20T09:05:00Z'),
    });
    await setStageState(db.pool, projectId, 'FA', options.faState ?? 'awaiting_approval');

    const videoId = await insertAsset(db.pool, {
      projectId,
      stage: 'RE',
      kind: 'video',
      contentSha256: sha256For(slug + '-video'),
      role: 'video',
      sizeBytes: 1024,
      seriesVersionId,
      provider: 'ffmpeg',
      model: 'ffmpeg-render',
      rightsMetadata: { wall_time_ms: 5000, peak_ram_mb: 800 },
    });
    const srtId = await insertAsset(db.pool, {
      projectId,
      stage: 'RE',
      kind: 'caption',
      contentSha256: sha256For(slug + '-srt'),
      role: 'srt',
      sizeBytes: 100,
    });
    const vttId = await insertAsset(db.pool, {
      projectId,
      stage: 'RE',
      kind: 'caption',
      contentSha256: sha256For(slug + '-vtt'),
      role: 'vtt',
      sizeBytes: 90,
    });
    return { projectId, seriesVersionId, videoId, srtId, vttId };
  }

  it('returns null when no render video exists yet', async () => {
    const { projectId } = await seedProject(db.pool, { slug: 'render-empty' });
    const gateway = createPostgresRenderGateway(db.pool);

    await expect(gateway.get(projectId)).resolves.toBeNull();
    await expect(gateway.revision?.(projectId)).resolves.toBeNull();
  });

  it('maps a render to a schema-valid RenderView with captions and QC', async () => {
    const { projectId, videoId, srtId, vttId } = await seedRender('render-seeded');
    await db.pool.query(
      `INSERT INTO review_decision (project_id, stage, decision, decided_at)
         VALUES ($1, 'FA', 'approve', '2026-10-20T09:06:00Z')`,
      [projectId],
    );

    const gateway = createPostgresRenderGateway(db.pool);
    const view = await gateway.get(projectId);

    expect(view).not.toBeNull();
    expect(RenderViewSchema.safeParse(view).success).toBe(true);

    expect(view!.approved).toBe(true);
    expect(view!.status).toBe('done');
    expect(view!.approved_at).toBe('2026-10-20T09:06:00.000Z');
    expect(view!.video?.id).toBe(videoId);
    expect(view!.captions.srt?.id).toBe(srtId);
    expect(view!.captions.vtt?.id).toBe(vttId);
    expect(view!.poster).toBeNull();
    expect(view!.render_passes).toBe(1);
    expect(view!.wall_time_s).toBe(5);
    expect(view!.peak_ram_mb).toBe(800);
    expect(view!.qc.status).toBe('pass');
    expect(view!.qc.checked_at).toBe('2026-10-20T09:05:00.000Z');
    expect(view!.qc.checks).toEqual([]);
  });

  it('exposes the render-pass count as the optimistic-lock revision', async () => {
    const { projectId } = await seedRender('render-revision');
    const gateway = createPostgresRenderGateway(db.pool);

    await expect(gateway.revision?.(projectId)).resolves.toBe(1);
  });

  it('approves a render, recording the decision and closing the FA gate', async () => {
    const { projectId } = await seedRender('render-approve');
    const gateway = createPostgresRenderGateway(db.pool);

    const view = await gateway.approve(projectId, { revision: 1 });

    expect(view.approved).toBe(true);
    expect(view.status).toBe('done');
    expect(RenderViewSchema.safeParse(view).success).toBe(true);

    const decision = await db.pool.query<{ revision_at_decision: number | null }>(
      `SELECT revision_at_decision FROM review_decision
          WHERE project_id = $1 AND stage = 'FA' AND decision = 'approve'`,
      [projectId],
    );
    expect(decision.rows).toHaveLength(1);
    expect(decision.rows[0]!.revision_at_decision).toBe(1);

    const fa = await db.pool.query<{ state: string }>(
      `SELECT state FROM video_stage WHERE project_id = $1 AND stage = 'FA'`,
      [projectId],
    );
    expect(fa.rows[0]!.state).toBe('done');
  });

  it('refuses an out-of-date revision', async () => {
    const { projectId } = await seedRender('render-stale');
    const gateway = createPostgresRenderGateway(db.pool);

    await expect(gateway.approve(projectId, { revision: 2 })).rejects.toBeInstanceOf(
      RenderRefusedError,
    );
  });

  it('refuses final approval while QC fails', async () => {
    const { projectId } = await seedRender('render-qc-fail', { qcState: 'failed' });
    const gateway = createPostgresRenderGateway(db.pool);

    await expect(gateway.approve(projectId, { revision: 1 })).rejects.toBeInstanceOf(
      RenderRefusedError,
    );
  });

  it('refuses a second approval', async () => {
    const { projectId } = await seedRender('render-double');
    await db.pool.query(
      `INSERT INTO review_decision (project_id, stage, decision) VALUES ($1, 'FA', 'approve')`,
      [projectId],
    );
    const gateway = createPostgresRenderGateway(db.pool);

    await expect(gateway.approve(projectId, { revision: 1 })).rejects.toBeInstanceOf(
      RenderRefusedError,
    );
  });
});
