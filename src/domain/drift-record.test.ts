/**
 * Drift record (PRD 4 D4 / LEAD_PLAN 4 B-10 exit criterion).
 *
 * The count is what the operator records after looking at 17 scenes; these
 * tests pin the arithmetic and the refusals, not the eyeball.
 */
import { describe, expect, it } from 'vitest';

import { DriftRecordError, recordDrift } from './drift-record.js';

const MEASURED_AT = new Date('2026-10-21T12:00:00.000Z');

describe('drift record (17-scene eyeball)', () => {
  it('records the off-model count and the drift rate', () => {
    const record = recordDrift({
      model: 'gemini-nano-banana-2.1',
      sceneCount: 17,
      offModelSceneNos: ['S11', 'S04', 'S17'],
      measuredAt: MEASURED_AT,
      notes: 'S04 face shape, S11 jacket colour, S17 hair',
    });
    expect(record).toEqual({
      model: 'gemini-nano-banana-2.1',
      total_scenes: 17,
      off_model_scene_nos: ['S04', 'S11', 'S17'],
      drift_rate: 0.1765,
      measured_at: '2026-10-21T12:00:00.000Z',
      notes: 'S04 face shape, S11 jacket colour, S17 hair',
    });
  });

  it('records a clean run as zero drift', () => {
    const record = recordDrift({
      model: 'm',
      sceneCount: 17,
      offModelSceneNos: [],
      measuredAt: MEASURED_AT,
    });
    expect(record.drift_rate).toBe(0);
    expect(record.notes).toBeNull();
  });

  it('refuses a record without a model', () => {
    expect(() => recordDrift({ model: '  ', sceneCount: 17, offModelSceneNos: [] })).toThrow(
      DriftRecordError,
    );
  });

  it('refuses a scene id outside the run', () => {
    expect(() => recordDrift({ model: 'm', sceneCount: 17, offModelSceneNos: ['S18'] })).toThrow(
      DriftRecordError,
    );
    expect(() =>
      recordDrift({ model: 'm', sceneCount: 17, offModelSceneNos: ['scene 4'] }),
    ).toThrow(DriftRecordError);
  });

  it('refuses a duplicated scene id (one scene cannot be counted twice)', () => {
    expect(() =>
      recordDrift({ model: 'm', sceneCount: 17, offModelSceneNos: ['S04', 'S04'] }),
    ).toThrow(DriftRecordError);
  });
});
