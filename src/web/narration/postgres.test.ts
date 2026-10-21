import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NarrationViewSchema } from '../../../contract/api.js';
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
import { NarrationRefusedError } from './gateway.js';
import { createPostgresNarrationGateway } from './postgres.js';

const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[narration gateway tests skipped] ${SKIP_REASON}`);

const DB_TEST_TIMEOUT_MS = 120_000;

describe.skipIf(!hasDatabase)('Postgres NarrationGateway', { timeout: DB_TEST_TIMEOUT_MS }, () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.pool);
  }, DB_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await db?.close();
  });

  it('returns null when no narration audio has been written', async () => {
    const { projectId } = await seedProject(db.pool, { slug: 'narration-empty' });
    const gateway = createPostgresNarrationGateway(db.pool);

    await expect(gateway.get(projectId)).resolves.toBeNull();
  });

  it('maps a narration take to a schema-valid NarrationView', async () => {
    const { projectId, seriesVersionId } = await seedProject(db.pool, {
      slug: 'narration-seeded',
      targetDurationS: 75,
    });
    await setStageState(db.pool, projectId, 'NA', 'done');
    await insertAsset(db.pool, {
      projectId,
      stage: 'NA',
      kind: 'audio',
      contentSha256: sha256For('narration-audio'),
      role: 'narration',
      sizeBytes: 1234,
      seriesVersionId,
      provider: 'elevenlabs',
      model: 'eleven_multilingual_v2',
      providerRequestId: 'req_123',
      promptHash: sha256For('prompt'),
      promptText: 'the narration prompt',
      seed: '42',
      createdAt: new Date('2026-10-20T09:00:00Z'),
    });

    const gateway = createPostgresNarrationGateway(db.pool);
    const view = await gateway.get(projectId);

    expect(view).not.toBeNull();
    expect(NarrationViewSchema.safeParse(view).success).toBe(true);

    expect(view!.status).toBe('done');
    expect(view!.target_duration_s).toBe(75);
    expect(view!.asset).not.toBeNull();
    expect(view!.asset!.provenance.provider).toBe('elevenlabs');
    expect(view!.asset!.provenance.model).toBe('eleven_multilingual_v2');
    expect(view!.alignment).toEqual({
      provider: 'elevenlabs',
      model: 'eleven_multilingual_v2',
      request_id: 'req_123',
    });
    // Alignment internals live in the sidecar blob — reported empty, not guessed.
    expect(view!.duration_s).toBeNull();
    expect(view!.word_count).toBe(0);
    expect(view!.words).toEqual([]);
    expect(view!.accepted_at).toBeNull();
    expect(view!.band.min_s).toBeLessThan(75);
    expect(view!.band.max_s).toBeGreaterThan(75);
    expect(view!.band.within_band).toBe(false);
  });

  it('refuses to rerun when no narration has run', async () => {
    const { projectId } = await seedProject(db.pool, { slug: 'narration-rerun-empty' });
    const gateway = createPostgresNarrationGateway(db.pool);

    await expect(gateway.rerun(projectId, {})).rejects.toBeInstanceOf(NarrationRefusedError);
  });

  it('refuses to rerun a running take, and refuses the unwired queue otherwise', async () => {
    const { projectId } = await seedProject(db.pool, { slug: 'narration-rerun' });
    await insertAsset(db.pool, {
      projectId,
      stage: 'NA',
      kind: 'audio',
      contentSha256: sha256For('narration-rerun-audio'),
      role: 'narration',
    });

    const gateway = createPostgresNarrationGateway(db.pool);

    await setStageState(db.pool, projectId, 'NA', 'running');
    await expect(gateway.rerun(projectId, {})).rejects.toBeInstanceOf(NarrationRefusedError);

    await setStageState(db.pool, projectId, 'NA', 'done');
    await expect(gateway.rerun(projectId, {})).rejects.toBeInstanceOf(NarrationRefusedError);
  });
});
