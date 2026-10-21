import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../../../tests/helpers/pg.js';
import { insertAsset, seedProject, sha256For } from '../../../tests/helpers/web-gateway-seed.js';
import { runMigrations } from '../../db/runner.js';
import { InMemoryContentAddressedStore } from '../../storage/object-store.js';
import { createPostgresDownloadGateway, downloadFilename } from './postgres.js';

const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[download gateway tests skipped] ${SKIP_REASON}`);

const DB_TEST_TIMEOUT_MS = 120_000;

describe('downloadFilename', () => {
  it('slugs the series name and appends the 1-indexed position', () => {
    expect(downloadFilename('Quiet Machines & Neuro!', 3)).toBe('quiet-machines-neuro-3.mp4');
    expect(downloadFilename('quiet-machines', 1)).toBe('quiet-machines-1.mp4');
  });

  it('falls back to a stem rather than emitting an empty filename', () => {
    expect(downloadFilename('  ---  ', 2)).toBe('series-2.mp4');
  });
});

describe.skipIf(!hasDatabase)(
  'Postgres VideoDownloadGateway',
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

    it('returns null when the project has no rendered video asset', async () => {
      const { projectId } = await seedProject(db.pool, { slug: 'download-empty' });
      const gateway = createPostgresDownloadGateway(db.pool, new InMemoryContentAddressedStore());

      await expect(gateway.download(projectId)).resolves.toBeNull();
    });

    it('resolves the newest RE video and reads its bytes with a slug-derived filename', async () => {
      const { projectId, seriesVersionId } = await seedProject(db.pool, { slug: 'quiet-machines' });
      const contentSha256 = sha256For('quiet-machines-video');
      const bytes = new TextEncoder().encode('quiet-machines-video');
      await insertAsset(db.pool, {
        projectId,
        stage: 'RE',
        kind: 'video',
        contentSha256,
        role: 'video',
        mimeType: 'video/mp4',
        sizeBytes: bytes.byteLength,
        seriesVersionId,
      });

      const blobs = new InMemoryContentAddressedStore();
      await blobs.put('sha256:' + contentSha256, bytes, 'video/mp4');
      const gateway = createPostgresDownloadGateway(db.pool, blobs);

      const file = await gateway.download(projectId);
      expect(file).not.toBeNull();
      expect(file!.bytes).toEqual(bytes);
      expect(file!.mimeType).toBe('video/mp4');
      expect(file!.filename).toBe('quiet-machines-1.mp4');
    });

    it('downloads position 1 for the Milestone-A single video (NULL position_in_batch)', async () => {
      const { projectId, seriesVersionId } = await seedProject(db.pool, { slug: 'solo' });
      await db.pool.query('UPDATE project SET position_in_batch = NULL WHERE id = $1', [projectId]);
      const contentSha256 = sha256For('solo-video');
      const bytes = new TextEncoder().encode('solo-video');
      await insertAsset(db.pool, {
        projectId,
        stage: 'RE',
        kind: 'video',
        contentSha256,
        role: 'video',
        mimeType: 'video/mp4',
        sizeBytes: bytes.byteLength,
        seriesVersionId,
      });

      const blobs = new InMemoryContentAddressedStore();
      await blobs.put('sha256:' + contentSha256, bytes, 'video/mp4');
      const gateway = createPostgresDownloadGateway(db.pool, blobs);

      const file = await gateway.download(projectId);
      expect(file?.filename).toBe('solo-1.mp4');
    });
  },
);
