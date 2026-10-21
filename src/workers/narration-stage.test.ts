/**
 * B-11 narration stage acceptance — US-021 (R-013-1/2, R-008-1), §4.8 NA gate.
 *
 * Signal (LEAD_PLAN §4 B-11): "narration stored with voice config + request id".
 * These tests assert it against real PostgreSQL and B-07's deterministic
 * `FakeTtsAdapter`: no network, no paid call, no clock dependence.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseUrl,
  type TestDatabase,
} from '../../tests/helpers/pg.js';
import { seedProject, type SeededProject } from '../../tests/helpers/fixtures.js';
import {
  insertStageJob,
  insertVideoStage,
  narrationText,
  readProject,
  readVideoStage,
} from '../../tests/helpers/stage-fixtures.js';
import { FakeTtsAdapter, ttsPromptHash } from '../adapters/tts.js';
import { runMigrations } from '../db/runner.js';
import { InMemoryBlobStore } from './asset-store.js';
import { runNarrationStage, type NarrationStageInput } from './narration-stage.js';

// Per-test and per-hook budgets: seedProject + M-001..M-005 take seconds on
// the vendor-embedded Postgres, and the full suite runs suites in parallel.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });
const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[B-11 narration stage tests skipped] ${SKIP_REASON}`);

const VOICE = {
  voice_id: 'fake-voice',
  model_id: 'fake-tts-model',
  licence_kind: 'fake-commercial',
  licence_note: 'synthetic voice, test licence only',
} as const;

describe.skipIf(!hasDatabase)('narration stage (US-021)', () => {
  let db: TestDatabase;
  let seeded: SeededProject;
  let blobs: InMemoryBlobStore;
  let jobId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.pool);
  }, 240_000);

  beforeEach(async () => {
    seeded = await seedProject(db.pool);
    blobs = new InMemoryBlobStore();
    await insertVideoStage(db.pool, seeded.projectId, 'NA');
    jobId = await insertStageJob(db.pool, seeded.projectId, 'NA');
  });

  afterAll(async () => {
    await db?.close();
  });

  function input(overrides: Partial<NarrationStageInput> = {}): NarrationStageInput {
    return {
      jobId,
      attemptNo: 1,
      projectId: seeded.projectId,
      narration: narrationText(228),
      voice: VOICE,
      seriesVersionId: seeded.seriesVersionId,
      ...overrides,
    };
  }

  it('stores narration with voice config, request id and full provenance (R-013-1/2)', async () => {
    const adapter = new FakeTtsAdapter({ rateLimitPerMinute: 600 });
    const result = await runNarrationStage({ pool: db.pool, tts: adapter, blobs }, input());

    expect(result.status).toBe('stored');
    if (result.status !== 'stored') return;
    const stored = result.narration;

    const audio = await db.pool.query('SELECT * FROM asset WHERE id = $1', [stored.audio_asset_id]);
    const audioRow = audio.rows[0]!;
    expect(audioRow).toMatchObject({
      project_id: seeded.projectId,
      stage: 'NA',
      kind: 'audio',
      mime_type: 'audio/wav',
      provider: 'fake',
      model: 'fake-tts-model',
      prompt_text: narrationText(228),
      series_version_id: seeded.seriesVersionId,
      generation_run_id: stored.generation_run_id,
    });
    expect(audioRow.provider_request_id).toMatch(/^fake-tts-[0-9a-f]{16}$/);
    expect(audioRow.prompt_hash).toBe(
      ttsPromptHash({
        text: narrationText(228),
        voice_id: VOICE.voice_id,
        model_id: VOICE.model_id,
      }),
    );
    // The key is a readable path now (D-F): <slug>/batch-0001/narration.mp3.
    expect(audioRow.object_key).toMatch(/^[a-z0-9-]+\/batch-\d{4}\/narration\.mp3$/);
    expect(Number(audioRow.object_size_bytes)).toBeGreaterThan(44);
    expect((audioRow.rights_metadata as { voice: Record<string, unknown> }).voice).toMatchObject({
      voice_id: VOICE.voice_id,
      model_id: VOICE.model_id,
      licence_kind: VOICE.licence_kind,
      licence_note: VOICE.licence_note,
    });
    expect(await blobs.has(audioRow.object_key)).toBe(true);

    const alignmentAsset = await db.pool.query('SELECT * FROM asset WHERE id = $1', [
      stored.alignment_asset_id,
    ]);
    const alignmentRow = alignmentAsset.rows[0]!;
    expect(alignmentRow).toMatchObject({
      project_id: seeded.projectId,
      stage: 'NA',
      kind: 'sidecar',
      mime_type: 'application/json',
      provider: 'fake',
      provider_request_id: audioRow.provider_request_id,
      generation_run_id: stored.generation_run_id,
    });
    const alignmentDoc = JSON.parse(
      new TextDecoder().decode(await blobs.get(alignmentRow.object_key)),
    ) as {
      schema_version: string;
      text: string;
      word_count: number;
      coverage: { word_coverage: number };
      alignment: { characters: string[] };
    };
    expect(alignmentDoc.schema_version).toBe('narration-alignment.v1');
    expect(alignmentDoc.text).toBe(narrationText(228));
    expect(alignmentDoc.word_count).toBe(228);
    expect(alignmentDoc.coverage.word_coverage).toBe(1);
    expect(alignmentDoc.alignment.characters.length).toBeGreaterThan(228);

    const run = await db.pool.query('SELECT * FROM generation_run WHERE id = $1', [
      stored.generation_run_id,
    ]);
    expect(run.rows[0]).toMatchObject({
      project_id: seeded.projectId,
      stage: 'NA',
      provider: 'fake',
      status: 'succeeded',
      charge_status: 'billed',
      provider_request_id: audioRow.provider_request_id,
      idempotency_protected: false,
    });
    expect(adapter.callCount).toBe(1);

    const stage = await readVideoStage(db.pool, seeded.projectId, 'NA');
    expect(stage?.state).toBe('done');
    // R-002-2: the stage pins the series version in effect when it started.
    expect(stage?.series_version_id).toBe(seeded.seriesVersionId);
    expect((await readProject(db.pool, seeded.projectId))?.current_stage).toBe('TC');
  });

  it('gives each project its own narration object, because keys are paths (D-F)', async () => {
    const first = await runNarrationStage(
      { pool: db.pool, tts: new FakeTtsAdapter({ rateLimitPerMinute: 600 }), blobs },
      input(),
    );

    // A second project reading the same script at the same voice produces the
    // same bytes. Under R-026 that deduped to one asset row shared through
    // asset_ref; with readable paths the object lives inside each project's own
    // batch folder, so identical bytes are stored twice — the cost recorded in
    // DEVIATIONS D-F, paid for a bucket a human can read.
    const other = await seedProject(db.pool);
    await insertVideoStage(db.pool, other.projectId, 'NA');
    const otherJob = await insertStageJob(db.pool, other.projectId, 'NA');
    const second = await runNarrationStage(
      { pool: db.pool, tts: new FakeTtsAdapter({ rateLimitPerMinute: 600 }), blobs },
      input({
        jobId: otherJob,
        projectId: other.projectId,
        seriesVersionId: other.seriesVersionId,
      }),
    );

    expect(first.status).toBe('stored');
    expect(second.status).toBe('stored');
    if (first.status !== 'stored' || second.status !== 'stored') return;

    expect(second.narration.content_sha256).toBe(first.narration.content_sha256);
    expect(second.narration.audio_asset_id).not.toBe(first.narration.audio_asset_id);

    const rows = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM asset WHERE kind = 'audio' AND content_sha256 = $1`,
      [first.narration.content_sha256],
    );
    expect(rows.rows[0]).toEqual({ n: 2 });

    // Each project's audio sits in its own batch folder, so the two keys differ.
    const keys = await db.pool.query<{ object_key: string }>(
      `SELECT object_key FROM asset WHERE kind = 'audio' AND content_sha256 = $1
        ORDER BY object_key`,
      [first.narration.content_sha256],
    );
    expect(new Set(keys.rows.map((row) => row.object_key)).size).toBe(2);
    expect(keys.rows.every((row) => row.object_key.endsWith('/narration.mp3'))).toBe(true);

    expect(blobs.size).toBe(4); // two takes + two alignment documents
  });

  it('a non-retryable provider failure stores nothing and fails the stage', async () => {
    const adapter = new FakeTtsAdapter({ rateLimitPerMinute: 600, failures: [401] });
    const result = await runNarrationStage({ pool: db.pool, tts: adapter, blobs }, input());

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error_class).toBe('non_retryable');
    expect(result.retried).toBe(false);

    const assets = await db.pool.query(
      'SELECT count(*)::int AS n FROM asset WHERE project_id = $1',
      [seeded.projectId],
    );
    expect(assets.rows[0]).toEqual({ n: 0 });
    expect((await readVideoStage(db.pool, seeded.projectId, 'NA'))?.state).toBe('failed');

    const run = await db.pool.query(
      `SELECT status, charge_status, error_class, http_status FROM generation_run
        WHERE project_id = $1`,
      [seeded.projectId],
    );
    expect(run.rows[0]).toMatchObject({
      status: 'failed',
      charge_status: 'unbilled',
      error_class: 'non_retryable',
      http_status: 401,
    });
  });

  it('stores the take before the cost row closes billed (TECH_DESIGN §2 step c)', async () => {
    // A store outage after the provider call must not produce a `billed` run with
    // no asset: the throw happens inside the onResult seam, so the run closes with
    // an unknown charge and nothing downstream can mistake the take for stored.
    const failing = {
      put: async (): Promise<void> => {
        throw new Error('object store is unreachable');
      },
      get: async (): Promise<Uint8Array> => {
        throw new Error('object store is unreachable');
      },
      has: async (): Promise<boolean> => false,
    };
    const adapter = new FakeTtsAdapter({ rateLimitPerMinute: 600 });
    const result = await runNarrationStage(
      { pool: db.pool, tts: adapter, blobs: failing },
      input(),
    );

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(adapter.callCount).toBe(1);
    const assets = await db.pool.query(
      'SELECT count(*)::int AS n FROM asset WHERE project_id = $1',
      [seeded.projectId],
    );
    expect(assets.rows[0]).toEqual({ n: 0 });
    const run = await db.pool.query(
      `SELECT status, charge_status FROM generation_run WHERE project_id = $1`,
      [seeded.projectId],
    );
    expect(run.rows[0]).toEqual({ status: 'failed', charge_status: 'unknown' });
    // The retry budget is B-08's: a doubtful charge with attempts left keeps the
    // stage running rather than reporting a terminal failure.
    expect((await readVideoStage(db.pool, seeded.projectId, 'NA'))?.state).toBe('running');
  });

  it('a transient failure keeps the stage running while retries remain (R-011-2)', async () => {
    const adapter = new FakeTtsAdapter({ rateLimitPerMinute: 600, failures: [503] });
    const result = await runNarrationStage({ pool: db.pool, tts: adapter, blobs }, input());

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error_class).toBe('transient');
    expect(result.retried).toBe(true);
    expect((await readVideoStage(db.pool, seeded.projectId, 'NA'))?.state).toBe('running');

    // A call that may have billed is never recorded as unbilled (R-012-4).
    const run = await db.pool.query(
      'SELECT charge_status FROM generation_run WHERE project_id = $1',
      [seeded.projectId],
    );
    expect(run.rows[0]).toEqual({ charge_status: 'unknown' });
  });

  it('refuses to call the provider when the stage is already done (no second bill)', async () => {
    await db.pool.query(
      `UPDATE video_stage SET state = 'done' WHERE project_id = $1 AND stage = 'NA'`,
      [seeded.projectId],
    );
    const adapter = new FakeTtsAdapter({ rateLimitPerMinute: 600 });

    await expect(
      runNarrationStage({ pool: db.pool, tts: adapter, blobs }, input()),
    ).rejects.toThrow(/illegal stage transition/);
    expect(adapter.callCount).toBe(0);
    const run = await db.pool.query(
      'SELECT count(*)::int AS n FROM generation_run WHERE project_id = $1',
      [seeded.projectId],
    );
    expect(run.rows[0]).toEqual({ n: 0 });
  });
});
