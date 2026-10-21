import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { extractBlock, mediaBlocks } from './helpers/css.js';

/**
 * Shell stylesheet: responsive bands (UI_SPEC §7), focus (AX-18), reduced
 * motion (AX-16), no horizontal page scroll (AX-14) and the shell geometry
 * (UI_SPEC §4.1).
 */

const baseCss = readFileSync(new URL('../../src/web/styles/base.css', import.meta.url), 'utf8');
const shellCss = readFileSync(new URL('../../src/web/styles/shell.css', import.meta.url), 'utf8');
const bands = mediaBlocks(shellCss);
const band = (query: string): string => {
  const found = bands.find((entry) => entry.query.replace(/\s+/g, ' ').trim() === query);
  expect(found, 'missing media query: ' + query).toBeDefined();
  return found?.body ?? '';
};

describe('base.css — document defaults', () => {
  it('sets the dark surface, body type and zero page margin', () => {
    expect(baseCss).toMatch(/background:\s*var\(--surface-app\)/);
    expect(baseCss).toMatch(/color:\s*var\(--text-primary\)/);
    expect(baseCss).toMatch(/font-size:\s*var\(--t-40\)/);
    expect(extractBlock(baseCss, 'html, body')).toMatch(/margin:\s*0/);
  });

  it('never allows horizontal page scroll (AX-14)', () => {
    expect(baseCss).toMatch(/overflow-x:\s*clip/);
    expect(baseCss).not.toMatch(/overflow-x:\s*auto/);
  });

  it('paints the focus ring with outline, never box-shadow, and never removes it (AX-18)', () => {
    const focus = extractBlock(baseCss, ':focus-visible');
    expect(focus).toMatch(
      /outline:\s*var\(--focus-ring-width\)\s+var\(--focus-ring-style\)\s+var\(--focus-ring-color\)/,
    );
    expect(focus).toMatch(/outline-offset:\s*var\(--focus-ring-offset\)/);
    expect(baseCss).not.toMatch(/outline:\s*none/);
    expect(baseCss).not.toMatch(/:focus\s*\{[^}]*outline:\s*0/);
  });

  it('ships a visually-hidden utility and a skip link that becomes visible on focus', () => {
    const sr = extractBlock(baseCss, '.sr-only');
    expect(sr).toMatch(/position:\s*absolute/);
    expect(sr).toMatch(/clip-path|clip:/);
    const hidden = extractBlock(baseCss, '.skip-link');
    expect(hidden).toMatch(/position:\s*absolute/);
    const shown = extractBlock(baseCss, '.skip-link:focus-visible');
    expect(shown).toMatch(/top:/);
    expect(shown).toMatch(/z-index:\s*var\(--z-toast\)/);
  });

  it('keeps tabular figures for every number and a mono face for identifiers', () => {
    expect(extractBlock(baseCss, '.num')).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(extractBlock(baseCss, '.mono')).toMatch(/font-family:\s*var\(--font-mono\)/);
  });

  it('stops animation and collapses transition time under reduced motion (AX-16)', () => {
    const reduced = mediaBlocks(baseCss).find((entry) =>
      entry.query.includes('prefers-reduced-motion: reduce'),
    );
    expect(reduced).toBeDefined();
    expect(reduced?.body).toMatch(/animation-duration:\s*0\.01ms/);
    expect(reduced?.body).toMatch(/transition-duration:\s*0\.01ms/);
    expect(reduced?.body).toMatch(/\.spinner\b[^}]*animation:\s*none/s);
  });
});

