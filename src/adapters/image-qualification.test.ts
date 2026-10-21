import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../../tests/helpers/pg.js';
import type { PersistedGenerationRun, ProviderAdapter } from '../domain/generation-run.js';
import { runMigrations } from '../db/runner.js';
import { FakeImageAdapter } from './fake-image.js';
import { encodePng } from './image-bytes.js';
import {
  referenceSetDigest,
  type ImageAdapter,
  type ImageCallContext,
  type ImageGenerateRequest,
  type ImageGenerateResult,
  type ImageSize,
} from './image.js';
import {
  assertImageQualified,
  IMAGE_QUALIFICATION_FIXTURE,
  InMemoryImageQualificationStore,
  PgImageQualificationStore,
  runImageQualification,
} from './image-qualification.js';
import { QualificationGateError } from './qualification.js';

/**
 * A provider adapter with no automatic reference verifier: the real Gemini
 * output can only be judged visually, so the qualifier must not invent a pass.
 */
class StubImageAdapter implements ImageAdapter {
  readonly provider = 'gemini';
  readonly adapterName = 'StubImageAdapter';
  readonly stage = 'IM' as const;
  readonly idempotencyProtected = false;
  readonly model = 'gemini-nano-banana-2.1';
  readonly imageSize: ImageSize = '1K';

  constructor(private readonly failOnCall = false) {}

  async generate(req: ImageGenerateRequest, run: ImageCallContext): Promise<ImageGenerateResult> {
    if (this.failOnCall) throw new Error('provider refused the qualification call');
    return {
      image_bytes: encodePng({
        width: 768,
        height: 1376,
        pixel: (x, y) => [(x + req.prompt.length) % 256, (y + req.prompt.charCodeAt(0)) % 256, 9],
      }),
      mime_type: 'image/png',
      width: 768,
      height: 1376,
      provider_request_id: `stub-${req.prompt.length}`,
      model: this.model,
      idempotency_protected: false,
      run_id: run.id,
    };
  }

  bind(req: ImageGenerateRequest): ProviderAdapter<ImageGenerateResult> {
    return {
      provider: this.provider,
      stage: this.stage,
      execute: (run: PersistedGenerationRun) => this.generate(req, run),
    };
  }
}

describe('runImageQualification with the deterministic fake (B-06 Signal)', () => {
  it('records a pass for three scenes that preserve the same reference', async () => {
    const store = new InMemoryImageQualificationStore();
    const now = () => new Date('2026-10-21T00:00:00.000Z');

    const outcome = await runImageQualification({
      adapter: new FakeImageAdapter(),
      store,
      now,
    });

    expect(outcome.passed).toBe(true);
    expect(outcome.record.provider).toBe('fake');
    expect(outcome.record.adapter).toBe('FakeImageAdapter');
    expect(outcome.record.passed).toBe(true);
    expect(outcome.record.run_at.toISOString()).toBe('2026-10-21T00:00:00.000Z');

    const details = outcome.record.details as {
      threshold: string;
      reference_sha256: string;
      scenes: {
        reference_preserved: boolean;
        image_sha256: string;
        provider_request_id: string;
        run_id: string;
        width: number;
        height: number;
      }[];
    };
    expect(details.threshold).toBe('reference preserved across >=3 scenes');
    expect(details.scenes).toHaveLength(3);
    expect(details.scenes.every((scene) => scene.reference_preserved)).toBe(true);
    expect(new Set(details.scenes.map((scene) => scene.image_sha256)).size).toBe(3);
    expect(details.scenes.map((scene) => [scene.width, scene.height])).toEqual([
      [768, 1376],
      [768, 1376],
      [768, 1376],
    ]);
    expect(details.reference_sha256).toBe(
      referenceSetDigest([IMAGE_QUALIFICATION_FIXTURE.reference]),
    );
    expect(details.scenes.map((scene) => scene.run_id)).toEqual([
      'qualification:fake:0',
      'qualification:fake:1',
      'qualification:fake:2',
    ]);

    await expect(
      assertImageQualified(store, { provider: 'fake', adapterName: 'FakeImageAdapter' }),
    ).resolves.toBeUndefined();
  });

  it('is reproducible: two qualification runs produce the same per-scene image hashes', async () => {
    const first = await runImageQualification({
      adapter: new FakeImageAdapter(),
      store: new InMemoryImageQualificationStore(),
    });
    const second = await runImageQualification({
      adapter: new FakeImageAdapter(),
      store: new InMemoryImageQualificationStore(),
    });

    const hashes = (record: { details: Record<string, unknown> }) =>
      (record.details as { scenes: { image_sha256: string }[] }).scenes.map((s) => s.image_sha256);

    expect(hashes(first.record)).toEqual(hashes(second.record));
  });

  it('records a failure when the reference drifts, and the gate refuses the adapter', async () => {
    const store = new InMemoryImageQualificationStore();
    const outcome = await runImageQualification({
      adapter: new FakeImageAdapter({ simulateReferenceDrift: true }),
      store,
    });

    expect(outcome.passed).toBe(false);
    const details = outcome.record.details as {
      scenes: { reference_preserved: boolean; detail: string }[];
    };
    expect(details.scenes[0]!.reference_preserved).toBe(true);
    expect(details.scenes[1]!.reference_preserved).toBe(false);
    expect(details.scenes[1]!.detail).toContain('drifted');

    await expect(
      assertImageQualified(store, { provider: 'fake', adapterName: 'FakeImageAdapter' }),
    ).rejects.toBeInstanceOf(QualificationGateError);
  });

  it('does not invent a visual pass for a provider with no automatic verifier', async () => {
    const store = new InMemoryImageQualificationStore();
    const outcome = await runImageQualification({ adapter: new StubImageAdapter(), store });

    expect(outcome.passed).toBe(false);
    const details = outcome.record.details as { requires_human_review: boolean; scenes: unknown[] };
    expect(details.requires_human_review).toBe(true);
    expect(details.scenes).toHaveLength(3);
  });

  it('records an operator verdict when one is supplied', async () => {
    const store = new InMemoryImageQualificationStore();
    const outcome = await runImageQualification({
      adapter: new StubImageAdapter(),
      store,
      verdict: { passed: true, reviewer: 'owner', notes: 'identity held across all three panels' },
    });

    expect(outcome.passed).toBe(true);
    const details = outcome.record.details as {
      requires_human_review: boolean;
      verdict: { reviewer: string; passed: boolean };
    };
    expect(details.requires_human_review).toBe(false);
    expect(details.verdict).toEqual({
      passed: true,
      reviewer: 'owner',
      notes: 'identity held across all three panels',
    });
  });

  it('records a generation failure as a failed qualification instead of throwing', async () => {
    const store = new InMemoryImageQualificationStore();
    const outcome = await runImageQualification({
      adapter: new StubImageAdapter(true),
      store,
    });

    expect(outcome.passed).toBe(false);
    const details = outcome.record.details as { error: string; scenes: unknown[] };
    expect(details.error).toContain('provider refused');
    expect(details.scenes).toHaveLength(0);
  });

  it('refuses a fixture below the >=3-scene threshold', async () => {
    await expect(
      runImageQualification({
        adapter: new FakeImageAdapter(),
        store: new InMemoryImageQualificationStore(),
        fixture: {
          name: 'short-fixture',
          reference: IMAGE_QUALIFICATION_FIXTURE.reference,
          scenes: [{ name: 'one', prompt: 'one' }],
        },
      }),
    ).rejects.toThrow(/at least 3 scenes/);
  });
});

