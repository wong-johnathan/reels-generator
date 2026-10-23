import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { extractBlock } from './helpers/css.js';

/**
 * S-16/S-19/S-21 styling guard: token-only colour, 44 px primary controls,
 * 36 px attempt rows, structural states (never colour alone), horizontal
 * scroll for dense tables and the responsive bands from UI_SPEC §4.
 */

const css = readFileSync(new URL('../../src/web/styles/operations.css', import.meta.url), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(selector + ' {');
  if (start === -1) throw new Error('missing rule ' + selector);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('operations.css tokens and contrast', () => {
  it('uses design tokens for every colour', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/rgba?\(/i);
    expect(css).not.toMatch(/hsla?\(/i);
    expect(css).toContain('var(--');
  });

  it('scopes every rule to an operations surface', () => {
    const selectors = [...css.matchAll(/^([.#][^{}]+?)\s*\{/gm)]
      .map((match) => match[1]?.trim() ?? '')
      .filter((selector) => selector.length > 0 && !selector.startsWith('@'));
    expect(selectors.length).toBeGreaterThan(20);
    for (const selector of selectors) {
      expect(
        selector.startsWith('.export') ||
          selector.startsWith('.health') ||
          selector.startsWith('.settings') ||
          selector.startsWith('.ops'),
      ).toBe(true);
    }
  });
});

describe('operations.css layout and targets', () => {
  it('uses a defined 44 px token for mobile package downloads', () => {
    expect(extractBlock(css, '.export-file-item .export-file-download')).toContain(
      'min-height: var(--target-review)',
    );
  });

  it('contains generic table regions and a persistent visible scroll cue', () => {
    expect(extractBlock(css, '.ops-table-wrap')).toContain('overflow-x: auto');
    expect(extractBlock(css, '.ops-table-wrap')).toContain('max-width: 100%');
    expect(extractBlock(css, '.ops-table-wrap:focus-visible')).toContain('outline');
    expect(
      extractBlock(
        css,
        '.export-table-wrap::before, .export-pin-table-wrap::before, .health-table-wrap::before, .settings-table-wrap::before, .ops-table-wrap::before',
      ),
    ).toContain('content:');
  });

  it('puts package and pins side by side only from 1024 px', () => {
    expect(block('.export-grid')).toContain('grid-template-columns');
    expect(block('.export-grid')).toContain('var(--aside-wide)');
    const narrow = css.slice(css.indexOf('@media (max-width: 1023px)'));
    expect(narrow).toContain('.export-grid');
    expect(narrow).toContain('grid-template-columns: minmax(0, 1fr)');
  });

  it('keeps every file row at 44 px and attempt rows at 36 px', () => {
    expect(block('.export-table tbody tr')).toContain('height: 44px');
    expect(block('.health-attempt-table tbody tr')).toContain('height: 36px');
    expect(block('.export-download-summary')).toContain('min-height: var(--target-review)');
    expect(
      readFileSync(new URL('../../src/web/styles/tokens.css', import.meta.url), 'utf8'),
    ).toContain('--target-review: 44px');
  });

  it('scrolls dense tables horizontally inside a labelled, focusable region', () => {
    const wrap = css.slice(
      css.indexOf('.export-table-wrap,'),
      css.indexOf('}', css.indexOf('.export-table-wrap,')),
    );
    expect(wrap).toContain('overflow-x: auto');
    expect(
      block(
        '.export-table-wrap:focus-visible,\n.health-table-wrap:focus-visible,\n.settings-table-wrap:focus-visible',
      ),
    ).toContain('outline');
    expect(css).toContain('position: sticky');
  });

  it('marks an unknown-charge row structurally, not only with colour', () => {
    expect(css).toContain("tr[data-charge='unknown']");
    expect(
      block(
        ".health-att-charge[data-charge='unknown'],\n.health-attempt-table tr[data-charge='unknown'] .health-att-charge",
      ),
    ).toContain('border-left');
  });

  it('gives the disk meter a 2 px bar with no colour-only meaning', () => {
    expect(block('.health-disk-meter')).toContain('height: 2px');
    expect(css).toContain('::-webkit-progress-value');
    expect(css).toContain('::-moz-progress-bar');
  });

  it('hides the build control and shows the band note below 768 px', () => {
    const narrow = css.slice(css.indexOf('@media (max-width: 767px)'));
    expect(narrow).toContain('.export-build');
    expect(narrow).toContain('display: none');
    expect(narrow).toContain('.export-band-note');
    expect(narrow).toContain('display: block');
  });

  it('stays usable below 480 px', () => {
    const tiny = css.slice(css.indexOf('@media (max-width: 480px)'));
    expect(tiny).toContain('.export-file-download');
    expect(tiny).toContain('flex-wrap: wrap');
  });

  it('swaps the package table for a stacked list below 768 px', () => {
    expect(block('.export-file-list')).toContain('display: none');
    const narrow = css.slice(css.indexOf('@media (max-width: 767px)'));
    expect(narrow).toContain('.export-package-table');
    expect(narrow).toContain('display: none');
    expect(narrow).toContain('.export-file-list');
    expect(narrow).toContain('display: block');
  });

  it('gives focus a visible, token-defined ring', () => {
    expect(css).toContain(':focus-visible');
    expect(css).toContain('var(--focus-ring');
  });
});
