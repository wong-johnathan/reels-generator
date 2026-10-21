import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { contrast, customProperties, extractBlock, mediaBlocks } from './helpers/css.js';

/**
 * The token ledger (UI_SPEC §2, AX-12, AX-16, AX-18).
 *
 * These tests read the shipped stylesheet, not a copy of it: if a hex value
 * drifts from the specification, or a contrast pair falls below its declared
 * threshold, the build fails.
 */

const css = readFileSync(new URL('../../src/web/styles/tokens.css', import.meta.url), 'utf8');
const root = customProperties(extractBlock(css, ':root'));

const COLOURS: Record<string, string> = {
  'surface-app': '#0E1014',
  'surface-panel': '#15181E',
  'surface-raised': '#1C2027',
  'surface-inset': '#0A0C10',
  'surface-hover': '#22272F',
  'surface-selected': '#263041',
  'surface-inverse': '#E8EBF0',
  'surface-stale-tint': '#2A2340',
  'surface-danger-tint': '#33201F',
  'surface-warning-tint': '#302614',
  'surface-success-tint': '#13251A',
  'text-primary': '#E8EBF0',
  'text-secondary': '#AEB7C4',
  'text-tertiary': '#8B95A3',
  'text-disabled': '#5F6875',
  'text-link': '#9DBBF9',
  'text-inverse': '#0B0D11',
  accent: '#7EA6F8',
  success: '#4CC26A',
  warning: '#E3A639',
  danger: '#FF7B72',
  stale: '#BBA1FF',
  running: '#4FD1E0',
  cancelled: '#8B95A3',
  'border-subtle': '#272D37',
  'border-default': '#6B7480',
  'border-strong': '#8B95A3',
  'accent-fill': '#2F5FD0',
  'accent-fill-hover': '#3A6CE0',
  'danger-fill': '#C62828',
  'danger-fill-hover': '#D13A2A',
  'control-fill': '#22272F',
  'focus-ring-color': '#7EA6F8',
};

describe('tokens.css — colour ledger (UI_SPEC §2.1)', () => {
  it.each(Object.entries(COLOURS))('declares --%s as %s', (name, hex) => {
    // The formatter lower-cases hex literals; the value is what the spec fixes.
    expect(root[name]?.toUpperCase()).toBe(hex.toUpperCase());
  });

  it('declares exactly the surfaces, tints, text, state and border tokens — no extra colour', () => {
    const colourProperties = Object.keys(root).filter((name) =>
      /^#[0-9A-Fa-f]{6}$/.test(root[name] ?? ''),
    );
    expect(colourProperties.sort()).toEqual(Object.keys(COLOURS).sort());
  });
});

