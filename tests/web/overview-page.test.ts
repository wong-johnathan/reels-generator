import { describe, expect, it } from 'vitest';

import {
  HealthReportSchema,
  OverviewSchema,
  SeriesDetailSchema,
  SeriesVersionDetailSchema,
} from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { createWebApp, type WebAppDependencies } from '../../src/web/app.js';
import { MemorySessionStore } from '../../src/web/auth/session.js';
import { renderOverview } from '../../src/web/render/overview.js';
import { createMemorySeriesGateway, type SeriesGateway } from '../../src/web/series/gateway.js';
import { byTag, hasClass, parseHtml, textOf, type HtmlNode } from './helpers/html.js';

/**
 * S-02 Overview / attention inbox (UI_SPEC §6.2 W-01, UX IP-05, J-1/DI-01).
 *
 * The Milestone A form is the single-video attention view: a batchless project
 * stands on its own card, every row links straight to the tab that holds its
 * gate, and the empty state never pretends a dashboard exists.
 */

const overview = OverviewSchema.parse(FIXTURES['overview.get']);
const health = HealthReportSchema.parse(FIXTURES['health.report']);
const detail = SeriesDetailSchema.parse(FIXTURES['series.get']);
const version = SeriesVersionDetailSchema.parse(FIXTURES['series.versions.get']);
const NOW = Date.parse('2026-10-20T09:41:12.000Z');

const emptyOverview = OverviewSchema.parse({
  attention: [],
  batches: [],
  counts: { needs_attention: 0, running: 0, complete: 0 },
  degraded: [],
});

function app(overrides: Partial<WebAppDependencies> = {}) {
  const handle = createWebApp({
    sessions: new MemorySessionStore(),
    authenticate: ({ username, password }: { username: string; password: string }) =>
      username === 'operator' && password === 'preview-passphrase'
        ? { kind: 'authenticated', username }
        : { kind: 'rejected' },
    overview,
    health,
    now: () => NOW,
    ...overrides,
  });
  return { handle };
}

async function signedIn(overrides: Partial<WebAppDependencies> = {}) {
  const { handle } = app(overrides);
  const response = await handle({
    method: 'POST',
    url: '/login',
    body: 'username=operator&password=preview-passphrase',
  });
  const cookie = (response.headers['set-cookie'] ?? '').split(';')[0] ?? '';
  return {
    handle,
    get: async (path: string) => handle({ method: 'GET', url: path, headers: { cookie } }),
  };
}

const rows = (page: HtmlNode): HtmlNode[] =>
  byTag(page, 'li').filter((node) => node.attrs['data-attention-row'] !== undefined);

describe('GET / — the attention queue', () => {
  it('lists every attention item with its reason, age and a link to its gating tab', async () => {
    const { get } = await signedIn();
    const response = await get('/');
    expect(response.status).toBe(200);
    const page = parseHtml(response.body);

    const attention = rows(page);
    expect(attention).toHaveLength(overview.attention.length);
    expect(textOf(page)).toContain('Needs attention');
    expect(textOf(page)).toContain('Review next needing attention');

    const first = attention[0];
    expect(first?.attrs['data-attention-row']).toBe(overview.attention[0]?.video_id);
    // current_stage FA → the gate lives on the Render tab (IP-03, not the default tab).
    expect(first?.attrs['data-stage']).toBe('FA');
    const open = byTag(first as HtmlNode, 'a')[0];
    expect(open?.attrs['href']).toBe('/videos/' + overview.attention[0]?.video_id + '/render');
    expect(textOf(first as HtmlNode)).toContain('final approval');
    expect(textOf(first as HtmlNode)).toContain('s ago');
  });

  it('groups attention by batch and stands the batchless video on its own card', async () => {
    const { get } = await signedIn();
    const page = parseHtml((await get('/')).body);
    const cards = byTag(page, 'article').filter(
      (node) => node.attrs['data-attention-group'] !== undefined,
    );
    expect(cards.map((card) => card.attrs['data-attention-group'])).toEqual([
      'none',
      overview.batches[0]?.id,
    ]);
    expect(textOf(page)).toContain('No batch — Milestone A single video');
    expect(textOf(page)).toContain('4 of 8 complete');
  });

  it('shows the running/complete/batch counts and keeps the degraded banner', async () => {
    const { get } = await signedIn();
    const page = parseHtml((await get('/')).body);
    expect(textOf(page)).toContain('3 videos');
    expect(textOf(page)).toContain('4 videos');
    expect(textOf(page)).toContain('1 batch');
    expect(hasClass(page, 'degraded-banner') || textOf(page).includes('Service degraded')).toBe(
      true,
    );
    expect(textOf(page)).toContain('disk headroom below 20 %');
  });

  it('does not double-encode the state: the reason is text, never a second chip', async () => {
    const { get } = await signedIn();
    const page = parseHtml((await get('/')).body);
    for (const row of rows(page)) {
      expect(byTag(row, 'svg').length).toBe(0);
      expect(textOf(row).length).toBeGreaterThan(10);
    }
  });

  it('uses the first-run copy only when the series store is empty', async () => {
    const series: SeriesGateway = {
      list: async () => [],
      get: async () => null,
      create: async () => detail,
      update: async () => detail,
    };
    const firstRun = await signedIn({ overview: emptyOverview, series });
    const firstRunPage = parseHtml((await firstRun.get('/')).body);
    expect(textOf(firstRunPage)).toContain('No series yet. No batches yet.');
    expect(textOf(firstRunPage)).toContain('Create series');
    expect(byTag(firstRunPage, 'a').some((link) => link.attrs['href'] === '/series/new')).toBe(
      true,
    );

    const withSeries = await signedIn({
      overview: emptyOverview,
      series: createMemorySeriesGateway({
        detail,
        versions: [version],
        projects: [],
        inFlightBatches: 0,
      }),
    });
    const page = parseHtml((await withSeries.get('/')).body);
    expect(textOf(page)).toContain('No batches yet.');
    expect(textOf(page)).not.toContain('No series yet.');
  });
});

describe('S-02 states', () => {
  it('renders three skeleton cards while loading, with no spinner over the page', () => {
    const page = parseHtml(renderOverview({ state: 'loading', now: NOW }));
    const root = byTag(page, 'div').find((node) => node.attrs['data-overview'] !== undefined);
    expect(root?.attrs['aria-busy']).toBe('true');
    expect(byTag(page, 'article')).toHaveLength(3);
    expect(byTag(page, 'svg')).toHaveLength(0);
  });

  it('renders the whole-feed error with the last-good age and a retry', () => {
    const page = parseHtml(
      renderOverview({
        state: 'error',
        now: NOW,
        errorMessage: 'Status feed unavailable (last good 14:02 UTC). Nothing was changed.',
      }),
    );
    expect(textOf(page)).toContain('Status feed unavailable');
    expect(textOf(page)).toContain('last good 14:02 UTC');
    expect(textOf(page)).toContain('Nothing was changed.');
    expect(byTag(page, 'a').some((link) => link.attrs['href'] === '/')).toBe(true);
  });

  it('renders nothing that needs attention as a quiet line, not an empty card', () => {
    const quiet = OverviewSchema.parse({
      ...overview,
      attention: [],
      counts: { needs_attention: 0, running: 1, complete: 2 },
    });
    const page = parseHtml(renderOverview({ state: 'ready', overview: quiet, now: NOW }));
    expect(textOf(page)).toContain('Nothing needs attention right now.');
    expect(byTag(page, 'a').some((link) => link.attrs['href']?.includes('Review next'))).toBe(
      false,
    );
  });
});
