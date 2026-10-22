import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../../../tests/helpers/pg.js';
import { sha256For, insertAsset } from '../../../tests/helpers/web-gateway-seed.js';
import { runMigrations } from '../../db/runner.js';
import { createBatch } from '../../domain/batch.js';
import { createSeriesGateway } from '../series/postgres.js';
import {
  compareSeriesIndexEntries,
  loadBatchesForSeries,
  loadSeriesBatchIndex,
} from './postgres.js';

/**
 * The batch read models are SQL over `series`/`batch`/`project`/`asset`: the
 * series isolation, newest-first ordering and status/progress aggregation only
 * exist against a real Postgres, so there is no in-memory surrogate. The
 * ordering rule itself (`compareSeriesIndexEntries`) is pure and tested without
 * a database so CI without `TEST_DATABASE_URL` still proves it.
 */
const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[batch read-model postgres tests skipped] ${SKIP_REASON}`);

const DB_TEST_TIMEOUT_MS = 120_000;

function profile(): Record<string, unknown> {
  return {
    niche: { subject: 'psychology for founders' },
    script_style: { tone: 'dry' },
    voice_config: { voice_id: 'voice-a', speed: 1 },
    art_style: { preset: 'inking-comic' },
    default_aspect_ratio: '9:16',
    target_duration_s: 75,
    narration_language: 'en',
    captions_preset: null,
    music_config: null,
    image_resolution: '1K',
    mode: 'creative',
  };
}

describe('compareSeriesIndexEntries (pure ordering rule)', () => {
  const entry = (name: string, id: string) => ({ seriesName: name, seriesId: id });

  it('sorts case-insensitively by name', () => {
    const rows = [entry('banana', 'b'), entry('Apple', 'a'), entry('cherry', 'c')];
    expect([...rows].sort(compareSeriesIndexEntries).map((row) => row.seriesName)).toEqual([
      'Apple',
      'banana',
      'cherry',
    ]);
  });

  it('breaks equal names (ignoring case) by series id', () => {
    const rows = [entry('apple', 'z'), entry('Apple', 'a'), entry('APPLE', 'm')];
    expect([...rows].sort(compareSeriesIndexEntries).map((row) => row.seriesId)).toEqual([
      'a',
      'm',
      'z',
    ]);
  });

  it('is zero only for the same name and id, and orders deterministically otherwise', () => {
    expect(compareSeriesIndexEntries(entry('a', '1'), entry('a', '1'))).toBe(0);
    expect(compareSeriesIndexEntries(entry('a', '1'), entry('a', '2'))).toBeLessThan(0);
    expect(compareSeriesIndexEntries(entry('b', '0'), entry('a', '9'))).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasDatabase)(
  'Postgres batch read models (S-05)',
  { timeout: DB_TEST_TIMEOUT_MS },
  () => {
    let db: TestDatabase;
    let slugCounter = 0;

    beforeAll(async () => {
      db = await createTestDatabase();
      await runMigrations(db.pool);
    }, DB_TEST_TIMEOUT_MS);

    afterAll(async () => {
      await db?.close();
    });

    async function mkSeries(name: string): Promise<{ id: string }> {
      slugCounter += 1;
      const created = await createSeriesGateway(db.pool).create({
        name,
        slug: `batch-rm-${process.pid}-${slugCounter}`,
        profile: profile(),
      });
      return { id: created.id };
    }

    it('returns only that series batches, newest first', async () => {
      const a = await mkSeries('Alpha');
      const b = await mkSeries('Beta');

      const older = await createBatch(db.pool, { seriesId: a.id });
      const newer = await createBatch(db.pool, { seriesId: a.id });
      await createBatch(db.pool, { seriesId: b.id });

      await db.pool.query('UPDATE batch SET created_at = $2 WHERE id = $1', [
        older.batchId,
        new Date('2026-01-01T00:00:00.000Z'),
      ]);
      await db.pool.query('UPDATE batch SET created_at = $2 WHERE id = $1', [
        newer.batchId,
        new Date('2026-01-02T00:00:00.000Z'),
      ]);

      const rows = await loadBatchesForSeries(db.pool, a.id);
      expect(rows.map((row) => row.id)).toEqual([newer.batchId, older.batchId]);
      expect(rows.every((row) => row.seriesId === a.id)).toBe(true);
      expect(rows.some((row) => row.seriesName === 'Beta')).toBe(false);
    });

    it('returns an empty list for a series with no batches and for an unknown series', async () => {
      const empty = await mkSeries('Empty');
      await expect(loadBatchesForSeries(db.pool, empty.id)).resolves.toEqual([]);
      await expect(
        loadBatchesForSeries(db.pool, 'aaaaaaaa-0000-4000-8000-000000000000'),
      ).resolves.toEqual([]);
    });

    it('orders the index case-insensitively and aggregates status and progress', async () => {
      const apple = await mkSeries('apple');
      await mkSeries('banana');
      await mkSeries('Cherry');

      const active = await createBatch(db.pool, { seriesId: apple.id });
      const complete = await createBatch(db.pool, { seriesId: apple.id });
      await db.pool.query(`UPDATE batch SET status = 'COMPLETE' WHERE id = $1`, [complete.batchId]);

      // One rendered MP4 for the active batch's first project.
      await insertAsset(db.pool, {
        projectId: active.projectIds[0]!,
        stage: 'RE',
        kind: 'video',
        contentSha256: sha256For('batch-rm-video'),
        role: 'video',
      });

      const index = await loadSeriesBatchIndex(db.pool);
      expect(index.map((entry) => entry.seriesName)).toEqual(['apple', 'banana', 'Cherry']);

      const appleEntry = index.find((entry) => entry.seriesName === 'apple');
      expect(appleEntry).toBeDefined();
      expect(appleEntry?.batchCount).toBe(2);
      expect(appleEntry?.activeBatches).toBe(1);
      expect(appleEntry?.completeBatches).toBe(1);
      expect(appleEntry?.cancelledBatches).toBe(0);
      // Each batch has one project (no videos_per_batch in the snapshot → 1).
      expect(appleEntry?.videoCount).toBe(2);
      expect(appleEntry?.downloadableCount).toBe(1);
      expect(appleEntry?.newestBatchAt).not.toBeNull();

      const cherryEntry = index.find((entry) => entry.seriesName === 'Cherry');
      expect(cherryEntry?.batchCount).toBe(0);
      expect(cherryEntry?.videoCount).toBe(0);
    });

    it('returns an empty index on an empty database', async () => {
      const fresh = await createTestDatabase();
      try {
        await runMigrations(fresh.pool);
        await expect(loadSeriesBatchIndex(fresh.pool)).resolves.toEqual([]);
      } finally {
        await fresh.close();
      }
    });
  },
);