describe('tokens.css — AX-12 measured contrast', () => {
  // Every pair quotes UI_SPEC §8.2's measured ratio; the test recomputes it
  // independently and also checks the WCAG threshold for the pair.
  const pairs: Array<[string, string, string, number, number]> = [
    // [foreground, background, label, threshold, measured-in-spec]
    ['text-primary', 'surface-app', 'body on app', 4.5, 15.93],
    ['text-primary', 'surface-panel', 'body on panel', 4.5, 14.88],
    ['text-primary', 'surface-raised', 'body on raised', 4.5, 13.67],
    ['text-primary', 'surface-hover', 'body on hover', 4.5, 12.56],
    ['text-primary', 'surface-selected', 'body on selected', 4.5, 11.11],
    ['text-secondary', 'surface-panel', 'secondary body', 4.5, 8.78],
    ['text-tertiary', 'surface-panel', 'metadata 12px', 4.5, 5.86],
    ['text-tertiary', 'surface-raised', 'metadata on raised', 4.5, 5.39],
    ['text-link', 'surface-panel', 'inline link', 4.5, 9.24],
    ['accent', 'surface-panel', 'state text accent', 4.5, 7.36],
    ['success', 'surface-panel', 'state text success', 4.5, 7.82],
    ['warning', 'surface-panel', 'state text warning', 4.5, 8.28],
    ['danger', 'surface-panel', 'state text danger', 4.5, 7.05],
    ['stale', 'surface-panel', 'state text stale', 4.5, 8.17],
    ['running', 'surface-panel', 'state text running', 4.5, 9.76],
    ['cancelled', 'surface-panel', 'state text cancelled', 4.5, 5.86],
    ['border-default', 'surface-panel', 'control boundary', 3.0, 3.75],
    ['border-default', 'surface-app', 'control boundary on app', 3.0, 4.02],
    ['border-strong', 'surface-panel', 'hover boundary', 3.0, 5.86],
    ['text-primary', 'control-fill', 'secondary button label', 4.5, 12.56],
    ['text-primary', 'surface-stale-tint', 'text on stale tint', 4.5, 12.44],
    ['text-primary', 'surface-danger-tint', 'text on danger tint', 4.5, 12.85],
    ['text-primary', 'surface-warning-tint', 'text on warning tint', 4.5, 12.44],
    ['accent', 'surface-selected', 'focus ring on selected row', 3.0, 5.5],
  ];

  it.each(pairs)('%s on %s (%s)', (foreground, background, _label, threshold, measured) => {
    const fg = COLOURS[foreground];
    const bg = COLOURS[background];
    expect(fg).toBeDefined();
    expect(bg).toBeDefined();
    const ratio = contrast(fg as string, bg as string);
    expect(ratio).toBeGreaterThanOrEqual(threshold);
    expect(ratio).toBeCloseTo(measured, 1);
  });

  it('keeps #FFFFFF at 4.5:1 on both filled button backgrounds (AX-12)', () => {
    expect(contrast('#FFFFFF', COLOURS['accent-fill'] as string)).toBeCloseTo(5.72, 1);
    expect(contrast('#FFFFFF', COLOURS['accent-fill-hover'] as string)).toBeCloseTo(4.77, 1);
    expect(contrast('#FFFFFF', COLOURS['danger-fill'] as string)).toBeCloseTo(5.62, 1);
    expect(contrast('#FFFFFF', COLOURS['danger-fill-hover'] as string)).toBeCloseTo(4.83, 1);
  });
});

describe('tokens.css — type, spacing, radii, elevation and z-index (UI_SPEC §2.2–§2.6, §4.1)', () => {
  it.each([
    ['t-80', '32px'],
    ['t-70', '24px'],
    ['t-60', '20px'],
    ['t-50', '16px'],
    ['t-40', '14px'],
    ['t-30', '13px'],
    ['t-20', '12px'],
    ['t-10', '11px'],
    ['lh-80', '40px'],
    ['lh-70', '32px'],
    ['lh-60', '28px'],
    ['lh-50', '24px'],
    ['lh-40', '22px'],
    ['lh-30', '20px'],
    ['lh-20', '18px'],
    ['lh-10', '16px'],
  ])('declares --%s: %s', (name, value) => {
    expect(root[name]).toBe(value);
  });

  it('declares only the three permitted weights (400, 600, 700)', () => {
    expect(root['fw-regular']).toBe('400');
    expect(root['fw-semibold']).toBe('600');
    expect(root['fw-bold']).toBe('700');
    const weights = Object.keys(root).filter((name) => name.startsWith('fw-'));
    expect(weights.sort()).toEqual(['fw-bold', 'fw-regular', 'fw-semibold']);
  });

  it('declares the 4 px spacing scale with no arbitrary steps', () => {
    const expected: Record<string, string> = {
      's-0': '0',
      's-1': '2px',
      's-2': '4px',
      's-3': '6px',
      's-4': '8px',
      's-5': '12px',
      's-6': '16px',
      's-7': '20px',
      's-8': '24px',
      's-9': '32px',
      's-10': '40px',
      's-11': '48px',
      's-12': '64px',
    };
    for (const [name, value] of Object.entries(expected)) expect(root[name]).toBe(value);
  });

  it('declares the radii, elevation and z-index scales', () => {
    expect(root['r-1']).toBe('2px');
    expect(root['r-2']).toBe('4px');
    expect(root['r-3']).toBe('6px');
    expect(root['r-4']).toBe('10px');
    expect(root['r-full']).toBe('999px');
    expect(root['e-1']).toBe('0 1px 2px rgba(0, 0, 0, 0.45)');
    expect(root['e-2']).toBe('0 4px 12px rgba(0, 0, 0, 0.5)');
    expect(root['e-3']).toBe('0 12px 32px rgba(0, 0, 0, 0.62)');
    expect(root['z-content']).toBe('0');
    expect(root['z-sticky-head']).toBe('10');
    expect(root['z-banner']).toBe('20');
    expect(root['z-dropdown']).toBe('30');
    expect(root['z-dialog']).toBe('40');
    expect(root['z-toast']).toBe('50');
  });
});

