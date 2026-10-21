import { describe, expect, it } from 'vitest';

import { NOT_FOUND_COPY, renderNotFoundPage } from '../../src/web/render/notFound.js';
import { byId, byTag, parseHtml, textOf } from './helpers/html.js';

/**
 * SY-3 Not found / no access — a system surface (UX §2.1), not in navigation.
 *
 * Neither UX_SPEC nor UI_SPEC authors copy or a mockup for SY-3, so the copy
 * below is design judgement in the product's voice: no dead end, nothing
 * claimed about data, one action back into the app.
 */

describe('SY-3 not found', () => {
  it('is a dark HTML document with a single h1 and a 404 code line', () => {
    const html = renderNotFoundPage({ variant: 'not_found' });
    expect(html.trimStart().toLowerCase().startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    const doc = parseHtml(html);
    expect(byTag(doc, 'h1')).toHaveLength(1);
    expect(textOf(byTag(doc, 'h1')[0]!)).toBe('Page not found');
    const code = byTag(doc, 'p').find((node) => node.attrs['class']?.includes('system-code'))!;
    expect(textOf(code)).toBe('404');
    expect(textOf(byTag(doc, 'title')[0]!)).toBe('Page not found — reels-generator');
  });

  it('says what happened and offers one way back into the app', () => {
    const doc = parseHtml(renderNotFoundPage({ variant: 'not_found' }));
    expect(textOf(doc)).toContain('That address does not exist in this app. Nothing was changed.');
    const anchors = byTag(doc, 'a');
    const action = anchors.find((node) => node.attrs['class']?.includes('system-action'))!;
    expect(textOf(action)).toBe('Go to Overview');
    expect(action.attrs['href']).toBe('/');
    expect(anchors[0]?.attrs['class']).toBe('skip-link');
  });

  it('keeps the no-access variant honest about the single seeded account', () => {
    const doc = parseHtml(renderNotFoundPage({ variant: 'no_access' }));
    expect(textOf(byTag(doc, 'h1')[0]!)).toBe('No access');
    expect(textOf(doc)).toContain('You do not have access to that page.');
    expect(textOf(doc)).toContain('Access is by the seeded operator account only.');
    expect(textOf(byTag(doc, 'p').find((n) => n.attrs['class']?.includes('system-code'))!)).toBe(
      '403',
    );
  });

  it('is a system surface: no rail, no status strip, no navigation', () => {
    const doc = parseHtml(renderNotFoundPage({ variant: 'not_found' }));
    expect(byTag(doc, 'nav')).toHaveLength(0);
    expect(byTag(doc, 'header')).toHaveLength(0);
    expect(byId(doc, 'main')?.tag).toBe('main');
  });

  it('ships no inline style or script and loads only the app stylesheet', () => {
    const html = renderNotFoundPage({ variant: 'not_found' });
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toContain('<script');
    expect(byTag(parseHtml(html), 'link').map((node) => node.attrs['href'])).toEqual([
      '/assets/app.css',
    ]);
  });

  it('uses the exact authored copy constants', () => {
    expect(NOT_FOUND_COPY.not_found.title).toBe('Page not found');
    expect(NOT_FOUND_COPY.not_found.body).toBe(
      'That address does not exist in this app. Nothing was changed.',
    );
    expect(NOT_FOUND_COPY.no_access.title).toBe('No access');
    expect(NOT_FOUND_COPY.no_access.body).toBe('You do not have access to that page.');
  });
});
