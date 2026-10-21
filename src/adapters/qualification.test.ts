import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../../tests/helpers/pg.js';
import { runMigrations } from '../db/runner.js';
import {
  QualificationGateError,
  assertLatestQualificationPassed,
  latestQualification,
  recordQualification,
} from './qualification.js';
import { FakeResearchAdapter, fakeSource } from './research-fake.js';
import { qualifyResearch } from './research.js';

const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[qualification tests skipped] ${SKIP_REASON}`);

describe.skipIf(!hasDatabase)('provider_qualification row + gate (R-008-3)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.pool);
  }, 120_000);

  afterAll(async () => {
    await db.close();
  });

  it('writes a pass row with details and reads back the newest record', async () => {
    const earlier = await recordQualification(db.pool, {
      provider: 'fake',
      adapter: 'research',
      passed: false,
      details: { claims_resolved: 1 },
      runAt: new Date('2026-10-20T00:00:00.000Z'),
    });
    expect(earlier.passed).toBe(false);

    const later = await recordQualification(db.pool, {
      provider: 'fake',
      adapter: 'research',
      passed: true,
      details: { claims_resolved: 3, claims_total: 5, threshold: 3 },
      runAt: new Date('2026-10-21T00:00:00.000Z'),
    });
    expect(later.passed).toBe(true);
    expect(later.details).toMatchObject({ claims_resolved: 3 });
    expect(later.run_at.toISOString()).toBe('2026-10-21T00:00:00.000Z');

    const latest = await latestQualification(db.pool, 'fake', 'research');
    expect(latest?.id).toBe(later.id);
    expect(latest?.details).toEqual({ claims_resolved: 3, claims_total: 5, threshold: 3 });
    await expect(
      assertLatestQualificationPassed(db.pool, 'fake', 'research'),
    ).resolves.toBeUndefined();
  });

  it('refuses to issue a billable call when the latest record failed', async () => {
    const failed = await recordQualification(db.pool, {
      provider: 'fake',
      adapter: 'research',
      passed: false,
      details: { claims_resolved: 2, claims_total: 5, threshold: 3 },
      runAt: new Date('2026-10-22T00:00:00.000Z'),
    });

    const error = await assertLatestQualificationPassed(db.pool, 'fake', 'research').catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(QualificationGateError);
    expect((error as QualificationGateError).latest?.id).toBe(failed.id);
    expect((error as Error).message).toMatch(/not passed/);
  });

  it('refuses when there is no record at all, and scopes by provider and adapter', async () => {
    await expect(
      assertLatestQualificationPassed(db.pool, 'deepseek', 'research'),
    ).rejects.toBeInstanceOf(QualificationGateError);
    await expect(latestQualification(db.pool, 'deepseek', 'research')).resolves.toBeNull();
    // A pass for one adapter does not qualify another.
    await recordQualification(db.pool, {
      provider: 'fake',
      adapter: 'text',
      passed: true,
      details: { schemas: 3 },
      runAt: new Date('2026-10-23T00:00:00.000Z'),
    });
    await expect(
      assertLatestQualificationPassed(db.pool, 'fake', 'research'),
    ).rejects.toBeInstanceOf(QualificationGateError);
  });

  it('records a real 3-of-5 pass through qualifyResearch + SQL (B-05 Signal)', async () => {
    const claims = ['claim one', 'claim two', 'claim three', 'claim four', 'claim five'];
    const fixtures = {
      'claim one': [fakeSource({ url: 'https://one.fixture.test/a', rerank_score: 1.52 })],
      'claim two': [fakeSource({ url: 'https://two.fixture.test/b', rerank_score: 1.8 })],
      'claim three': [fakeSource({ url: 'https://three.fixture.test/c', rerank_score: 1.6 })],
      'claim four': [fakeSource({ url: 'https://four.fixture.test/d', rerank_score: 1.1 })],
      'claim five': [],
    } satisfies Record<string, ReturnType<typeof fakeSource>[]>;

    const adapter = new FakeResearchAdapter({ fixtures });
    const result = await qualifyResearch(adapter, {
      db: db.pool,
      run: (_operation, index) => ({ id: `b05-qual-run-${index}`, stage: 'RS' }),
      resolveUrl: async (url) => !url.includes('three.fixture.test'),
      claims,
      now: () => new Date('2026-10-24T00:00:00.000Z'),
    });

    expect(result.passed).toBe(false);
    expect(result.recorded).toBe(true);
    expect(result.details.claims_resolved).toBe(2);

    const second = await qualifyResearch(
      new FakeResearchAdapter({
        fixtures: {
          ...fixtures,
          'claim three': [fakeSource({ url: 'https://three.fixture.test/c', rerank_score: 1.6 })],
        },
      }),
      {
        db: db.pool,
        run: (_operation, index) => ({ id: `b05-qual-run-${index}-b`, stage: 'RS' }),
        resolveUrl: async () => true,
        claims,
        now: () => new Date('2026-10-25T00:00:00.000Z'),
      },
    );

    expect(second.passed).toBe(true);
    expect(second.details.claims_resolved).toBe(3);
    const latest = await latestQualification(db.pool, 'fake', 'research');
    expect(latest?.passed).toBe(true);
    expect(latest?.details).toMatchObject({ claims_resolved: 3, claims_total: 5, threshold: 3 });
    expect(latest?.run_at.toISOString()).toBe('2026-10-25T00:00:00.000Z');
    await expect(
      assertLatestQualificationPassed(db.pool, 'fake', 'research'),
    ).resolves.toBeUndefined();
  });
});