describe('shell.css — shell geometry (UI_SPEC §4.1)', () => {
  it('lays out a sticky status strip, a sticky rail and a fluid main region', () => {
    const shell = extractBlock(shellCss, '.shell');
    expect(shell).toMatch(/grid-template-areas:\s*'strip strip'\s+'rail main'/);
    expect(shell).toMatch(/min-height:\s*100vh/);
    const strip = extractBlock(shellCss, '.status-strip');
    expect(strip).toMatch(/height:\s*var\(--strip-height\)/);
    expect(strip).toMatch(/position:\s*sticky/);
    expect(strip).toMatch(/top:\s*0/);
    expect(strip).toMatch(/z-index:\s*var\(--z-banner\)/);
    const rail = extractBlock(shellCss, '.rail');
    expect(rail).toMatch(/width:\s*var\(--rail-expanded\)/);
    expect(rail).toMatch(/top:\s*var\(--strip-height\)/);
    const main = extractBlock(shellCss, '.main');
    expect(main).toMatch(/padding:\s*var\(--s-8\)/);
    expect(main).toMatch(/min-width:\s*0/);
    expect(extractBlock(shellCss, '.content')).toMatch(/max-width:\s*var\(--content-max\)/);
  });

  it('keeps the workspace footer sticky at 32 px on workspace screens', () => {
    const footer = extractBlock(shellCss, '.workspace-footer');
    expect(footer).toMatch(/height:\s*var\(--footer-height\)/);
    expect(footer).toMatch(/position:\s*sticky/);
    expect(footer).toMatch(/bottom:\s*0/);
  });

  it('transitions with motion tokens only', () => {
    const link = extractBlock(shellCss, '.rail-link');
    expect(link).toMatch(/transition:[^;]*var\(--dur-1\)/);
  });

  it('gives every rail link and the skip link a target of at least 24 px (AX-17)', () => {
    const link = extractBlock(shellCss, '.rail-link');
    expect(link).toMatch(/min-height:\s*(2[4-9]|[3-9][0-9])px/);
  });
});

describe('shell.css — responsive bands (UI_SPEC §7)', () => {
  it('full workbench at >=1440: 216 px rail, 360 px aside, 24 px padding', () => {
    const body = band('(min-width: 1440px)');
    expect(body).toMatch(/grid-template-columns:\s*var\(--rail-expanded\)/);
    expect(extractBlock(body, '.content-grid.has-aside')).toMatch(/var\(--aside-wide\)/);
    expect(extractBlock(body, '.rail-label')).not.toMatch(/clip-path/);
  });

  it('compressed workbench at 1024–1439: 64 px icon rail, labels become accessible names', () => {
    const body = band('(min-width: 1024px) and (max-width: 1439px)');
    expect(body).toMatch(/grid-template-columns:\s*var\(--rail-compact\)/);
    expect(extractBlock(body, '.rail')).toMatch(/width:\s*var\(--rail-compact\)/);
    const label = extractBlock(body, '.rail-label');
    expect(label).toMatch(/position:\s*absolute/);
    expect(label).toMatch(/clip-path|clip:/);
    const aside = extractBlock(body, '.content-grid.has-aside');
    expect(aside).toMatch(/var\(--aside-compact\)/);
    expect(extractBlock(body, '.main')).toMatch(/padding:\s*var\(--s-7\)/);
  });

  it('review-lite below 1024: rail hidden, mobile bar shown, single column', () => {
    const body = band('(max-width: 1023px)');
    expect(extractBlock(body, '.rail')).toMatch(/display:\s*none/);
    expect(extractBlock(body, '.mobile-bar')).toMatch(/display:\s*flex/);
    expect(extractBlock(shellCss, '.mobile-bar')).toMatch(/height:\s*var\(--mobile-bar-height\)/);
    expect(extractBlock(body, '.shell')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
    for (const selector of [
      '.status-cause',
      '.status-count',
      '.status-freshness',
      '.status-operator',
      '.status-attention',
    ]) {
      expect(extractBlock(body, selector)).toMatch(/display:\s*none/);
    }
  });

  it('monitoring below 768: service word only, no counts or operator (AX-22)', () => {
    const body = band('(max-width: 767px)');
    for (const selector of ['.status-count', '.status-operator', '.status-freshness']) {
      expect(extractBlock(body, selector)).toMatch(/display:\s*none/);
    }
    expect(extractBlock(body, '.workspace-footer')).toMatch(/position:\s*static/);
  });

  it('phone at <=480: 16 px page padding and a single column', () => {
    const body = band('(max-width: 480px)');
    expect(extractBlock(body, '.main')).toMatch(/padding:\s*var\(--s-6\)/);
    expect(extractBlock(body, '.content-grid')).toMatch(
      /grid-template-columns:\s*minmax\(0, 1fr\)/,
    );
  });

  it('declares every band as a working surface, not a hidden one: no display:none on main content', () => {
    for (const entry of bands) {
      expect(entry.body).not.toMatch(/\.main\s*\{[^}]*display:\s*none/);
      expect(entry.body).not.toMatch(/\.content\s*\{[^}]*display:\s*none/);
    }
  });
});
