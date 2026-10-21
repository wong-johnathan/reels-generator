import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { extractBlock, mediaBlocks } from './helpers/css.js';

/**
 * S-10 and UC-06 geometry (UI_SPEC §6.6 W-05, §5 UC-06, §7 bands, AX-02).
 *
 * The measurements the spec fixes — the 360 px sticky impact column, 40 px
 * status and budget bars, 56 px claim rows and approval block, 44 px commits —
 * are asserted here so a later refactor cannot quietly flatten them.
 */

const css = readFileSync(new URL('../../src/web/styles/workspace.css', import.meta.url), 'utf8');

describe('S-10 layout (W-05)', () => {
  it('puts the editor first and the impact column at 360 px (AX-02 order stays in the DOM)', () => {
    const review = extractBlock(css, '.script-review');
    expect(review).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+360px/);
    expect(review).toMatch(/align-items:\s*start/);
  });

  it('fixes the status and budget bars at 40 px', () => {
    expect(extractBlock(css, '.script-status')).toMatch(/min-height:\s*40px/);
    expect(extractBlock(css, '.script-budget')).toMatch(/min-height:\s*40px/);
  });

  it('measures the editor column at 68ch and the approval block at 56 px', () => {
    expect(extractBlock(css, '.script-field textarea, .script-field input')).toMatch(
      /max-width:\s*68ch/,
    );
    expect(extractBlock(css, '.script-approval')).toMatch(/min-height:\s*56px/);
    expect(extractBlock(css, '.claims-table td')).toMatch(/height:\s*56px/);
  });

  it('keeps the panel sticky and inline, never a modal (DI-02)', () => {
    const impact = extractBlock(css, '.script-impact');
    expect(impact).toMatch(/position:\s*sticky/);
    expect(impact).toMatch(/top:\s*40px/);
  });

  it('gives both commits a 44 px target and stacks them', () => {
    const actions = extractBlock(css, '.impact-actions .btn');
    expect(actions).toMatch(/width:\s*100%/);
    expect(actions).toMatch(/min-height:\s*44px/);
  });

  it('stacks the impact column below the editor at the compact band', () => {
    const bands = mediaBlocks(css);
    const compact = bands.find((band) => band.query.includes('1100px'));
    expect(compact).toBeDefined();
    expect(compact?.body).toMatch(
      /\.script-review\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s,
    );
    expect(compact?.body).toMatch(/\.script-impact\s*\{[^}]*position:\s*static/s);
  });

  it('keeps hidden content out of the layout even when a component sets display', () => {
    expect(extractBlock(css, '.script-review [hidden]')).toMatch(/display:\s*none\s*!important/);
  });
});