describe('qualification gate', () => {
  it('refuses an adapter that has never been qualified', async () => {
    const store = new InMemoryImageQualificationStore();
    await expect(
      assertImageQualified(store, { provider: 'gemini', adapterName: 'GeminiImageAdapter' }),
    ).rejects.toBeInstanceOf(QualificationGateError);
  });

  it('uses only the newest record: an older pass cannot mask a newer failure', async () => {
    const store = new InMemoryImageQualificationStore();
    await store.record({
      provider: 'gemini',
      adapter: 'GeminiImageAdapter',
      passed: true,
      details: { note: 'older pass' },
      runAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    await store.record({
      provider: 'gemini',
      adapter: 'GeminiImageAdapter',
      passed: false,
      details: { note: 'newer failure' },
      runAt: new Date('2026-10-02T00:00:00.000Z'),
    });

    await expect(
      assertImageQualified(store, { provider: 'gemini', adapterName: 'GeminiImageAdapter' }),
    ).rejects.toBeInstanceOf(QualificationGateError);
  });
});

const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[qualification DB tests skipped] ${SKIP_REASON}`);

describe.skipIf(!hasDatabase)('PgImageQualificationStore (R-008-3 record)', () => {
  let db: TestDatabase;
  let store: PgImageQualificationStore;

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.pool);
    store = new PgImageQualificationStore(db.pool);
  }, 180_000);

  afterAll(async () => {
    await db?.close();
  });

  it('writes the fake three-scene qualification row and closes the gate on drift', async () => {
    const passing = await runImageQualification({
      adapter: new FakeImageAdapter(),
      store,
      now: () => new Date('2026-10-21T00:00:00.000Z'),
    });
    expect(passing.passed).toBe(true);

    const row = await db.pool.query<{
      provider: string;
      adapter: string;
      passed: boolean;
      run_at: Date;
      scene_count: number;
      reference_sha256: string;
    }>(
      `SELECT provider, adapter, passed, run_at,
              jsonb_array_length(details->'scenes') AS scene_count,
              details->>'reference_sha256' AS reference_sha256
         FROM provider_qualification
        WHERE provider = 'fake' AND adapter = 'FakeImageAdapter'`,
    );

    expect(row.rowCount).toBe(1);
    expect(row.rows[0]!.passed).toBe(true);
    expect(row.rows[0]!.run_at.toISOString()).toBe('2026-10-21T00:00:00.000Z');
    expect(row.rows[0]!.scene_count).toBe(3);
    expect(row.rows[0]!.reference_sha256).toBe(
      referenceSetDigest([IMAGE_QUALIFICATION_FIXTURE.reference]),
    );

    console.log(
      '[provider_qualification row]',
      JSON.stringify({
        provider: row.rows[0]!.provider,
        adapter: row.rows[0]!.adapter,
        passed: row.rows[0]!.passed,
        run_at: row.rows[0]!.run_at.toISOString(),
        scene_count: row.rows[0]!.scene_count,
        reference_sha256: row.rows[0]!.reference_sha256,
      }),
    );

    await expect(
      assertImageQualified(store, { provider: 'fake', adapterName: 'FakeImageAdapter' }),
    ).resolves.toBeUndefined();

    const failing = await runImageQualification({
      adapter: new FakeImageAdapter({ simulateReferenceDrift: true }),
      store,
      now: () => new Date('2026-10-21T01:00:00.000Z'),
    });
    expect(failing.passed).toBe(false);

    const latest = await store.latest('fake', 'FakeImageAdapter');
    expect(latest?.passed).toBe(false);
    await expect(
      assertImageQualified(store, { provider: 'fake', adapterName: 'FakeImageAdapter' }),
    ).rejects.toBeInstanceOf(QualificationGateError);
  }, 180_000);
});
