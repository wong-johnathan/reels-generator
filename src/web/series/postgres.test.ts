import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SeriesDetailSchema } from '../../../contract/api.js';
import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../../../tests/helpers/pg.js';
import { runMigrations } from '../../db/runner.js';
import { SeriesArchivedError, SeriesConflictError, SeriesSlugTakenError } from './gateway.js';
import { createSeriesGateway } from './postgres.js';

/**
 * The Postgres `SeriesGateway` against a real Postgres: version minting, the
 * optimistic-lock conflict, slug uniqueness and the status→enum mapping are all
 * database properties (M-006 triggers, `unique(slug)`, `status` CHECK), so
 * there is no in-memory surrogate. No provider is involved.
 */
const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[series postgres tests skipped] ${SKIP_REASON}`);

const DB_TEST_TIMEOUT_MS = 120_000;

/** A complete, schema-valid profile the web form would submit. */
function profile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...overrides,
  };
}

describe.skipIf(!hasDatabase)(
  'Postgres SeriesGateway (S-03/S-04)',
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

    it('lists nothing on an empty database', async () => {
      const gateway = createSeriesGateway(db.pool);
      await expect(gateway.list()).resolves.toEqual([]);
    });

    it('returns null for an unknown series id instead of throwing', async () => {
      const gateway = createSeriesGateway(db.pool);
      await expect(gateway.get('aaaaaaaa-0000-4000-8000-000000000000')).resolves.toBeNull();
      await expect(gateway.inFlightVideos?.('aaaaaaaa-0000-4000-8000-000000000000')).resolves.toBe(
        0,
      );
    });

    it('create() mints version 1 and round-trips into a schema-valid detail', async () => {
      const gateway = createSeriesGateway(db.pool);
      const created = await gateway.create({
        name: 'Founders, Quietly',
        slug: `founders-quietly-${process.pid}`,
        profile: profile({ mode: 'factual', target_duration_s: 60 }),
      });

      // The returned value satisfies the frozen contract.
      const parsed = SeriesDetailSchema.parse(created);
      expect(parsed.id).toBe(created.id);
      expect(parsed.name).toBe('Founders, Quietly');
      expect(parsed.mode).toBe('factual');
      expect(parsed.status).toBe('active');
      expect(parsed.current_version).toBe(1);
      expect(parsed.revision).toBe(1);
      expect(parsed.version_count).toBe(1);
      expect(parsed.in_flight_batches).toBe(0);
      expect(parsed.target_duration_s).toBe(60);
      expect(parsed.default_aspect_ratio).toBe('9:16');

      const detail = await gateway.get(created.id);
      expect(detail).not.toBeNull();
      expect(detail?.profile.niche).toEqual({ subject: 'psychology for founders' });
      expect(detail?.profile.narration_language).toBe('en');
    });

    it('maps the series status enum and refuses to edit an archived series', async () => {
      const gateway = createSeriesGateway(db.pool);
      const created = await gateway.create({
        name: 'Archive me',
        slug: `archive-me-${process.pid}`,
        profile: profile(),
      });
      expect((await gateway.get(created.id))?.status).toBe('active');

      await db.pool.query(`UPDATE series SET status = 'archived' WHERE id = $1`, [created.id]);

      const archived = await gateway.get(created.id);
      expect(archived?.status).toBe('archived');

      await expect(
        gateway.update(created.id, { revision: archived?.revision ?? 1, name: 'Renamed' }),
      ).rejects.toBeInstanceOf(SeriesArchivedError);
    });

    it('update() mints a new version and the slug constraint throws the named error', async () => {
      const gateway = createSeriesGateway(db.pool);
      const created = await gateway.create({
        name: 'Edit target',
        slug: `edit-target-${process.pid}`,
        profile: profile(),
      });

      const updated = await gateway.update(created.id, {
        revision: created.revision,
        name: 'Edit target v2',
        profile: profile({ target_duration_s: 90 }),
      });
      expect(updated.current_version).toBe(2);
      expect(updated.revision).toBe(2);
      expect(updated.name).toBe('Edit target v2');
      expect(updated.target_duration_s).toBe(90);
      expect(updated.version_count).toBe(2);

      // A duplicate slug mints neither a series nor a version.
      await expect(
        gateway.create({ name: 'Duplicate', slug: created.slug, profile: profile() }),
      ).rejects.toBeInstanceOf(SeriesSlugTakenError);
    });

    it('rejects a stale revision with the full conflict detail', async () => {
      const gateway = createSeriesGateway(db.pool);
      const created = await gateway.create({
        name: 'Conflict target',
        slug: `conflict-target-${process.pid}`,
        profile: profile(),
      });

      const edited = await gateway.update(created.id, {
        revision: created.revision,
        profile: profile({ narration_language: 'de' }),
      });

      const conflict = await gateway
        .update(created.id, { revision: 1, profile: profile({ narration_language: 'fr' }) })
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(conflict).toBeInstanceOf(SeriesConflictError);
      const asConflict = conflict as SeriesConflictError;
      expect(asConflict.currentRevision).toBe(edited.revision);
      expect(asConflict.currentVersion).toBe(edited.current_version);
      expect(typeof asConflict.savedAt).toBe('string');
    });
  },
);
