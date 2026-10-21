import { describe, expect, it } from 'vitest';

import {
  EDIT_KINDS,
  STAGE_CODES,
  type EditKind,
  type StageCode,
  type StageState,
} from '../shared/index.js';
import {
  INVALIDATION_RULE_SEED,
  computeInvalidation,
  propagateStale,
  ruleFor,
  type StageSnapshot,
} from './invalidation.js';

const SCENES = 17;

/** An all-11-stages `done` fixture (factual mode: research ran). */
function allDoneStages(): Record<StageCode, StageSnapshot> {
  return Object.fromEntries(STAGE_CODES.map((c) => [c, { state: 'done' as StageState }])) as Record<
    StageCode,
    StageSnapshot
  >;
}

/**
 * The exact invalidation matrix — TECH_DESIGN §4.3 + R-006-2/3, keyed by
 * edit_kind. `calls` is [image, tts, text, render_passes]. `invalidated` is the
 * canonical stale set produced when every stage is `done` (factual mode).
 */
const MATRIX: Readonly<
  Record<
    EditKind,
    {
      readonly invalidated: readonly StageCode[];
      readonly calls: readonly [number, number, number, number];
      readonly reframe_invalidated?: readonly StageCode[];
      readonly reframe_calls?: readonly [number, number, number, number];
    }
  >
> = {
  script_wording: { invalidated: ['SB', 'NA', 'TC', 'RE'], calls: [0, 1, 1, 1] },
  duration: { invalidated: ['SC', 'SB', 'NA', 'TC', 'RE'], calls: [0, 1, 2, 1] },
  aspect_ratio: {
    invalidated: ['RE'],
    calls: [0, 0, 0, 1],
    reframe_invalidated: ['IM', 'RE'],
    reframe_calls: [SCENES, 0, 0, 1],
  },
  image_replace: { invalidated: ['IM', 'RE'], calls: [1, 0, 0, 1] },
  captions_music: { invalidated: ['RE'], calls: [0, 0, 0, 1] },
  voice_speed: { invalidated: ['NA', 'TC', 'RE'], calls: [0, 1, 0, 1] },
  topic_after_research: {
    invalidated: ['RS', 'SC', 'SB', 'IM', 'NA', 'TC', 'RE'],
    calls: [0, 1, 2, 1],
  },
  reorder: { invalidated: ['TC', 'RE'], calls: [0, 0, 0, 1] },
};

describe('invalidation_rule seed (§4.3)', () => {
  it('has exactly one rule per edit_kind, keyed in canonical order', () => {
    expect(INVALIDATION_RULE_SEED).toHaveLength(EDIT_KINDS.length);
    expect(INVALIDATION_RULE_SEED.map((r) => r.edit_kind)).toEqual([...EDIT_KINDS]);
  });

  it('resolves every rule by edit_kind', () => {
    for (const kind of EDIT_KINDS) {
      expect(ruleFor(kind).edit_kind).toBe(kind);
    }
  });

  it('stores call counts as non-negative integers and render_passes of 0 or 1', () => {
    for (const rule of INVALIDATION_RULE_SEED) {
      expect(Number.isInteger(rule.image_calls)).toBe(true);
      expect(Number.isInteger(rule.tts_calls)).toBe(true);
      expect(Number.isInteger(rule.render_passes)).toBe(true);
      expect(rule.image_calls).toBeGreaterThanOrEqual(0);
      expect(rule.tts_calls).toBeGreaterThanOrEqual(0);
      expect([0, 1]).toContain(rule.render_passes);
    }
  });

  it('is the only module to carry `reframe` as a conditional check', () => {
    const conditional = INVALIDATION_RULE_SEED.filter((r) => r.conditional_check !== null);
    expect(conditional.map((r) => r.edit_kind)).toEqual(['aspect_ratio']);
    expect(conditional[0]?.conditional_check).toBe('reframe');
  });
});

