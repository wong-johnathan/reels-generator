import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { extractBlock, mediaBlocks } from './helpers/css.js';

/**
 * Scene grid and scene detail geometry — UI_SPEC §4.4 (168 px tiles, 9:16,
 * meta 32), §5 UC-07/UC-08/UC-09, §6.7 W-06, §7 bands, §8.3 targets.
 *
 * The grid is the densest surface in the product; its measurements are the
 * specification, so they are asserted rather than left to review.
 */

const css = readFileSync(new URL('../../src/web/styles/workspace.css', import.meta.url), 'utf8');

describe('scene grid geometry (UI_SPEC §4.4, §5 UC-07)', () => {
  it('is an auto-fill grid of 168 px minimum tiles with a 12 px gap', () => {
    const grid = extractBlock(css, '.scene-tiles');
    expect(grid).toMatch(/display:\s*grid/);
    expect(grid).toMatch(/grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(168px,\s*1fr\)\)/);
    expect(grid).toMatch(/gap:\s*var\(--s-5\)/);
  });

  it('is a 168 px tile with a clipped 9:16 thumb and a 32 px meta row', () => {
    const tile = extractBlock(css, '.scene-tile');
    expect(tile).toMatch(/width:\s*168px/);
    expect(tile).toMatch(/border-radius:\s*var\(--r-3\)/);
    expect(tile).toMatch(/border:\s*1px solid var\(--border-subtle\)/);
    expect(extractBlock(css, '.scene-thumb')).toMatch(/aspect-ratio:\s*9\s*\/\s*16/);
    expect(extractBlock(css, '.scene-thumb img')).toMatch(/object-fit:\s*cover/);
    expect(extractBlock(css, '.scene-meta')).toMatch(/height:\s*var\(--s-9\)/);
  });

  it('keeps the image still on hover and inverts nothing but the border (UC-08)', () => {
    const hover = extractBlock(css, '.scene-tile:hover');
    expect(hover).toMatch(/border-color:\s*var\(--border-strong\)/);
    expect(hover).not.toMatch(/transform|filter|scale/);
  });

  it('draws the focus ring inside the clip so it is never cut off', () => {
    const focus = extractBlock(css, '.scene-tile:focus-visible');
    expect(focus).toMatch(/outline:\s*var\(--focus-ring-width\)/);
    expect(focus).toMatch(/outline-offset:\s*calc\(-1 \* var\(--focus-ring-offset\)\)/);
  });

  it('marks the selected tile with a 2 px accent outline and a selected meta row', () => {
    const selected = extractBlock(css, ".scene-tile[aria-selected='true']");
    expect(selected).toMatch(/outline:\s*2px solid var\(--accent\)/);
    expect(extractBlock(css, ".scene-tile[aria-selected='true'] .scene-meta")).toMatch(
      /background:\s*var\(--surface-selected\)/,
    );
  });
});

describe('checkpoint banner and release control (UC-07 variants)', () => {
  it('is a 40 px amber-tinted banner above the grid', () => {
    const banner = extractBlock(css, '.checkpoint-banner');
    expect(banner).toMatch(/min-height:\s*var\(--s-10\)/);
    expect(banner).toMatch(/background:\s*var\(--surface-warning-tint\)/);
    expect(banner).toMatch(/border-left:\s*4px solid var\(--warning\)/);
  });

  it('gives the release and replace controls a 44 px review target', () => {
    expect(extractBlock(css, '.scene-release .btn')).toMatch(/height:\s*var\(--target-review\)/);
    expect(extractBlock(css, '.scene-replace .btn')).toMatch(/height:\s*var\(--target-review\)/);
  });

  it('keeps the selection bar 44 px and sticky at the bottom of the tab', () => {
    const bar = extractBlock(css, '.scene-selection');
    expect(bar).toMatch(/min-height:\s*var\(--target-review\)/);
    expect(bar).toMatch(/position:\s*sticky/);
    expect(bar).toMatch(/bottom:\s*0/);
  });

  it('separates the reorder controls by at least 8 px (AX-17)', () => {
    expect(extractBlock(css, '.scene-selection-buttons')).toMatch(/gap:\s*var\(--s-4\)/);
  });
});

describe('scene detail (UC-09)', () => {
  it('fixes the image box at 360 by 640 so a missing image cannot shift the layout', () => {
    const figure = extractBlock(css, '.scene-detail-image');
    expect(figure).toMatch(/width:\s*360px/);
    expect(figure).toMatch(/aspect-ratio:\s*9\s*\/\s*16/);
  });

  it('keeps the prompt readable at 13 px mono with a scroll cap', () => {
    const prompt = extractBlock(css, '.scene-prompt');
    expect(prompt).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(prompt).toMatch(/font-size:\s*var\(--t-30\)/);
    expect(prompt).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('lays provenance out as a two-column description list', () => {
    expect(css).toMatch(
      /\.scene-provenance-dl[^{]*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*160px minmax\(0,\s*1fr\)/,
    );
  });
});

describe('responsive bands (UI_SPEC §7.2)', () => {
  it('stacks the detail into one column below 1024', () => {
    const bodies = mediaBlocks(css)
      .filter((media) => media.query.includes('max-width: 1023px'))
      .map((media) => media.body)
      .join('\n');
    expect(bodies).toContain('.scene-detail-body');
  });

  it('replaces the grid and mutation controls with monitoring rows below 768', () => {
    const bodies = mediaBlocks(css)
      .filter((media) => media.query.includes('max-width: 767px'))
      .map((media) => media.body)
      .join('\n');
    expect(bodies).toMatch(/\.scene-list\s*\{[^}]*display:\s*grid/);

    expect(css).toMatch(
      /\.scene-grid \.scene-tiles,\s*\.scene-grid \.scene-selection[^}]*display:\s*none/,
    );
  });

  it('uses a review-lite pager only between 768 and 1023', () => {
    const body =
      mediaBlocks(css).find(
        (media) =>
          media.query.includes('min-width: 768px') && media.query.includes('max-width: 1023px'),
      )?.body ?? '';
    expect(extractBlock(body, '.scene-pager')).toMatch(/display:\s*block/);
    expect(extractBlock(css, '.scene-pager-track')).toMatch(/overflow-x:\s*auto/);
    expect(extractBlock(css, '.scene-pager .scene-tile')).toMatch(/width:\s*280px/);
    expect(extractBlock(css, '.scene-list .scene-thumb')).toMatch(/width:\s*72px/);
  });

  it('never lets the grid force a horizontal page scroll', () => {
    expect(extractBlock(css, '.scene-grid')).toMatch(/min-width:\s*0/);
    expect(extractBlock(css, '.scene-grid')).toMatch(/overflow-wrap:\s*anywhere/);
    for (const region of ['.scene-tiles', '.scene-list', '.scene-pager-track']) {
      expect(extractBlock(css, region)).toMatch(/overflow-x:\s*auto/);
    }
    const mobile = mediaBlocks(css)
      .filter((media) => media.query === '(max-width: 767px)')
      .map((media) => media.body)
      .join('\n');
    expect(
      extractBlock(mobile, '.scene-grid .scene-release, .scene-grid .checkpoint-actions'),
    ).toMatch(/display:\s*none/);
    const reduced =
      mediaBlocks(css).find((media) => media.query.includes('prefers-reduced-motion: reduce'))
        ?.body ?? '';
    expect(extractBlock(reduced, '.scene-grid .scene-tile')).toMatch(/transition:\s*none/);
  });
});
