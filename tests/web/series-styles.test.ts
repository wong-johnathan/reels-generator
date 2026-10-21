import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { extractBlock, mediaBlocks } from './helpers/css.js';

/**
 * Series surfaces — S-03 list and S-04 editor (UI_SPEC §4.1/§4.3/§4.4, §5
 * UC-17/UC-18/UC-19, §7.2, §9.6). Tokens only: no invented colour, no raw hex
 * (the login white label already lives in auth.css), 44 px primary targets and
 * a 320 px reflow with no page-level horizontal scroll.
 */

const css = readFileSync(new URL('../../src/web/styles/series.css', import.meta.url), 'utf8');

describe('S-03 table (UI_SPEC §4.4, UC-17)', () => {
  it('uses the 44 px row and 28 px sticky header geometry', () => {
    expect(extractBlock(css, '.series-table tbody tr')).toMatch(/height:\s*44px/);
    const head = extractBlock(css, '.series-table thead th');
    expect(head).toMatch(/height:\s*28px/);
    expect(head).toMatch(/position:\s*sticky/);
    expect(head).toMatch(/top:\s*0/);
    expect(head).toMatch(/background:\s*var\(--surface-raised\)/);
  });

  it('draws row rules only, never vertical rules or zebra stripes', () => {
    const row = extractBlock(css, '.series-table tbody td');
    expect(row).toMatch(/border-bottom:\s*1px solid var\(--border-subtle\)/);
    expect(css).not.toMatch(/nth-child\((odd|even)\)/);
  });

  it('keeps the version chip unpadded, mono and in the inset surface', () => {
    const chip = extractBlock(css, '.series-version');
    expect(chip).toMatch(/font-size:\s*var\(--t-10\)/);
    expect(chip).toMatch(/background:\s*var\(--surface-inset\)/);
    expect(chip).toMatch(/border-radius:\s*var\(--r-1\)/);
    expect(chip).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it('makes the first-run action a 44 px primary button (§9.2)', () => {
    const button = extractBlock(css, '.series-empty .btn-primary');
    expect(button).toMatch(/height:\s*var\(--target-review\)/);
    expect(extractBlock(css, '.btn-primary')).toMatch(/background:\s*var\(--accent-fill\)/);
    expect(extractBlock(css, '.btn-primary')).toMatch(/color:\s*#ffffff/i);
  });

  it('paints skeletons with the inset surface so geometry does not jump (AX-28)', () => {
    expect(extractBlock(css, '.series-skeleton')).toMatch(/background:\s*var\(--surface-inset\)/);
  });
});

describe('S-04 form (UI_SPEC §4.3, UC-19)', () => {
  it('uses a 160 px label column and a 420 px control column at desktop width', () => {
    const field = extractBlock(css, '.series-field');
    expect(field).toMatch(/grid-template-columns:\s*160px minmax\(0,\s*420px\)/);
    expect(field).toMatch(/column-gap:\s*var\(--s-6\)/);
    expect(field).toMatch(/row-gap:\s*var\(--s-2\)/);
    expect(extractBlock(css, '.series-fields')).toMatch(/gap:\s*var\(--s-7\)/);
  });

  it('sets controls to the UC-19 32 px field height with a visible label', () => {
    const control = extractBlock(css, '.series-control');
    expect(control).toMatch(/height:\s*32px/);
    expect(control).toMatch(/background:\s*var\(--surface-inset\)/);
    expect(control).toMatch(/border:\s*1px solid var\(--border-default\)/);
    expect(extractBlock(css, '.series-label')).toMatch(/font-size:\s*var\(--t-30\)/);
  });

  it('uses the danger token for a field error and the accent for a changed mark', () => {
    expect(extractBlock(css, '.series-field-error')).toMatch(/color:\s*var\(--danger\)/);
    const mark = extractBlock(css, '.series-changed');
    expect(mark).toMatch(/color:\s*var\(--accent\)/);
    expect(mark).toMatch(/font-size:\s*var\(--t-10\)/);
  });

  it('gives the commit button a 44 px target and the panel a raised surface', () => {
    const button = extractBlock(css, '.series-commit .btn-primary');
    expect(button).toMatch(/height:\s*var\(--target-review\)/);
    expect(button).toMatch(/width:\s*100%/);
    expect(extractBlock(css, '.series-commit')).toMatch(/background:\s*var\(--surface-panel\)/);
  });

  it('marks success and conflict with the success and danger tints', () => {
    expect(extractBlock(css, '.series-saved')).toMatch(
      /background:\s*var\(--surface-success-tint\)/,
    );
    const conflict = extractBlock(css, '.series-conflict');
    expect(conflict).toMatch(/border-left:\s*4px solid var\(--danger\)/);
    expect(conflict).toMatch(/background:\s*var\(--surface-danger-tint\)/);
  });
});

describe('responsive bands (UI_SPEC §7)', () => {
  it('stacks the label above the control below 1024 px', () => {
    const tablet = mediaBlocks(css).find((block) => block.query === '(max-width: 1023px)');
    expect(tablet?.body).toMatch(/\.series-field[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  });

  it('turns the table into labelled cards below 768 px with no page scroll', () => {
    const phone = mediaBlocks(css).find((block) => block.query === '(max-width: 767px)');
    expect(phone?.body).toMatch(/\.series-table thead[^}]*display:\s*none/s);
    expect(phone?.body).toMatch(/\.series-table tr[^}]*display:\s*block/s);
    expect(phone?.body).toMatch(/data-label/s);
    expect(phone?.body).toMatch(/overflow-x:\s*hidden/);
  });

  it('reflows to 16 px page padding at 480 px (§7.1)', () => {
    const phone = mediaBlocks(css).find((block) => block.query === '(max-width: 480px)');
    expect(phone?.body).toMatch(/padding:\s*var\(--s-6\)/);
  });
});

describe('token discipline', () => {
  it('adds no raw colour of its own except the measured white primary label', () => {
    const withoutWhite = css.replace(/#ffffff/gi, '');
    expect(withoutWhite).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
