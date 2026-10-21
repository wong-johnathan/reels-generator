import { describe, expect, it } from 'vitest';

import { STAGE_CODES, type StageCode } from '../shared/index.js';
import { STAGE_CALL_COSTS, computeRetryScope, type RetryStage } from './retry-scope.js';

type Map = Partial<Record<StageCode, RetryStage>>;

const done: RetryStage = { state: 'done', stale: false };
const failed: RetryStage = { state: 'failed', stale: false };
const notRun: RetryStage = { state: 'not_run', stale: false };
const stale: RetryStage = { state: 'stale', stale: true };

const SCENES = 17;

describe('retry scope (§7.3, R-022-2)', () => {
  it('re-runs the failed stage + downstream non-done producing stages (narration failure)', () => {
    const stages: Map = {
      T: done,
      RS: done,
      SC: done,
      SB: done,
      IM: done,
      NA: failed,
      TC: notRun,
      RE: notRun,
      QC: notRun,
      FA: notRun,
      EX: notRun,
    };
    const scope = computeRetryScope({ stage: 'NA', stages, sceneCount: SCENES });

    expect(scope.stage).toBe('NA');
    expect(scope.will_run.map((w) => w.stage)).toEqual(['NA', 'TC', 'RE', 'QC']);
    // Narration re-runs 1 TTS call; render re-runs 1 pass; timing/QC are local.
    const na = scope.will_run.find((w) => w.stage === 'NA');
    const re = scope.will_run.find((w) => w.stage === 'RE');
    expect(na?.calls).toEqual({ image: 0, tts: 1, text: 0, render_passes: 0 });
    expect(re?.calls).toEqual({ image: 0, tts: 0, text: 0, render_passes: 1 });

    // Done (not stale) stages are listed as "will not re-run".
    expect(scope.will_not_run.map((w) => w.stage)).toEqual(['T', 'RS', 'SC', 'SB', 'IM']);
    expect(scope.will_run.map((w) => w.stage)).not.toContain('IM');
    // Gates are operator approvals, never re-run work.
    expect(scope.will_run.map((w) => w.stage)).not.toContain('FA');
    expect(scope.will_run.map((w) => w.stage)).not.toContain('EX');
  });

  it('re-runs image failure across the whole downstream producing tail', () => {
    const stages: Map = {
      T: done,
      RS: done,
      SC: done,
      SB: done,
      IM: failed,
      NA: notRun,
      TC: notRun,
      RE: notRun,
      QC: notRun,
      FA: notRun,
      EX: notRun,
    };
    const scope = computeRetryScope({ stage: 'IM', stages, sceneCount: SCENES });

    expect(scope.will_run.map((w) => w.stage)).toEqual(['IM', 'NA', 'TC', 'RE', 'QC']);
    const im = scope.will_run.find((w) => w.stage === 'IM');
    expect(im?.calls.image).toBe(SCENES); // one image call per scene
    expect(scope.will_not_run.map((w) => w.stage)).toEqual(['T', 'RS', 'SC', 'SB']);
  });

  it('never re-runs a done (not stale) downstream stage', () => {
    // Hypothetical: TC is somehow done even though NA failed — it must not re-run.
    const stages: Map = {
      T: done,
      RS: done,
      SC: done,
      SB: done,
      IM: done,
      NA: failed,
      TC: done,
      RE: notRun,
      QC: notRun,
      FA: notRun,
      EX: notRun,
    };
    const scope = computeRetryScope({ stage: 'NA', stages, sceneCount: SCENES });

    expect(scope.will_run.map((w) => w.stage)).toEqual(['NA', 'RE', 'QC']);
    expect(scope.will_not_run.map((w) => w.stage)).toContain('TC');
  });

  it('re-runs a stale downstream stage (edit already invalidated it)', () => {
    const stages: Map = {
      T: done,
      RS: done,
      SC: failed,
      SB: stale,
      IM: notRun,
      NA: notRun,
      TC: notRun,
      RE: notRun,
      QC: notRun,
      FA: notRun,
      EX: notRun,
    };
    const scope = computeRetryScope({ stage: 'SC', stages, sceneCount: SCENES });

    expect(scope.will_run.map((w) => w.stage)).toEqual(['SC', 'SB', 'IM', 'NA', 'TC', 'RE', 'QC']);
  });

  it('reports unknown_charge and idempotency_protected=false', () => {
    const stages: Map = {
      T: done,
      RS: done,
      SC: done,
      SB: done,
      IM: done,
      NA: failed,
      TC: notRun,
      RE: notRun,
    };
    const scope = computeRetryScope({
      stage: 'NA',
      stages,
      sceneCount: SCENES,
      unknownCharge: true,
    });
    expect(scope.unknown_charge).toBe(true);
    expect(scope.idempotency_protected).toBe(false);
  });

  it('adds a blocker for a non-retryable failure (R-011-2)', () => {
    const stages: Map = {
      T: done,
      RS: done,
      SC: done,
      SB: done,
      IM: done,
      NA: failed,
      TC: notRun,
      RE: notRun,
    };
    const scope = computeRetryScope({
      stage: 'NA',
      stages,
      sceneCount: SCENES,
      errorClass: 'non_retryable',
    });
    expect(scope.blockers.length).toBeGreaterThan(0);
  });

  it('has no blockers for a transient failure', () => {
    const stages: Map = {
      T: done,
      RS: done,
      SC: done,
      SB: done,
      IM: done,
      NA: failed,
      TC: notRun,
      RE: notRun,
    };
    const scope = computeRetryScope({
      stage: 'NA',
      stages,
      sceneCount: SCENES,
      errorClass: 'transient',
    });
    expect(scope.blockers).toEqual([]);
  });

  it('assigns a call cost to every stage code exactly once', () => {
    expect(Object.keys(STAGE_CALL_COSTS).sort()).toEqual([...STAGE_CODES].sort());
  });
});
