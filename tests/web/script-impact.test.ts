import { describe, expect, it } from 'vitest';

import { InvalidationPreviewSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import {
  C07_FAILED,
  NO_ASSETS,
  NO_CHANGES,
  computingImpact,
  failedImpact,
  idleImpact,
  readyImpact,
} from '../../src/web/script/impact.js';

/**
 * UC-06 change-impact panel (IP-01, R-006-1/2, C-01…C-07, AX-04).
 *
 * Every number here comes from the *server's* `InvalidationPreview`; the
 * formatting layer never derives an invalidation or a call count of its own.
 */

const preview = InvalidationPreviewSchema.parse(FIXTURES['video.invalidation_preview']);

function textOf(view: ReturnType<typeof readyImpact>): string {
  return JSON.stringify(view);
}

describe('readyImpact — the script-wording row of the matrix', () => {
  it('shows what changes, what goes stale, what survives and the calls, in order', () => {
    const view = readyImpact(preview);
    expect(view.kind).toBe('ready');
    expect(view.chip).toBe('4 stale');
    expect(view.changes).toBe('Script rev 4 → rev 5 · wording only');
    expect(view.stale.map((row) => row.code)).toEqual(['SB', 'NA', 'TC', 'RE']);
    expect(view.stale.map((row) => row.label)).toEqual([
      'Storyboard',
      'Narration',
      'Timing & captions',
      'Render',
    ]);
    expect(view.stale[0]?.quantity).toBe(17);
    expect(view.stale[0]?.note).toBe('storyboard prompts re-derived');
    expect(view.survives.map((row) => row.label)).toEqual(['images', 'sources']);
    expect(view.calls).toEqual([
      'image calls: 0 · TTS calls: 1',
      'render passes: 1 · text calls: 1',
    ]);
    expect(view.conditional).toBeNull();
    expect(view.canApply).toBe(true);
    expect(view.canRegenerate).toBe(true);
    expect(view.regenerateHidden).toBe(false);
  });

  it('never prices anything: no currency, no totals, no "cost"', () => {
    const text = textOf(readyImpact(preview));
    for (const forbidden of ['$', '£', '€', 'cost', 'credit', 'price', 'total']) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('lists each server blocker and disables both commits (C-07 honesty)', () => {
    const view = readyImpact({ ...preview, blockers: ['script is locked by another revision'] });
    expect(view.blockers).toEqual(['script is locked by another revision']);
    expect(view.canApply).toBe(false);
    expect(view.canRegenerate).toBe(false);
  });
});

describe('conditional aspect-ratio case — W-07', () => {
  it('keeps the spend commit disabled while the local reframe check is pending', () => {
    const view = readyImpact({
      ...preview,
      edits: ['aspect_ratio'],
      invalidated: [
        { stage: 'SB', state_after: 'stale', quantity: 17, note: 'composition' },
        { stage: 'RE', state_after: 'stale', quantity: 1, note: 'one render pass' },
      ],
      conditional: { check: 'reframe', status: 'pending', image_calls_if_not_reframable: 17 },
      calls: { image: 0, tts: 0, text: 0, render_passes: 1 },
    });
    expect(view.canApply).toBe(true);
    expect(view.canRegenerate).toBe(false);
    expect(view.conditional).toBe(
      'Images: pending reframe check — 17 calls only if the current images cannot be reframed.',
    );
  });

  it('states the exact outcome once the check resolves', () => {
    const reframable = readyImpact({
      ...preview,
      edits: ['aspect_ratio'],
      conditional: { check: 'reframe', status: 'reframable', image_calls_if_not_reframable: 17 },
      calls: { image: 0, tts: 0, text: 0, render_passes: 1 },
    });
    expect(reframable.canRegenerate).toBe(true);
    expect(reframable.conditional).toBe(
      'Images: reframable — 0 image calls; the stored images are reframed locally.',
    );

    const notReframable = readyImpact({
      ...preview,
      edits: ['aspect_ratio'],
      conditional: {
        check: 'reframe',
        status: 'not_reframable',
        image_calls_if_not_reframable: 17,
      },
      calls: { image: 17, tts: 0, text: 0, render_passes: 1 },
    });
    expect(notReframable.canRegenerate).toBe(true);
    expect(notReframable.conditional).toBe(
      'Images: not reframable — 17 image calls; the reframe check completed.',
    );
  });
});

describe('panel states — idle, computing, failed, nothing to invalidate', () => {
  it('collapses to one compact line with no changes', () => {
    const view = idleImpact();
    expect(view.kind).toBe('idle');
    expect(view.message).toBe(NO_CHANGES);
    expect(view.message).toBe('No unsaved changes');
    expect(view.canApply).toBe(false);
    expect(view.canRegenerate).toBe(false);
  });

  it('skeletons the panel while the server computes, with both commits disabled', () => {
    const view = computingImpact();
    expect(view.kind).toBe('computing');
    expect(view.message).toBe('computing impact');
    expect(view.chip).toBe('computing');
    expect(view.canApply).toBe(false);
    expect(view.canRegenerate).toBe(false);
  });

  it('states the failure in C-07 words and blocks editing and regeneration', () => {
    const view = failedImpact();
    expect(view.message).toBe(C07_FAILED);
    expect(C07_FAILED).toBe(
      'The impact of this change could not be computed, so regeneration is blocked. Editing and regeneration are both disabled until it can be computed — this prevents a change whose cost you could not see.',
    );
    expect(view.canApply).toBe(false);
    expect(view.canRegenerate).toBe(false);
  });

  it('shows the first-draft case with apply enabled and regeneration hidden', () => {
    const view = readyImpact({
      ...preview,
      invalidated: [],
      survives: [],
      calls: { image: 0, tts: 0, text: 0, render_passes: 0 },
    });
    expect(view.message).toBe(NO_ASSETS);
    expect(view.message).toBe('No assets exist yet — this edit costs nothing to apply.');
    expect(view.canApply).toBe(true);
    expect(view.regenerateHidden).toBe(true);
    expect(view.canRegenerate).toBe(false);
  });
});
