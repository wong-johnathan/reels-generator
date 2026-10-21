import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ExportViewSchema } from '../../../contract/api.js';
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
import { ExportRefusedError } from './gateway.js';
import { createPostgresExportGateway } from './postgres.js';

const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[export gateway tests skipped] ${SKIP_REASON}`);

const DB_TEST_TIMEOUT_MS = 120_000;

describe.skipIf(!hasDatabase)('Postgres ExportGateway', { timeout: DB_TEST_TIMEOUT_MS }, () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.pool);
  }, DB_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await db?.close();
  });

  it('returns an empty export view before the package is built', async () => {
    const { projectId } = await seedProject(db.pool, { slug: 'export-empty' });
    const gateway = createPostgresExportGateway(db.pool);

    const view = await gateway.get(projectId);

    expect(ExportViewSchema.safeParse(view).success).toBe(true);
    expect(view!.status).toBe('not_run');
    expect(view!.files).toEqual([]);
    expect(view!.total_bytes).toBe(0);
    expect(view!.package_built_at).toBeNull();
    expect(view!.pins).toEqual([]);
  });

  it('maps a built package to a schema-valid ExportView with pins', async () => {
    const { projectId, seriesVersionId } = await seedProject(db.pool, {
      slug: 'export-seeded',
      targetDurationS: 60,
    });

    // Per-stage pins (R-002-4): the producing stages pin series_version 1.
    for (const stage of ['T', 'RS', 'SC', 'SB', 'IM', 'NA']) {
      await setStageState(db.pool, projectId, stage, 'done', { seriesVersionId });
    }
    await setStageState(db.pool, projectId, 'EX', 'done');

    // The render's content-addressed rows (reused by the package, R-026).
    const videoId = await insertAsset(db.pool, {
      projectId,
      stage: 'RE',
      kind: 'video',
      contentSha256: sha256For('export-video'),
      role: 'video',
      sizeBytes: 4000,
    });
    const srtId = await insertAsset(db.pool, {
      projectId,
      stage: 'RE',
      kind: 'caption',
      contentSha256: sha256For('export-srt'),
      role: 'srt',
      sizeBytes: 100,
    });
    const vttId = await insertAsset(db.pool, {
      projectId,
      stage: 'RE',
      kind: 'caption',
      contentSha256: sha256For('export-vtt'),
      role: 'vtt',
      sizeBytes: 90,
    });

    const stem = 'my-reel';
    const sidecar = (name: string, size: number): Promise<string> =>
      insertAsset(db.pool, {
        projectId,
        stage: 'EX',
        kind: 'sidecar',
        contentSha256: sha256For('export-' + name),
        role: 'sidecar',
        sizeBytes: size,
        rightsMetadata: { stage: 'EX', role: 'sidecar', name, package_stem: stem },
      });
    const manifestId = await sidecar('package-manifest.json', 30);
    const metadataId = await sidecar('metadata.json', 200);
    const sourcesId = await sidecar('sources.json', 300);

    // Stamp the manifest as the build marker.
    await db.pool.query('UPDATE asset SET created_at = $2 WHERE id = $1', [
      manifestId,
      new Date('2026-10-20T10:00:00Z'),
    ]);

    const gateway = createPostgresExportGateway(db.pool);
    const view = await gateway.get(projectId);

    expect(ExportViewSchema.safeParse(view).success).toBe(true);
    expect(view!.status).toBe('done');
    expect(view!.package_built_at).toBe('2026-10-20T10:00:00.000Z');

    const byKind = new Map(view!.files.map((file) => [file.kind, file]));
    expect(byKind.get('video')).toMatchObject({ name: 'my-reel.mp4', size_bytes: 4000 });
    expect(byKind.get('video')!.url).toBe('/asset/' + videoId + '/full');
    expect(byKind.get('srt')!.url).toBe('/asset/' + srtId + '/full');
    expect(byKind.get('vtt')!.url).toBe('/asset/' + vttId + '/full');
    expect(byKind.get('sidecar')!.name).toBe('metadata.json');
    expect(byKind.get('manifest')!.name).toBe('sources.json');

    // The internal package-manifest is not a deliverable file.
    expect(view!.files.some((file) => file.name === 'package-manifest.json')).toBe(false);
    expect(view!.total_bytes).toBe(4000 + 100 + 90 + 200 + 300);

    const pinStages = view!.pins.map((pin) => pin.stage).sort();
    expect(pinStages).toEqual(['IM', 'NA', 'RS', 'SB', 'SC', 'T']);
    expect(view!.pins[0]!.series_version).toBe(1);
    expect(view!.pins[0]!.series_version_id).toBe(seriesVersionId);

    expect(view!.manifest).toBeNull();
    expect(
      [metadataId, sourcesId].every((id) =>
        view!.files.some((f) => f.url === '/asset/' + id + '/full'),
      ),
    ).toBe(true);
  });

  it('refuses to build before final approval', async () => {
    const { projectId } = await seedProject(db.pool, { slug: 'export-build-no-fa' });
    const gateway = createPostgresExportGateway(db.pool);

    await expect(gateway.build?.(projectId)).rejects.toBeInstanceOf(ExportRefusedError);
  });

  it('refuses to build without a render, and refuses the unwired queue otherwise', async () => {
    const { projectId } = await seedProject(db.pool, { slug: 'export-build-no-render' });
    const gateway = createPostgresExportGateway(db.pool);

    await expect(gateway.build?.(projectId)).rejects.toBeInstanceOf(ExportRefusedError);

    await db.pool.query(
      `INSERT INTO review_decision (project_id, stage, decision) VALUES ($1, 'FA', 'approve')`,
      [projectId],
    );
    await expect(gateway.build?.(projectId)).rejects.toBeInstanceOf(ExportRefusedError);

    await insertAsset(db.pool, {
      projectId,
      stage: 'RE',
      kind: 'video',
      contentSha256: sha256For('export-build-video'),
      role: 'video',
      sizeBytes: 10,
    });
    await expect(gateway.build?.(projectId)).rejects.toBeInstanceOf(ExportRefusedError);
  });
});
