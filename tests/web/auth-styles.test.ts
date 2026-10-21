import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { extractBlock, mediaBlocks } from './helpers/css.js';

/**
 * Auth surfaces stylesheet — S-01 measurements from UI_SPEC §6.1 and the
 * tokens-only rule from §2.1 (no invented colour), with the 44 px targets of
 * AX-17 and the 320 px reflow of AX-14.
 */

const css = readFileSync(new URL('../../src/web/styles/auth.css', import.meta.url), 'utf8');

describe('login card (UI_SPEC §6.1)', () => {
  it('is a 400 px panel with a 6 px radius, 32 px padding and e-1', () => {
    const card = extractBlock(css, '.login-card');
    expect(card).toMatch(/max-width:\s*400px/);
    expect(card).toMatch(/background:\s*var\(--surface-panel\)/);
    expect(card).toMatch(/border:\s*1px solid var\(--border-subtle\)/);
    expect(card).toMatch(/border-radius:\s*var\(--r-3\)/);
    expect(card).toMatch(/padding:\s*var\(--s-9\)/);
    expect(card).toMatch(/box-shadow:\s*var\(--e-1\)/);
  });

  it('sets the wordmark at 32/40 600 and the sub-line at 13/20 secondary', () => {
    const wordmark = extractBlock(css, '.login-wordmark');
    expect(wordmark).toMatch(/font-size:\s*var\(--t-80\)/);
    expect(wordmark).toMatch(/line-height:\s*var\(--lh-80\)/);
    expect(wordmark).toMatch(/font-weight:\s*var\(--fw-semibold\)/);
    const subline = extractBlock(css, '.login-subline');
    expect(subline).toMatch(/font-size:\s*var\(--t-30\)/);
    expect(subline).toMatch(/color:\s*var\(--text-secondary\)/);
  });

  it('gives the fields and the submit a 44 px target (AX-17)', () => {
    expect(extractBlock(css, '.login-input')).toMatch(/height:\s*var\(--target-review\)/);
    expect(extractBlock(css, '.login-submit')).toMatch(/height:\s*var\(--target-review\)/);
    expect(extractBlock(css, '.login-submit')).toMatch(/width:\s*100%/);
  });

  it('places the error above the submit and the note below it', () => {
    expect(css.indexOf('.login-error')).toBeLessThan(css.indexOf('.login-submit'));
    expect(css.indexOf('.login-note')).toBeGreaterThan(css.indexOf('.login-submit'));
  });

  it('uses the danger token for the error and the warning tint for the banner', () => {
    expect(extractBlock(css, '.login-error')).toMatch(/color:\s*var\(--danger\)/);
    const notice = extractBlock(css, '.auth-notice');
    expect(notice).toMatch(/border-left:\s*4px solid var\(--warning\)/);
    expect(notice).toMatch(/background:\s*var\(--surface-warning-tint\)/);
  });

  it('paints the pressed submit with the inverse flash token reserved for it', () => {
    const pressed = extractBlock(css, '.login-submit:active');
    expect(pressed).toMatch(/background:\s*var\(--surface-inverse\)/);
    expect(pressed).toMatch(/color:\s*var\(--text-inverse\)/);
  });

  it('stops the one animation under reduced motion (AX-16)', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/\.spinner[^}]*animation:\s*none/s);
  });

  it('keeps [hidden] elements hidden and reflows to 16 px at phone width (AX-14)', () => {
    expect(extractBlock(css, '.spinner[hidden]')).toMatch(/display:\s*none/);
    const phone = mediaBlocks(css).find((entry) => entry.query === '(max-width: 480px)');
    expect(phone?.body).toMatch(/padding:\s*var\(--s-6\)/);
  });

  it('adds no raw colour of its own except the measured white button label', () => {
    const withoutWhiteLabel = css.replace(/#ffffff/gi, '');
    expect(withoutWhiteLabel).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
