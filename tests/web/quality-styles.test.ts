import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { extractBlock, mediaBlocks } from './helpers/css.js';

/**
 * S-15 stylesheet — UI_SPEC §2 (tokens only), §3.2 (state rows are readable in
 * greyscale, not colour-only), §7.1/§7.2 (bands: ≤767 is monitoring-only, one
 * line replaces the approval control), §9.6 (tabular numbers).
 */

const css = readFileSync(new URL('../../src/web/styles/quality.css', import.meta.url), 'utf8');

describe('S-15 quality styles', () => {
  it('keeps checks contained, with a visible scroll cue and 8 px action gaps', () => {
    expect(extractBlock(css, '.quality-player, .quality-checks')).toContain('min-width: 0');
    expect(extractBlock(css, '.quality-table-wrap::before')).toContain('content:');
    expect(extractBlock(css, '.quality-approve-form')).toContain('gap: var(--s-4)');
    expect(extractBlock(css, '.quality-return-links')).toContain('gap: var(--s-4)');
  });

  it('uses tokens for every colour — no raw hex', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('sets the 9:16 output beside the checks and stacks them under 1024', () => {
    const frame = extractBlock(css, '.quality-frame');
    expect(frame).toMatch(/aspect-ratio:\s*9\s*\/\s*16/);
    expect(frame).toMatch(/position:\s*relative/);
    const grid = extractBlock(css, '.quality-grid');
    expect(grid).toMatch(/grid-template-columns:\s*minmax\(0, 340px\) minmax\(0, 1fr\)/);
    const narrow = mediaBlocks(css).find((block) => block.query === '(max-width: 1023px)');
    expect(narrow?.body).toMatch(
      /\.quality-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s,
    );
    expect(narrow?.body).toMatch(/\.quality-frame\s*\{[^}]*max-width:\s*320px/s);
  });

  it('draws the one safe-area rectangle at a 5 % inset (D13)', () => {
    const safe = extractBlock(css, '.quality-safe-area');
    expect(safe).toMatch(/inset:\s*5%/);
    expect(safe).toMatch(/border:\s*1px dashed var\(--accent\)/);
    expect(safe).toMatch(/pointer-events:\s*none/);
  });

  it('keeps the check table scrollable, focused and in tabular figures', () => {
    const wrap = extractBlock(css, '.quality-table-wrap');
    expect(wrap).toMatch(/overflow:\s*auto/);
    expect(extractBlock(css, '.quality-table-wrap:focus-visible')).toMatch(
      /outline:\s*var\(--focus-ring-width\)/,
    );
    expect(extractBlock(css, '.quality-table')).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(
      extractBlock(
        css,
        '.quality-summary, .quality-detail, .quality-checked, .quality-checks-summary',
      ),
    ).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });

  it('marks each row status with an edge and a word, not colour alone (§3.2)', () => {
    const pass = extractBlock(css, ".quality-table tbody tr[data-status='pass']");
    expect(pass).toMatch(/box-shadow:\s*inset 3px 0 0 var\(--success\)/);
    const fail = extractBlock(css, ".quality-table tbody tr[data-status='fail']");
    expect(fail).toMatch(/box-shadow:\s*inset 3px 0 0 var\(--danger\)/);
    expect(fail).toMatch(/background:\s*var\(--surface-danger-tint\)/);
    const missing = extractBlock(css, ".quality-table tbody tr[data-status='missing']");
    expect(missing).toMatch(/box-shadow:\s*inset 3px 0 0 var\(--warning\)/);
  });

  it('sizes the approval and return controls at 44 px', () => {
    expect(extractBlock(css, '.quality-approve-button, .quality-return-link')).toMatch(
      /min-height:\s*var\(--target-review\)/,
    );
    expect(extractBlock(css, '.quality-note-input')).toMatch(
      /min-height:\s*var\(--target-review\)/,
    );
  });

  it('hides every approval control at ≤767 and states the monitoring rule (§7.1)', () => {
    const phone = mediaBlocks(css).find((block) => block.query === '(max-width: 767px)');
    expect(phone).toBeDefined();
    expect(phone?.body).toMatch(/\.quality-approval,\s*\.quality-return\s*\{\s*display:\s*none;/);
    expect(phone?.body).toMatch(/\.quality-band-note\s*\{\s*display:\s*block;/);
    expect(extractBlock(css, '.quality-band-note')).toMatch(/display:\s*none/);
  });

  it('keeps the failure callout structural, not colour-only', () => {
    const callout = extractBlock(css, '.quality-failure');
    expect(callout).toMatch(/border:\s*1px solid var\(--danger\)/);
    expect(callout).toMatch(/border-left-width:\s*4px/);
    expect(callout).toMatch(/background:\s*var\(--surface-danger-tint\)/);
  });
});
