/**
 * B-11 timing stage acceptance — US-022 (R-009-3/4), TECH_DESIGN §6.6.
 *
 * Signal (LEAD_PLAN §4 B-11): "timing miss returns to review (R-009-4)".
 * The narration half is driven through the real narration stage and B-07's
 * deterministic fake, so the spans asserted here are derived from the same
 * character alignment the production path receives — never from a fixture that
 * was hand-shaped to match the code.
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
  insertScenes,
  insertStageJob,
  insertVideoStage,
  narrationText,
  readProject,
  readVideoStage,
} from '../../tests/helpers/stage-fixtures.js';
import { FakeTtsAdapter, fakeAlignmentFor } from '../adapters/tts.js';
import { runMigrations } from '../db/runner.js';
import { deriveWordTimings, type CharacterAlignment } from '../domain/word-timing.js';
import { InMemoryBlobStore } from './asset-store.js';
import { runNarrationStage, type StoredNarration } from './narration-stage.js';
import {
  runTimingStage,
  sceneSpansFromWords,
  timingBand,
  type TimingSceneInput,
  type TimingStageInput,
} from './timing-stage.js';

// Per-test and per-hook budgets: seedProject + M-001..M-005 take seconds on
// the vendor-embedded Postgres, and the full suite runs suites in parallel.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });
const hasDatabase = testDatabaseUrl() !== null;
if (!hasDatabase) console.warn(`[B-11 timing stage tests skipped] ${SKIP_REASON}`);

const VOICE = {
  voice_id: 'fake-voice',
  model_id: 'fake-tts-model',
  licence_kind: 'fake-commercial',
} as const;

const THREE_SCENES: readonly TimingSceneInput[] = [
  { scene_no: 'S01', position: 1, start_word: 0, end_word: 76 },
  { scene_no: 'S02', position: 2, start_word: 76, end_word: 152 },
  { scene_no: 'S03', position: 3, start_word: 152, end_word: 228 },
];

describe('R-009-3 duration band', () => {
  it('is ±5 % of the target', () => {
    expect(timingBand(75)).toEqual({
      target_s: 75,
      tolerance_s: 3.75,
      min_s: 71.25,
      max_s: 78.75,
    });
    expect(timingBand(40)).toMatchObject({ tolerance_s: 2, min_s: 38, max_s: 42 });
  });

  it('clamps to a ±1 s floor for short targets', () => {
    expect(timingBand(10)).toEqual({ target_s: 10, tolerance_s: 1, min_s: 9, max_s: 11 });
    expect(timingBand(20)).toMatchObject({ tolerance_s: 1, min_s: 19, max_s: 21 });
  });

  it('clamps to a ±5 s ceiling for long targets (R-009-1 180 s cap)', () => {
    expect(timingBand(180)).toEqual({ target_s: 180, tolerance_s: 5, min_s: 175, max_s: 185 });
    expect(timingBand(120)).toMatchObject({ tolerance_s: 5, min_s: 115, max_s: 125 });
  });
});

describe('sceneSpansFromWords (R-009-3)', () => {
  const words = [
    { word: 'a', start_ms: 0, end_ms: 300 },
    { word: 'b', start_ms: 300, end_ms: 700 },
    { word: 'c', start_ms: 700, end_ms: 1100 },
    { word: 'd', start_ms: 1100, end_ms: 1600 },
  ];

  it('maps each word range to a span from its first word start to its last word end', () => {
    const spans = sceneSpansFromWords(words, [
      { scene_no: 'S01', position: 1, start_word: 0, end_word: 2 },
      { scene_no: 'S02', position: 2, start_word: 2, end_word: 4 },
    ]);
    expect(spans).toEqual([
      { scene_no: 'S01', position: 1, start_ms: 0, end_ms: 700, duration_s: 0.7 },
      { scene_no: 'S02', position: 2, start_ms: 700, end_ms: 1600, duration_s: 0.9 },
    ]);
  });

  it('rejects a plan that does not partition the narration', () => {
    expect(() =>
      sceneSpansFromWords(words, [{ scene_no: 'S01', position: 1, start_word: 0, end_word: 3 }]),
    ).toThrow(/scene plan/);
    expect(() =>
      sceneSpansFromWords(words, [
        { scene_no: 'S01', position: 1, start_word: 0, end_word: 2 },
        { scene_no: 'S02', position: 2, start_word: 3, end_word: 4 },
      ]),
    ).toThrow(/scene plan/);
  });
});

describe.skipIf(!hasDatabase)('timing stage (US-022)', () => {
  let db: TestDatabase;
  let seeded: SeededProject;
  let blobs: InMemoryBlobStore;
  let narrationJobId: string;
  let timingJobId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.pool);
  }, 240_000);

  beforeEach(async () => {
    seeded = await seedProject(db.pool);
    blobs = new InMemoryBlobStore();
    await insertVideoStage(db.pool, seeded.projectId, 'NA');
    await insertVideoStage(db.pool, seeded.projectId, 'TC');
    narrationJobId = await insertStageJob(db.pool, seeded.projectId, 'NA');
    timingJobId = await insertStageJob(db.pool, seeded.projectId, 'TC');
    await insertScenes(db.pool, seeded.projectId, ['S01', 'S02', 'S03']);
  });

  afterAll(async () => {
    await db?.close();
  });

  async function narrate(
    wordCount: number,
    adapter: FakeTtsAdapter = new FakeTtsAdapter({ rateLimitPerMinute: 600 }),
  ): Promise<StoredNarration> {
    const result = await runNarrationStage(
      { pool: db.pool, tts: adapter, blobs },
      {
        jobId: narrationJobId,
        attemptNo: 1,
        projectId: seeded.projectId,
        narration: narrationText(wordCount),
        voice: VOICE,
        seriesVersionId: seeded.seriesVersionId,
      },
    );
    if (result.status !== 'stored') {
      // Name the stage's own reason: a bare 'did not store the take' hid a
      // duplicate-key failure behind a generic message.
      throw new Error(`narration stage did not store the take: ${result.message}`);
    }
    return result.narration;
  }

  function timingInput(
    narration: StoredNarration,
    overrides: Partial<TimingStageInput> = {},
  ): TimingStageInput {
    return {
      jobId: timingJobId,
      projectId: seeded.projectId,
      narrationAssetId: narration.audio_asset_id,
      alignmentAssetId: narration.alignment_asset_id,
      targetDurationS: 75,
      scenes: THREE_SCENES,
      ...overrides,
    };
  }

  async function storedAlignment(narration: StoredNarration): Promise<CharacterAlignment> {
    const row = await db.pool.query('SELECT object_key FROM asset WHERE id = $1', [
      narration.alignment_asset_id,
    ]);
    const doc = JSON.parse(new TextDecoder().decode(await blobs.get(row.rows[0]!.object_key))) as {
      alignment: CharacterAlignment;
    };
    return doc.alignment;
  }

  it('recalculates scene durations from the actual narration (R-009-3)', async () => {
    const narration = await narrate(228);
    const words = deriveWordTimings(await storedAlignment(narration), {
      script: narrationText(228),
    }).words;

    const result = await runTimingStage({ pool: db.pool, blobs }, timingInput(narration));
    expect(result.status).toBe('timed');
    if (result.status !== 'timed') return;

    const expected = [
      { scene_no: 'S01', start: words[0]!.start_ms, end: words[75]!.end_ms },
      { scene_no: 'S02', start: words[76]!.start_ms, end: words[151]!.end_ms },
      { scene_no: 'S03', start: words[152]!.start_ms, end: words[227]!.end_ms },
    ];
    const scenes = await db.pool.query(
      `SELECT scene_no, narration_start_ms, narration_end_ms FROM scene
        WHERE project_id = $1 ORDER BY position`,
      [seeded.projectId],
    );
    expect(scenes.rows).toEqual(
      expected.map((span) => ({
        scene_no: span.scene_no,
        narration_start_ms: span.start,
        narration_end_ms: span.end,
      })),
    );

    // Spans are contiguous: no speech is claimed twice and none is dropped.
    for (let index = 1; index < expected.length; index += 1) {
      expect(expected[index]!.start).toBeGreaterThanOrEqual(expected[index - 1]!.end);
    }
    expect(expected[0]!.start).toBe(0);
    expect(result.plan.scenes.map((scene) => scene.duration_s)).toEqual(
      expected.map((span) => Number(((span.end - span.start) / 1000).toFixed(3))),
    );
    expect(result.plan.scenes.reduce((sum, scene) => sum + scene.end_ms - scene.start_ms, 0)).toBe(
      expected[2]!.end - expected[0]!.start,
    );

    const band = timingBand(75);
    expect(result.plan.final_audio_duration_s).toBeCloseTo(narration.duration_s + 1, 5);
    expect(result.plan.final_audio_duration_s).toBeGreaterThanOrEqual(band.min_s);
    expect(result.plan.final_audio_duration_s).toBeLessThanOrEqual(band.max_s);
    expect(result.plan.narration_duration_s).toBeCloseTo(narration.duration_s, 5);
    expect(result.plan.band.within_band).toBe(true);
    expect(result.plan.word_count).toBe(228);

    const timingAsset = await db.pool.query('SELECT * FROM asset WHERE id = $1', [
      result.timing_asset_id,
    ]);
    // `asset.stage` has no 'TC' value (M-004 CHECK), so the derived document is
    // stored as an NA sidecar that names the producing stage in its metadata.
    expect(timingAsset.rows[0]).toMatchObject({
      project_id: seeded.projectId,
      stage: 'NA',
      kind: 'sidecar',
      mime_type: 'application/json',
      rights_metadata: { stage: 'TC', derived_from_asset_id: narration.audio_asset_id },
    });
    const timingDoc = JSON.parse(
      new TextDecoder().decode(await blobs.get(timingAsset.rows[0]!.object_key)),
    ) as { schema_version: string; scenes: unknown[]; band: { within_band: boolean } };
    expect(timingDoc.schema_version).toBe('timing.v1');
    expect(timingDoc.scenes).toHaveLength(3);
    expect(timingDoc.band.within_band).toBe(true);

    expect((await readVideoStage(db.pool, seeded.projectId, 'TC'))?.state).toBe('done');
    expect((await readProject(db.pool, seeded.projectId))?.current_stage).toBe('RE');
    const job = await db.pool.query('SELECT status FROM job WHERE id = $1', [timingJobId]);
    expect(job.rows[0]).toEqual({ status: 'succeeded' });
    // TC is a local transform: no provider call, no generation_run (X-7, §4.7).
    const runs = await db.pool.query(
      `SELECT count(*)::int AS n FROM generation_run WHERE stage = 'TC'`,
    );
    expect(runs.rows[0]).toEqual({ n: 0 });
  });

  it('a duration miss returns the video to script/voice review and never time-stretches (R-009-4)', async () => {
    const narration = await narrate(273);
    const before = await storedAlignment(narration);
    const audioBefore = await db.pool.query(
      `SELECT content_sha256, object_size_bytes FROM asset WHERE id = $1`,
      [narration.audio_asset_id],
    );

    const result = await runTimingStage({ pool: db.pool, blobs }, timingInput(narration));
    expect(result.status).toBe('review_required');
    if (result.status !== 'review_required') return;

    const band = timingBand(75);
    expect(result.review.reason).toBe('duration_out_of_band');
    expect(result.review.review_targets).toEqual(['SC', 'NA']);
    expect(result.review.time_stretched).toBe(false);
    expect(result.review.measured_duration_s).toBeCloseTo(narration.duration_s + 1, 5);
    expect(result.review.measured_duration_s).toBeGreaterThan(band.max_s);
    expect(result.review.failures.join(' ')).toMatch(/outside 71\.25–78\.75 s/);

    // Nothing was committed for render: no spans, no TC asset, TC failed.
    const scenes = await db.pool.query(
      `SELECT narration_start_ms, narration_end_ms FROM scene WHERE project_id = $1`,
      [seeded.projectId],
    );
    expect(scenes.rows.every((row) => row.narration_start_ms === null)).toBe(true);
    const tcAssets = await db.pool.query(
      `SELECT count(*)::int AS n FROM asset
        WHERE project_id = $1 AND rights_metadata->>'stage' = 'TC'`,
      [seeded.projectId],
    );
    expect(tcAssets.rows[0]).toEqual({ n: 0 });
    expect((await readVideoStage(db.pool, seeded.projectId, 'TC'))?.state).toBe('failed');
    expect((await readProject(db.pool, seeded.projectId))?.status).toBe('NEEDS_ATTENTION');
    const job = await db.pool.query('SELECT status FROM job WHERE id = $1', [timingJobId]);
    expect(job.rows[0]).toEqual({ status: 'failed' });

    // The speech itself is untouched: same bytes, same alignment duration
    // (time-stretching would have changed both).
    const audioAfter = await db.pool.query(
      `SELECT content_sha256, object_size_bytes FROM asset WHERE id = $1`,
      [narration.audio_asset_id],
    );
    expect(audioAfter.rows[0]).toEqual(audioBefore.rows[0]);
    expect(await storedAlignment(narration)).toEqual(before);
  });

  it('a short take is a miss in the other direction (never stretched up)', async () => {
    const narration = await narrate(200);
    const result = await runTimingStage({ pool: db.pool, blobs }, timingInput(narration));
    expect(result.status).toBe('review_required');
    if (result.status !== 'review_required') return;
    expect(result.review.reason).toBe('duration_out_of_band');
    expect(result.review.measured_duration_s).toBeLessThan(timingBand(75).min_s);
  });

  it('word-timing coverage below 99 % returns to review instead of inventing spans (R-008-3)', async () => {
    const text = narrationText(228);
    const alignment = fakeAlignmentFor(text);
    const broken = untimeWords(alignment, 50, 3);
    const narration = await narrate(
      228,
      new FakeTtsAdapter({ rateLimitPerMinute: 600, alignment: broken }),
    );

    const result = await runTimingStage({ pool: db.pool, blobs }, timingInput(narration));
    expect(result.status).toBe('review_required');
    if (result.status !== 'review_required') return;
    expect(result.review.reason).toBe('word_timings_invalid');
    expect(result.review.review_targets).toEqual(['SC', 'NA']);
    expect(result.review.failures.join(' ')).toMatch(/word_coverage/);

    const scenes = await db.pool.query(
      `SELECT narration_start_ms FROM scene WHERE project_id = $1`,
      [seeded.projectId],
    );
    expect(scenes.rows.every((row) => row.narration_start_ms === null)).toBe(true);
    expect((await readVideoStage(db.pool, seeded.projectId, 'TC'))?.state).toBe('failed');
  });

  it('a scene plan that does not partition the narration returns to review', async () => {
    const narration = await narrate(228);
    const result = await runTimingStage(
      { pool: db.pool, blobs },
      timingInput(narration, {
        scenes: [
          { scene_no: 'S01', position: 1, start_word: 0, end_word: 76 },
          { scene_no: 'S02', position: 2, start_word: 77, end_word: 152 },
          { scene_no: 'S03', position: 3, start_word: 152, end_word: 228 },
        ],
      }),
    );
    expect(result.status).toBe('review_required');
    if (result.status !== 'review_required') return;
    expect(result.review.reason).toBe('scene_plan_invalid');
    expect(result.review.review_targets).toEqual(['SC']);
  });
});

/** Blank the timings of `count` words starting at `firstWord`, keeping the text. */
function untimeWords(
  alignment: CharacterAlignment,
  firstWord: number,
  count: number,
): CharacterAlignment {
  const starts = [...alignment.character_start_times_seconds];
  const ends = [...alignment.character_end_times_seconds];
  let wordIndex = 0;
  let inWord = false;
  alignment.characters.forEach((character, index) => {
    if (/^\s+$/.test(character)) {
      inWord = false;
      return;
    }
    if (!inWord) {
      wordIndex += 1;
      inWord = true;
    }
    if (wordIndex > firstWord && wordIndex <= firstWord + count) {
      starts[index] = Number.NaN;
      ends[index] = Number.NaN;
    }
  });
  return {
    characters: alignment.characters,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  };
}