describe('computeInvalidation — exact stale set + call counts (§4.3/R-006-2/3)', () => {
  it.each([...EDIT_KINDS])('produces the exact stale set + calls for %s', (kind) => {
    const expected = MATRIX[kind];
    const result = computeInvalidation(ruleFor(kind), { sceneCount: SCENES });

    expect(result.invalidated).toEqual([...expected.invalidated]);
    expect([
      result.calls.image,
      result.calls.tts,
      result.calls.text,
      result.calls.render_passes,
    ]).toEqual([...expected.calls]);

    // Surviving stages are exactly the non-invalidated producing stages.
    for (const survivor of result.survives) {
      expect(expected.invalidated).not.toContain(survivor);
    }
  });

  it('resolves the aspect-ratio reframe conditional — reframable outcome', () => {
    const result = computeInvalidation(ruleFor('aspect_ratio'), {
      sceneCount: SCENES,
      reframeOutcome: 'reframable',
    });
    expect(result.invalidated).toEqual(['RE']);
    expect(result.calls.image).toBe(0);
    expect(result.conditional).toEqual({
      check: 'reframe',
      status: 'reframable',
      image_calls_if_not_reframable: SCENES,
    });
  });

  it('resolves the aspect-ratio reframe conditional — not_reframable outcome', () => {
    const result = computeInvalidation(ruleFor('aspect_ratio'), {
      sceneCount: SCENES,
      reframeOutcome: 'not_reframable',
    });
    expect(result.invalidated).toEqual(['IM', 'RE']);
    expect(result.calls.image).toBe(SCENES);
    expect(result.survives).toEqual([]);
    expect(result.conditional).toEqual({
      check: 'reframe',
      status: 'not_reframable',
      image_calls_if_not_reframable: SCENES,
    });
  });

  it('leaves the reframe conditional pending until the local check resolves', () => {
    const result = computeInvalidation(ruleFor('aspect_ratio'), { sceneCount: SCENES });
    expect(result.conditional?.status).toBe('pending');
    expect(result.invalidated).toEqual(['RE']);
    expect(result.calls.image).toBe(0);
  });

  it('counts text calls as the number of re-derived script/storyboard stages', () => {
    // script_wording re-derives only SB (1); duration re-derives SC + SB (2).
    expect(computeInvalidation(ruleFor('script_wording'), { sceneCount: SCENES }).calls.text).toBe(
      1,
    );
    expect(computeInvalidation(ruleFor('duration'), { sceneCount: SCENES }).calls.text).toBe(2);
    expect(computeInvalidation(ruleFor('voice_speed'), { sceneCount: SCENES }).calls.text).toBe(0);
  });
});

describe('propagateStale — done/awaiting_approval → stale, survivors untouched (§4.4)', () => {
  it('marks every done stage in the invalidated set stale and leaves survivors done', () => {
    const stages = allDoneStages();
    const invalidated: readonly StageCode[] = ['SB', 'NA', 'TC', 'RE'];
    const app = propagateStale(stages, invalidated, 'script_wording: doc rev 4');

    expect(app.marked_stale).toEqual(['SB', 'NA', 'TC', 'RE']);
    expect(app.stages.SB?.state).toBe('stale');
    expect(app.stages.NA?.state).toBe('stale');
    expect(app.stages.TC?.state).toBe('stale');
    expect(app.stages.RE?.state).toBe('stale');
    // Surviving done stages stay done.
    expect(app.stages.IM?.state).toBe('done');
    expect(app.stages.SC?.state).toBe('done');
    expect(app.stages.SB?.stale_cause).toBe('script_wording: doc rev 4');
  });

  it('transitions awaiting_approval → stale via the state machine', () => {
    const stages = allDoneStages();
    stages.SC = { state: 'awaiting_approval' };
    const app = propagateStale(stages, ['SC'], 'duration: doc rev 2');
    expect(app.stages.SC?.state).toBe('stale');
    expect(app.marked_stale).toEqual(['SC']);
  });

  it('never marks a not_run stage stale (creative-mode research survives a topic edit)', () => {
    const stages = allDoneStages();
    stages.RS = { state: 'not_run' };
    const app = propagateStale(
      stages,
      ['RS', 'SC', 'SB', 'IM', 'NA', 'TC', 'RE'],
      'topic_after_research: doc rev 3',
    );
    // RS was never run in creative mode → left not_run, not marked stale.
    expect(app.stages.RS?.state).toBe('not_run');
    expect(app.marked_stale).toEqual(['SC', 'SB', 'IM', 'NA', 'TC', 'RE']);
  });

  it('does not auto-clear an existing stale flag (IP-01/UC-05)', () => {
    const stages = allDoneStages();
    stages.NA = { state: 'stale', stale_cause: 'voice_speed: doc rev 1' };
    const app = propagateStale(stages, ['NA'], 'voice_speed: doc rev 2');
    expect(app.stages.NA?.state).toBe('stale');
    expect(app.marked_stale).toEqual([]);
  });

  it('leaves failed/running/blocked stages untouched (no such transition)', () => {
    const stages = allDoneStages();
    stages.RE = { state: 'failed' };
    stages.TC = { state: 'running' };
    stages.IM = { state: 'blocked' };
    const app = propagateStale(stages, ['IM', 'TC', 'RE'], 'reorder: doc rev 5');
    expect(app.stages.RE?.state).toBe('failed');
    expect(app.stages.TC?.state).toBe('running');
    expect(app.stages.IM?.state).toBe('blocked');
    expect(app.marked_stale).toEqual([]);
  });
});
