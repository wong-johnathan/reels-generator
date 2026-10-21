import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../../tests/helpers/pg.js';
import {
  isAdapterQualified,
  latestQualification,
  PostgresQualificationStore,
} from '../db/repositories/provider-qualifications.js';
import { runMigrations } from '../db/runner.js';
import { deriveWordTimings, validateWordTimings } from '../domain/word-timing.js';
import { FakeTtsAdapter } from './tts.js';
import { TTS_QUALIFICATION_SAMPLE } from './tts-qualification-sample.js';

/**
 * B-07 Signal, database half: "monotonic word timings derived on the
 * qualification fixture; TTS qual recorded".
 *
 * This is the real write path — FakeTtsAdapter -> deriveWordTimings ->
 * PostgresQualificationStore -> `provider_qualification` — so the pass/fail row
 * the worker's gate reads is the row an operator would get, not an in-memory
 * stand-in.
 */
const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[tts qualification tests skipped] ${SKIP_REASON}`);

const DB_TEST_TIMEOUT_MS = 120_000;

describe.skipIf(!hasDatabase)(
  'TTS qualification recorded (US-012, R-008-3)',
  { timeout: DB_TEST_TIMEOUT_MS },
  () => {
    let db: TestDatabase;
    let store: PostgresQualificationStore;

    beforeAll(async () => {
      db = await createTestDatabase();
      await runMigrations(db.pool);
      store = new PostgresQualificationStore(db.pool);
    }, DB_TEST_TIMEOUT_MS);

    afterAll(async () => {
      await db?.close();
    });

    it('derives monotonic timings on the fixture and records a passing qualification', async () => {
      const adapter = new FakeTtsAdapter();

      const result = await adapter.qualify({ store });

      const row = await latestQualification(db.pool, 'fake', 'tts.fake');
      expect(result.passed).toBe(true);
      expect(row?.passed).toBe(true);
      expect(row?.details).toMatchObject({
        sample_label: TTS_QUALIFICATION_SAMPLE.label,
        monotonic: true,
        word_coverage: 1,
        character_coverage: 1,
      });
      await expect(isAdapterQualified(db.pool, 'fake', 'tts.fake')).resolves.toBe(true);

      // Independently re-derive from the alignment the adapter returned.
      const converted = await adapter.convert(
        {
          text: TTS_QUALIFICATION_SAMPLE.text,
          voice_id: 'fake-voice',
          model_id: 'fake-model',
        },
        {
          id: 'run-qualify-check',
          projectId: 'project-qualify-check',
          stage: 'NA',
          promptHash: 'b'.repeat(64),
        },
      );
      const timings = deriveWordTimings(converted.alignment, {
        script: TTS_QUALIFICATION_SAMPLE.text,
      });
      expect(timings.monotonic).toBe(true);
      expect(validateWordTimings(timings)).toMatchObject({ ok: true, failures: [] });
      expect(timings.words[0]?.start_ms).toBe(0);
      for (let index = 1; index < timings.words.length; index += 1) {
        const previous = timings.words[index - 1]!;
        const current = timings.words[index]!;
        expect(current.start_ms).toBeGreaterThanOrEqual(previous.end_ms);
      }
    });

    it('records a failing qualification that the latest-record gate then refuses', async () => {
      // A payload whose second word starts before the first one ends, and which
      // covers almost none of the fixture text: non-monotonic AND low coverage.
      const adapter = new FakeTtsAdapter({
        alignment: {
          characters: ['a', 'b', ' ', 'c', 'd'],
          character_start_times_seconds: [0, 0.04, 0.05, 0.01, 0.02],
          character_end_times_seconds: [0.04, 0.08, 0.05, 0.02, 0.03],
        },
      });

      const result = await adapter.qualify({ store });

      const row = await latestQualification(db.pool, 'fake', 'tts.fake');
      expect(result.passed).toBe(false);
      expect(result.details.monotonic).toBe(false);
      expect(result.details.failures.join(' ')).toContain('script_coverage');
      expect(row?.passed).toBe(false);
      expect(row?.details).toMatchObject({ monotonic: false });
      await expect(isAdapterQualified(db.pool, 'fake', 'tts.fake')).resolves.toBe(false);
    });
  },
);
