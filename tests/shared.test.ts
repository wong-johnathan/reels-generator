import { describe, expect, it } from 'vitest';

import {
  ATTENTION_KINDS,
  BATCH_STATES,
  EDIT_KINDS,
  GATE_STAGE_CODES,
  PRODUCING_STAGE_CODES,
  STAGE_CODES,
  STAGE_ORDER,
  STAGE_STATES,
  StageCodeSchema,
  VideoStateSchema,
  VIDEO_STATES,
  isStageCode,
  nextStage,
} from '../src/shared/index.js';

describe('shared vocabulary', () => {
  it('has exactly the 11 canonical stage codes in pipeline order', () => {
    expect(STAGE_CODES).toEqual(['T', 'RS', 'SC', 'SB', 'IM', 'NA', 'TC', 'RE', 'QC', 'FA', 'EX']);
    expect(STAGE_CODES.map((code) => STAGE_ORDER[code])).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it('splits producing stages from the two gates', () => {
    expect(PRODUCING_STAGE_CODES).toHaveLength(9);
    expect(GATE_STAGE_CODES).toEqual(['FA', 'EX']);
    expect([...PRODUCING_STAGE_CODES, ...GATE_STAGE_CODES].sort()).toEqual([...STAGE_CODES].sort());
  });

  it('has the 8 stage states and the 5 video states', () => {
    expect(STAGE_STATES).toHaveLength(8);
    expect(new Set(STAGE_STATES).size).toBe(8);
    expect(VIDEO_STATES).toHaveLength(5);
    expect(BATCH_STATES).toEqual(['ACTIVE', 'COMPLETE', 'CANCELLED']);
  });

  it('has the 8 edit kinds that key the invalidation matrix', () => {
    expect(EDIT_KINDS).toHaveLength(8);
    expect(new Set(EDIT_KINDS).size).toBe(8);
  });

  it('has 6 attention kinds', () => {
    expect(ATTENTION_KINDS).toEqual([
      'none',
      'approval',
      'failed',
      'blocked',
      'waiting',
      'resumed',
    ]);
  });

  it('accepts every stage code and rejects anything else', () => {
    for (const code of STAGE_CODES) {
      expect(StageCodeSchema.parse(code)).toBe(code);
      expect(isStageCode(code)).toBe(true);
    }
    expect(StageCodeSchema.safeParse('XX').success).toBe(false);
    expect(isStageCode('xx')).toBe(false);
  });

  it('accepts every video state and rejects lowercase variants', () => {
    for (const state of VIDEO_STATES) expect(VideoStateSchema.parse(state)).toBe(state);
    expect(VideoStateSchema.safeParse('RUNNING ').success).toBe(false);
    expect(VideoStateSchema.safeParse('running').success).toBe(false);
  });

  it('walks the pipeline and stops after EX', () => {
    expect(nextStage('T')).toBe('RS');
    expect(nextStage('QC')).toBe('FA');
    expect(nextStage('EX')).toBeNull();
  });
});
