import { describe, expect, it } from 'vitest';

import { HealthReportSchema, OverviewSchema, SessionInfoSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { buildShellModel, renderShell, type ShellInput } from '../../src/web/render/shell.js';
import {
  accessibleTextOf,
  byId,
  byTag,
  findAll,
  hasClass,
  parseHtml,
  textOf,
  type HtmlNode,
} from './helpers/html.js';

/**
 * F-01 app shell (UI_SPEC §4.1, §5 UC-01/UC-02/UC-23, §7, §8, UX §7).
 *
 * Rendered from the frozen contract fixtures, so every assertion is about the
 * real markup a browser receives, not a hand-built string.
 */

const overview = OverviewSchema.parse(FIXTURES['overview.get']);
const health = HealthReportSchema.parse(FIXTURES['health.report']);
const session = SessionInfoSchema.parse(FIXTURES['auth.session']);

const NOW = Date.parse(health.checked_at);

function input(overrides: Partial<ShellInput> = {}): ShellInput {
  return {
    title: 'Overview',
    nav: 'overview',
    overview,
    health,
    session,
    content: '<p>Content region</p>',
    now: NOW,
    ...overrides,
  };
}

function render(overrides: Partial<ShellInput> = {}): string {
  return renderShell(buildShellModel(input(overrides)));
}

const html = render();
const doc = parseHtml(html);
const body = byTag(doc, 'body')[0] as HtmlNode;
const header = byTag(doc, 'header')[0] as HtmlNode;
const main = byId(doc, 'main') as HtmlNode;
const primaryNav = findAll(
  doc,
  (node) => node.tag === 'nav' && node.attrs['aria-label'] === 'Primary',
)[0] as HtmlNode;

describe('document scaffolding', () => {
  it('starts with a doctype and declares the language, charset and dark colour scheme', () => {
    expect(html.trimStart().toLowerCase().startsWith('<!doctype html>')).toBe(true);
    const htmlElement = byTag(doc, 'html')[0] as HtmlNode;
    expect(htmlElement.attrs['lang']).toBe('en');
    const metas = byTag(doc, 'meta').map((node) => node.attrs);
    expect(metas).toContainEqual({ charset: 'utf-8' });
    expect(metas).toContainEqual({
      name: 'viewport',
      content: 'width=device-width, initial-scale=1',
    });
    expect(metas).toContainEqual({ name: 'color-scheme', content: 'dark' });
  });

  it('links the token stylesheet and the shell enhancement module', () => {
    const stylesheet = byTag(doc, 'link')[0] as HtmlNode;
    expect(stylesheet.attrs['rel']).toBe('stylesheet');
    expect(stylesheet.attrs['href']).toBe('/assets/app.css');
    const scripts = byTag(doc, 'script');
    expect(scripts.map((node) => node.attrs['src'])).toEqual(['/assets/client/shell.js']);
    expect(scripts[0]?.attrs['type']).toBe('module');
  });

  it('sets a document title from the page title', () => {
    const title = byTag(doc, 'title')[0] as HtmlNode;
    expect(textOf(title)).toBe('Overview — reels-generator');
  });

  it('emits exactly one h1 and it is the page title (AX-02)', () => {
    const headings = byTag(doc, 'h1');
    expect(headings).toHaveLength(1);
    expect(textOf(headings[0] as HtmlNode)).toBe('Overview');
  });

  it('wraps content in one main landmark that the skip link targets', () => {
    expect(byTag(doc, 'main')).toHaveLength(1);
    expect(main.attrs['tabindex']).toBe('-1');
    const skip = findAll(body, (node) => hasClass(node, 'skip-link'))[0] as HtmlNode;
    expect(skip.tag).toBe('a');
    expect(skip.attrs['href']).toBe('#main');
    expect(textOf(skip)).toBe('Skip to content');
  });

  it('is the very first focusable element after the opening body tag (AX-01)', () => {
    const firstElement = body.children.find((node) => node.type === 'element') as HtmlNode;
    expect(firstElement.tag).toBe('a');
    expect(hasClass(firstElement, 'skip-link')).toBe(true);
  });

  it('has no horizontal page scroll container and no inline style attributes', () => {
    expect(html).not.toMatch(/style="/);
    expect(html).not.toContain('<style');
  });
});

describe('global status strip (UC-01, UC-23, IP-07)', () => {
  it('is the banner landmark above the rail and main', () => {
    expect(byTag(doc, 'header')).toHaveLength(1);
    expect(header.attrs['data-state']).toBe('degraded');
    const children = body.children.filter((node) => node.type === 'element');
    expect(children.indexOf(header)).toBe(1); // skip link, then header
  });

  it('names the service state in words, not colour alone (AX-13)', () => {
    const word = findAll(header, (node) => hasClass(node, 'status-word'))[0] as HtmlNode;
    expect(textOf(word)).toBe('DEGRADED');
    const dot = findAll(header, (node) => hasClass(node, 'status-dot'))[0] as HtmlNode;
    expect(dot.attrs['aria-hidden']).toBe('true');
  });

  it('links the degraded cause to Health and keeps the cause visible', () => {
    const cause = findAll(header, (node) => hasClass(node, 'status-cause'))[0] as HtmlNode;
    expect(cause.attrs['href']).toBe('/health');
    expect(textOf(cause)).toContain('disk headroom below 20 %');
  });

  it('shows the exact in-flight count, the attention count and the operator id', () => {
    expect(textOf(findAll(header, (node) => hasClass(node, 'status-count'))[0] as HtmlNode)).toBe(
      '3 in flight',
    );
    const attention = findAll(header, (node) => hasClass(node, 'status-attention'))[0] as HtmlNode;
    expect(attention.attrs['data-attention-count']).toBe('2');
    expect(textOf(attention)).toBe('2 need attention');
    expect(
      textOf(findAll(header, (node) => hasClass(node, 'status-operator'))[0] as HtmlNode),
    ).toBe('operator');
  });

  it('renders the attention count in the strip only on Overview (UC-01)', () => {
    const scriptPage = parseHtml(render({ nav: null, title: 'Script' }));
    const strip = byTag(scriptPage, 'header')[0] as HtmlNode;
    expect(findAll(strip, (node) => hasClass(node, 'status-attention'))).toHaveLength(0);
  });

  it.each([
    [
      'ready',
      {
        health: { ...health, ready: true, degraded_reasons: [] },
        overview: { ...overview, degraded: [] },
      },
      'Service ready',
    ],
    ['degraded', {}, 'DEGRADED'],
    [
      'not-ready',
      { health: { ...health, ready: false, degraded_reasons: ['postgres unreachable'] } },
      'Service not ready',
    ],
  ])('renders the %s state with its word and data-state', (state, overrides, word) => {
    const page = parseHtml(render(overrides as Partial<ShellInput>));
    const strip = byTag(page, 'header')[0] as HtmlNode;
    expect(strip.attrs['data-state']).toBe(state);
    expect(textOf(findAll(strip, (node) => hasClass(node, 'status-word'))[0] as HtmlNode)).toBe(
      word,
    );
  });

  it('labels feed freshness and switches to the stalled wording past 20 s (AX-27)', () => {
    const fresh = parseHtml(render());
    const freshText = textOf(
      findAll(byTag(fresh, 'header')[0] as HtmlNode, (node) =>
        hasClass(node, 'status-freshness'),
      )[0] as HtmlNode,
    );
    expect(freshText).toBe('last update 0 s ago');

    const stalled = parseHtml(render({ now: NOW + 22_000 }));
    const stalledNode = findAll(byTag(stalled, 'header')[0] as HtmlNode, (node) =>
      hasClass(node, 'status-freshness'),
    )[0] as HtmlNode;
    expect(textOf(stalledNode)).toBe('progress feed delayed — last update 22 s ago');
    expect(stalledNode.attrs['data-stale']).toBe('true');
  });
});

describe('left rail (UC-01, UX §2.2)', () => {
  it('is the single Primary navigation landmark with the five destinations and Settings last', () => {
    expect(primaryNav).toBeDefined();
    const links = byTag(primaryNav, 'a');
    expect(links.map((link) => accessibleTextOf(link))).toEqual([
      'Overview 2 videos need attention',
      'Series',
      'Batches',
      'Posting',
      'Health',
      'Settings',
    ]);
    expect(links.map((link) => link.attrs['href'])).toEqual([
      '/',
      '/series',
      '/batches',
      '/posting',
      '/health',
      '/settings',
    ]);
  });

  it('marks the active destination with aria-current="page" and only that one', () => {
    const current = findAll(primaryNav, (node) => node.attrs['aria-current'] === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]?.attrs['href']).toBe('/');
  });

  it('carries the attention badge on the Overview item only, as a count with a name (J-1)', () => {
    const seriesPage = parseHtml(render({ nav: 'series', title: 'Series' }));
    const seriesNav = findAll(
      seriesPage,
      (node) => node.tag === 'nav' && node.attrs['aria-label'] === 'Primary',
    )[0] as HtmlNode;
    const links = byTag(seriesNav, 'a');
    const badges = findAll(links[0] as HtmlNode, (node) => hasClass(node, 'rail-badge'));
    expect(badges).toHaveLength(1);
    expect(textOf(badges[0] as HtmlNode)).toBe('2');
    expect(badges[0]?.attrs['aria-hidden']).toBe('true');
    expect(accessibleTextOf(links[0] as HtmlNode)).toBe('Overview 2 videos need attention');
    for (const link of links.slice(1)) {
      expect(findAll(link, (node) => hasClass(node, 'rail-badge'))).toHaveLength(0);
    }
  });

  it('keeps a visible 3-letter form and a title for the compact band (1024–1439)', () => {
    for (const link of byTag(primaryNav, 'a')) {
      expect(link.attrs['data-short']).toMatch(/^[A-Z]{3}$/);
      expect(link.attrs['title']).toBeDefined();
      const glyph = findAll(link, (node) => hasClass(node, 'rail-glyph'))[0] as HtmlNode;
      expect(glyph.attrs['aria-hidden']).toBe('true');
      expect(textOf(glyph)).toBe(link.attrs['data-short']);
    }
  });

  it('renders Settings in its own bottom group, not among the destinations', () => {
    const settings = byTag(primaryNav, 'a')[5] as HtmlNode;
    const item = findAll(
      primaryNav,
      (node) => node.tag === 'li' && node.children.includes(settings),
    )[0];
    expect(item).toBeDefined();
    expect(hasClass(item as HtmlNode, 'rail-settings')).toBe(true);
  });
});

describe('breadcrumb and mobile bar (UC-02, §7.2)', () => {
  it('renders an ordered breadcrumb in a labelled nav with the current item unlinked (AX-02)', () => {
    const page = parseHtml(
      render({
        title: 'Script',
        nav: null,
        breadcrumbs: [
          { label: 'Overview', href: '/' },
          { label: 'Quiet Mind', href: '/series/11111111-1111-4111-8111-111111111111' },
          { label: 'Video 7 of 30' },
        ],
      }),
    );
    const crumb = findAll(
      page,
      (node) => node.tag === 'nav' && node.attrs['aria-label'] === 'Breadcrumb',
    )[0] as HtmlNode;
    const items = byTag(crumb, 'li');
    expect(items).toHaveLength(3);
    expect(byTag(crumb, 'ol')).toHaveLength(1);
    expect(textOf(items[0] as HtmlNode)).toBe('Overview');
    expect(byTag(items[0] as HtmlNode, 'a')[0]?.attrs['href']).toBe('/');
    const last = items[2] as HtmlNode;
    expect(byTag(last, 'a')).toHaveLength(0);
    expect(textOf(last)).toBe('Video 7 of 30');
    expect(findAll(last, (node) => node.attrs['aria-current'] === 'page')).toHaveLength(1);
  });

  it('offers a back link and the attention count in the sub-1024 top bar', () => {
    const page = parseHtml(
      render({
        title: 'Script',
        nav: null,
        breadcrumbs: [{ label: 'Overview', href: '/' }, { label: 'Script' }],
      }),
    );
    const bar = findAll(page, (node) => hasClass(node, 'mobile-bar'))[0] as HtmlNode;
    const back = findAll(bar, (node) => hasClass(node, 'mobile-back'))[0] as HtmlNode;
    expect(back.attrs['href']).toBe('/');
    expect(textOf(back)).toContain('Overview');
    expect(textOf(findAll(bar, (node) => hasClass(node, 'mobile-attention'))[0] as HtmlNode)).toBe(
      'Attention (2)',
    );
  });

  it('omits the back link at the root of the breadcrumb', () => {
    const bar = findAll(doc, (node) => hasClass(node, 'mobile-bar'))[0] as HtmlNode;
    expect(findAll(bar, (node) => hasClass(node, 'mobile-back'))).toHaveLength(0);
    expect(textOf(findAll(bar, (node) => hasClass(node, 'mobile-home'))[0] as HtmlNode)).toBe(
      'reels-generator',
    );
  });
});

describe('degraded banner (UC-23, IP-07, AX-25)', () => {
  const banner = findAll(main, (node) => hasClass(node, 'degraded-banner'))[0] as HtmlNode;

  it('is labelled by its heading and is not dismissible', () => {
    expect(banner).toBeDefined();
    const heading = byId(banner, banner.attrs['aria-labelledby'] ?? '');
    expect(heading).toBeDefined();
    expect(textOf(heading as HtmlNode)).toBe('Service degraded');
    expect(banner).not.toHaveProperty('data-dismissible');
    expect(findAll(banner, (node) => node.tag === 'button')).toHaveLength(0);
  });

  it('names the cause, what is blocked, what still works and the next action (IP-07 rule)', () => {
    const terms = byTag(banner, 'dt').map((node) => textOf(node));
    expect(terms).toEqual(['Cause', 'Blocked', 'Still works', 'System']);
    expect(textOf(banner)).toContain('disk');
    const link = findAll(banner, (node) => node.tag === 'a')[0] as HtmlNode;
    expect(link.attrs['href']).toBe('/health');
    expect(textOf(link)).toBe('Open Health');
  });

  it('lists further conditions instead of stacking banners', () => {
    const page = parseHtml(
      render({
        overview: { ...overview, degraded: ['disk headroom below 20 %', 'redis reconnecting'] },
        health: { ...health, ready: false, degraded_reasons: ['redis unreachable'] },
      }),
    );
    expect(findAll(page, (node) => hasClass(node, 'degraded-banner'))).toHaveLength(1);
    expect(
      textOf(findAll(page, (node) => hasClass(node, 'degraded-more'))[0] as HtmlNode),
    ).toContain('+1 more');
  });

  it('is absent when nothing is degraded', () => {
    const page = parseHtml(
      render({ overview: { ...overview, degraded: [] }, health: { ...health, ready: true } }),
    );
    expect(findAll(page, (node) => hasClass(node, 'degraded-banner'))).toHaveLength(0);
  });
});

describe('layout slots (UI_SPEC §4.1)', () => {
  it('renders the optional aside as a labelled complementary column', () => {
    const page = parseHtml(render({ aside: { label: 'Change impact', content: '<p>impact</p>' } }));
    const aside = byTag(page, 'aside')[0] as HtmlNode;
    expect(aside.attrs['aria-label']).toBe('Change impact');
    expect(textOf(aside)).toContain('impact');
    const grid = findAll(page, (node) => hasClass(node, 'content-grid'))[0] as HtmlNode;
    expect(hasClass(grid, 'has-aside')).toBe(true);
  });

  it('omits the aside and the has-aside modifier when there is no aside', () => {
    expect(byTag(doc, 'aside')).toHaveLength(0);
    const grid = findAll(doc, (node) => hasClass(node, 'content-grid'))[0] as HtmlNode;
    expect(hasClass(grid, 'has-aside')).toBe(false);
  });

  it('renders the sticky workspace footer only when a workspace supplies it', () => {
    const page = parseHtml(render({ footer: '<span>pins: T v13</span>' }));
    const footer = byTag(page, 'footer')[0] as HtmlNode;
    expect(hasClass(footer, 'workspace-footer')).toBe(true);
    expect(textOf(footer)).toContain('pins: T v13');
    expect(byTag(doc, 'footer')).toHaveLength(0);
  });
});

describe('live regions (AX-08, AX-10, AX-27)', () => {
  it('ends the body with an empty polite and an empty assertive region', () => {
    const regions = byTag(body, 'div').filter(
      (node) => node.attrs['id'] === 'live-status' || node.attrs['id'] === 'live-alert',
    );
    expect(regions.map((node) => node.attrs['id'])).toEqual(['live-status', 'live-alert']);
    const polite = byId(doc, 'live-status') as HtmlNode;
    expect(polite.attrs['aria-live']).toBe('polite');
    expect(polite.attrs['aria-atomic']).toBe('true');
    expect(textOf(polite)).toBe('');
    const assertive = byId(doc, 'live-alert') as HtmlNode;
    expect(assertive.attrs['aria-live']).toBe('assertive');
    expect(assertive.attrs['aria-atomic']).toBe('true');
    expect(textOf(assertive)).toBe('');
  });

  it('keeps both regions last in the body so they are announced after the content', () => {
    const children = body.children.filter((node) => node.type === 'element');
    expect(children[children.length - 2]?.attrs['id']).toBe('live-status');
    expect(children[children.length - 1]?.attrs['id']).toBe('live-alert');
  });
});

describe('copy and escaping (UI_SPEC §9.1, AX-19, AX-20)', () => {
  it('escapes every interpolated string', () => {
    const page = parseHtml(
      render({
        title: '<img src=x onerror=alert(1)>',
        breadcrumbs: [{ label: 'Overview', href: '/?a=1&b=2' }, { label: '<b>Script</b>' }],
        session: { ...session, username: 'op" onmouseover="alert(1)' },
      }),
    );
    expect(byTag(page, 'img')).toHaveLength(0);
    expect(byTag(page, 'b')).toHaveLength(0);
    const title = byTag(page, 'h1')[0] as HtmlNode;
    expect(textOf(title)).toBe('<img src=x onerror=alert(1)>');
    const crumbLink = byTag(page, 'a').find((node) =>
      (node.attrs['href'] ?? '').startsWith('/?a='),
    ) as HtmlNode;
    expect(crumbLink.attrs['href']).toBe('/?a=1&b=2');
    const operator = findAll(page, (node) => hasClass(node, 'status-operator'))[0] as HtmlNode;
    expect(textOf(operator)).toBe('op" onmouseover="alert(1)');
  });

  it('uses no banned product strings (UI_SPEC §9.1 rule 6) and no currency', () => {
    const banned = [
      'Something went wrong',
      'Oops',
      'An error occurred',
      'Please try again later',
      'Are you sure?',
      'Invalid input',
      'credits',
      'upgrade',
      'publish',
      'approximately',
      'several',
      'cost',
      'price',
      'USD',
    ];
    for (const phrase of banned) expect(html.toLowerCase()).not.toContain(phrase.toLowerCase());
    expect(html).not.toContain('$');
  });

  it('uses one wording per state word (AX-20)', () => {
    expect(html).toContain('DEGRADED');
    expect(html).not.toMatch(/\boutdated\b/);
    expect(html).not.toMatch(/\bneeds refresh\b/);
  });
});
