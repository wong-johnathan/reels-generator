import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { extractBlock, mediaBlocks } from './helpers/css.js';

/**
 * S-14 stylesheet — UI_SPEC §2 (tokens only), §3.2 (the active word is visible
 * in greyscale too), §7.1/§7.2 (bands: ≤767 is monitoring-only, one line
 * replaces every spend/approval control), §9.6 (tabular numbers).
 */

const css = readFileSync(new URL('../../src/web/styles/narration.css', import.meta.url), 'utf8');

describe('S-14 narration styles', () => {
  it('keeps timing tables contained, discoverable and retry controls separated by 8 px', () => {
    expect(extractBlock(css, '.narration-table-wrap')).toContain('min-width: 0');
    expect(extractBlock(css, '.narration-table-wrap::before')).toContain('content:');
    expect(extractBlock(css, '.narration-rerun-form')).toContain('gap: var(--s-4)');
  });

  it('uses tokens for every colour — no raw hex', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('lays the player and the band side by side and stacks them under 1024', () => {
    const grid = extractBlock(css, '.narration-grid');
    expect(grid).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/);
    const narrow = mediaBlocks(css).find((block) => block.query === '(max-width: 1023px)');
    expect(narrow?.body).toMatch(
      /\.narration-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s,
    );
  });

  it('keeps the word list inside its own scroll container with a focus ring', () => {
    const wrap = extractBlock(css, '.narration-table-wrap');
    expect(wrap).toMatch(/max-height:\s*360px/);
    expect(wrap).toMatch(/overflow:\s*auto/);
    expect(extractBlock(css, '.narration-table-wrap:focus-visible')).toMatch(
      /outline:\s*var\(--focus-ring-width\)/,
    );
  });

  it('marks the active word with a surface plus an inset accent edge (§3.2)', () => {
    const active = extractBlock(css, ".narration-words tbody tr[data-active='true']");
    expect(active).toMatch(/background:\s*var\(--surface-selected\)/);
    expect(active).toMatch(/box-shadow:\s*inset 3px 0 0 var\(--accent\)/);
    expect(
      extractBlock(css, ".narration-words tbody tr[data-active='true'] .narration-word"),
    ).toMatch(/color:\s*var\(--accent\)/);
  });

  it('sizes the audio element and the spend/approval controls at 44 px', () => {
    expect(extractBlock(css, '.narration-audio')).toMatch(/height:\s*var\(--target-review\)/);
    expect(
      extractBlock(
        css,
        '.narration-accept-button, .narration-rerun-button, .narration-rerun-confirm',
      ),
    ).toMatch(/min-height:\s*var\(--target-review\)/);
  });

  it('renders numbers in tabular figures', () => {
    expect(extractBlock(css, '.narration-words')).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(
      extractBlock(
        css,
        '.narration-summary, .narration-detail, .narration-coverage, .narration-transport',
      ),
    ).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it('hides every spend/approval control at ≤767 and states the monitoring rule (§7.1)', () => {
    const phone = mediaBlocks(css).find((block) => block.query === '(max-width: 767px)');
    expect(phone).toBeDefined();
    expect(phone?.body).toMatch(/\.narration-accept,\s*\.narration-spend\s*\{\s*display:\s*none;/);
    expect(phone?.body).toMatch(/\.narration-band-note\s*\{\s*display:\s*block;/);
    // The note itself only exists in that band.
    expect(extractBlock(css, '.narration-band-note')).toMatch(/display:\s*none/);
  });

  it('keeps the failure callout structural, not colour-only', () => {
    const callout = extractBlock(css, '.narration-out-of-band');
    expect(callout).toMatch(/border:\s*1px solid var\(--danger\)/);
    expect(callout).toMatch(/border-left-width:\s*4px/);
    expect(callout).toMatch(/background:\s*var\(--surface-danger-tint\)/);
  });
});
