import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../../../tests/helpers/pg.js';
import { runMigrations } from '../runner.js';
import {
  insertQualification,
  isAdapterQualified,
  latestQualification,
} from './provider-qualifications.js';

/**
 * `provider_qualification` writes — R-008-3: "Each adapter has a recorded
 * qualification check with a pass/fail result and date" and the worker refuses a
 * billable call when the adapter's latest record is not `passed`.
 *
 * The "latest" rule is the interesting one: an older pass must never re-qualify
 * an adapter after a newer failure, so these tests pin ordering rather than just
 * insert/select.
 */
const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[provider-qualification tests skipped] ${SKIP_REASON}`);

const DB_TEST_TIMEOUT_MS = 120_000;

describe.skipIf(!hasDatabase)(
  'provider_qualification store (R-008-3)',
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

    it('inserts a row and round-trips the jsonb details', async () => {
      const row = await insertQualification(db.pool, {
        provider: 'elevenlabs',
        adapter: 'tts.elevenlabs.convert-with-timestamps',
        passed: true,
        details: { word_coverage: 1, monotonic: true, sample_label: 'unit' },
      });

      expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(row.passed).toBe(true);
      expect(row.details).toEqual({ word_coverage: 1, monotonic: true, sample_label: 'unit' });
      expect(row.run_at).toBeInstanceOf(Date);
    });

    it('returns the newest record for a provider+adapter pair', async () => {
      // Own pair: the first test writes to the elevenlabs pair with run_at = now(),
      // so sharing it would make "newest" depend on the wall clock. Timestamps are
      // deliberately in the past for the same reason — a fixed future date would
      // silently invert this assertion the moment real time passed it.
      const pair = { provider: 'newest-provider', adapter: 'tts.newest' };
      await insertQualification(db.pool, {
        ...pair,
        passed: false,
        details: { note: 'older' },
        runAt: new Date('2020-01-01T10:00:00Z'),
      });
      await insertQualification(db.pool, {
        ...pair,
        passed: true,
        details: { note: 'newer' },
        runAt: new Date('2020-01-02T10:00:00Z'),
      });

      const latest = await latestQualification(db.pool, pair.provider, pair.adapter);

      expect(latest?.passed).toBe(true);
      expect(latest?.details).toEqual({ note: 'newer' });
    });

    it('is not qualified when the newest record failed, even if an older one passed', async () => {
      const pair = { provider: 'fake', adapter: 'tts.fake' };
      await insertQualification(db.pool, {
        ...pair,
        passed: true,
        details: {},
        runAt: new Date('2020-01-01T10:00:00Z'),
      });
      await insertQualification(db.pool, {
        ...pair,
        passed: false,
        details: { reason: 'coverage regressed' },
        runAt: new Date('2020-01-02T10:00:00Z'),
      });

      await expect(isAdapterQualified(db.pool, pair.provider, pair.adapter)).resolves.toBe(false);
    });

    it('is not qualified when no record exists at all (fail closed)', async () => {
      await expect(isAdapterQualified(db.pool, 'never-run', 'tts.never-run')).resolves.toBe(false);
      await expect(latestQualification(db.pool, 'never-run', 'tts.never-run')).resolves.toBeNull();
    });

    it('scopes records per adapter: a pass for one adapter does not qualify another', async () => {
      // A distinct provider pair keeps this test independent of the rows the
      // tests above wrote into the same database.
      await insertQualification(db.pool, {
        provider: 'scope-provider',
        adapter: 'tts.scope-adapter-a',
        passed: true,
        details: {},
      });

      await expect(
        isAdapterQualified(db.pool, 'scope-provider', 'tts.scope-adapter-a'),
      ).resolves.toBe(true);
      await expect(
        isAdapterQualified(db.pool, 'scope-provider', 'tts.scope-adapter-b'),
      ).resolves.toBe(false);
    });
  },
);