describe('tokens.css — motion (UI_SPEC §2.7, AX-16)', () => {
  it('declares the four durations with their easings', () => {
    expect(root['dur-1']).toBe('80ms');
    expect(root['dur-2']).toBe('140ms');
    expect(root['dur-3']).toBe('220ms');
    expect(root['dur-4']).toBe('320ms');
    expect(root['spin-duration']).toBe('1.2s');
    expect(root['progress-duration']).toBe('700ms');
    expect(root['ease-standard']).toBe('cubic-bezier(0.2, 0, 0, 1)');
    expect(root['ease-enter']).toBe('cubic-bezier(0, 0, 0, 1)');
    expect(root['ease-exit']).toBe('cubic-bezier(0.4, 0, 1, 1)');
  });

  it('collapses every duration to 0.01ms under prefers-reduced-motion: reduce', () => {
    const reduced = mediaBlocks(css).find((block) =>
      block.query.includes('prefers-reduced-motion: reduce'),
    );
    expect(reduced).toBeDefined();
    const props = customProperties(reduced?.body ?? '');
    for (const name of ['dur-1', 'dur-2', 'dur-3', 'dur-4']) {
      expect(props[name]).toBe('0.01ms');
    }
  });

  it('ships no webfont and no external asset reference (the NAS serves no font files)', () => {
    expect(css).not.toMatch(/@font-face/);
    expect(css).not.toMatch(/@import/);
    expect(css).not.toMatch(/https?:\/\//);
  });
});

describe('tokens.css — focus and target sizes (UI_SPEC §2.8, AX-17, AX-18)', () => {
  it('declares the outline-based focus ring tokens', () => {
    expect(root['focus-ring-width']).toBe('2px');
    expect(root['focus-ring-color']?.toUpperCase()).toBe('#7EA6F8');
    expect(root['focus-ring-offset']).toBe('2px');
    expect(root['focus-ring-style']).toBe('solid');
  });

  it('declares the 24 px minimum and the 44 px review-control targets', () => {
    expect(root['target-min']).toBe('24px');
    expect(root['target-review']).toBe('44px');
    expect(root['target-gap']).toBe('8px');
  });

  it('declares the shell layout constants from UI_SPEC §4.1', () => {
    expect(root['rail-expanded']).toBe('216px');
    expect(root['rail-compact']).toBe('64px');
    expect(root['aside-wide']).toBe('360px');
    expect(root['aside-compact']).toBe('320px');
    expect(root['content-max']).toBe('1600px');
    expect(root['strip-height']).toBe('40px');
    expect(root['footer-height']).toBe('32px');
    expect(root['mobile-bar-height']).toBe('44px');
  });

  it('declares dark as the only colour scheme', () => {
    expect(extractBlock(css, ':root')).toMatch(/color-scheme:\s*dark/);
  });
});
