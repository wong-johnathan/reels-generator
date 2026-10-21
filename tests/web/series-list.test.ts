import { describe, expect, it } from 'vitest';

import { SeriesSummarySchema } from '../../contract/api.js';
import { renderSeriesList } from '../../src/web/render/seriesList.js';
import type { SeriesListModel, SeriesListRow } from '../../src/web/series/model.js';
import { accessibleTextOf, byTag, hasClass, parseHtml, textOf } from './helpers/html.js';

/**
 * S-03 Series list (UX_SPEC §2.3/§6.1, UI_SPEC §5 UC-17/UC-24, §7.2, §9.2,
 * §9.3, §9.6). The screen is server-rendered: every state is HTML, including
 * the empty first run, a partial batch count, a load error and the archived
 * row that refuses new work (R-001-3).
 */

const NOW = Date.parse('2026-10-20T11:41:12.000Z');

const summary = (overrides: Record<string, unknown> = {}): SeriesListRow['summary'] =>
  SeriesSummarySchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Founders, Quietly',
    slug: 'founders-quietly',
    mode: 'creative',
    status: 'active',
    current_version: 3,
    current_version_id: '11111111-1111-4111-8111-333333333333',
    target_duration_s: 75,
    default_aspect_ratio: '9:16',
    revision: 4,
    created_at: '2026-10-20T09:00:00.000Z',
    updated_at: '2026-10-20T09:41:12.000Z',
    ...overrides,
  });

const row = (overrides: Partial<SeriesListRow> = {}): SeriesListRow => ({
  summary: summary(),
  inFlightBatches: 1,
  ...overrides,
});

const model = (overrides: Partial<SeriesListModel> = {}): SeriesListModel => ({
  state: 'ready',
  rows: [row()],
  now: NOW,
  ...overrides,
});

const page = (overrides: Partial<SeriesListModel> = {}) =>
  parseHtml(renderSeriesList(model(overrides)));

describe('series table (UI_SPEC UC-17)', () => {
  it('is a native table with a screen-reader caption and column headers', () => {
    const doc = page();
    const tables = byTag(doc, 'table');
    expect(tables).toHaveLength(1);
    const caption = byTag(doc, 'caption')[0]!;
    expect(hasClass(caption, 'sr-only')).toBe(true);
    expect(textOf(caption)).toContain('current version');

    const headers = byTag(doc, 'th');
    expect(headers.length).toBeGreaterThanOrEqual(8);
    for (const header of headers) {
      expect(header.attrs['scope']).toBe('col');
    }
    expect(headers.map((header) => textOf(header))).toEqual([
      'Series',
      'Version',
      'Mode',
      'Duration',
      'Aspect',
      'Open batches',
      'Status',
      'Updated',
      'Actions',
    ]);
  });

  it('links the row by name and repeats the action as a real link, never a clickable row', () => {
    const doc = page();
    const body = byTag(doc, 'tbody')[0]!;
    const rowNode = byTag(body, 'tr')[0]!;
    expect(rowNode.attrs['onclick']).toBeUndefined();
    const links = byTag(rowNode, 'a');
    const href = '/series/11111111-1111-4111-8111-111111111111';
    expect(links.map((link) => link.attrs['href'])).toEqual([href, href]);
    expect(textOf(links[0]!)).toBe('Founders, Quietly');
    expect(textOf(links[1]!)).toBe('Open');
  });

  it('shows the exact numbers with the version as an unpadded mono chip', () => {
    const doc = page();
    const chip = byTag(doc, 'span').find((node) => hasClass(node, 'series-version'))!;
    expect(textOf(chip)).toContain('v3');
    expect(accessibleTextOf(chip)).toBe('current version v3');
    expect(hasClass(chip, 'mono')).toBe(true);
    expect(chip.attrs['data-version']).toBe('3');
    expect(accessibleTextOf(chip)).toBe('current version v3');

    const body = textOf(byTag(doc, 'tbody')[0]!);
    expect(body).toContain('75 s');
    expect(body).toContain('9:16');
    expect(body).toContain('creative');
  });

  it('labels every cell for the card layout below 768 px (§7.2)', () => {
    const doc = page();
    const cells = byTag(byTag(byTag(doc, 'tbody')[0]!, 'tr')[0]!, 'td');
    for (const cell of cells) {
      expect(cell.attrs['data-label'], cell.attrs['class']).toBeDefined();
    }
  });
});

describe('states (UX_SPEC §6.1 S-03)', () => {
  it('renders the first-run empty state with one primary action and no table', () => {
    const doc = page({ state: 'empty', rows: [] });
    expect(byTag(doc, 'table')).toHaveLength(0);
    const text = textOf(doc);
    expect(text).toContain('No series yet.');
    const action = byTag(doc, 'a').find((node) => textOf(node) === 'Create series')!;
    expect(action.attrs['href']).toBe('/series/new');
    expect(hasClass(action, 'btn-primary')).toBe(true);
  });

  it('renders skeleton rows at the row height while the list loads (AX-28)', () => {
    const doc = page({ state: 'loading' });
    const table = byTag(doc, 'table')[0]!;
    expect(table.attrs['aria-busy']).toBe('true');
    expect(byTag(doc, 'tbody')[0]!.children.filter((node) => node.tag === 'tr')).toHaveLength(5);
    expect(textOf(byTag(doc, 'caption')[0]!)).toBe('Loading series');
  });

  it('shows a partial batch count as an em dash with a spoken explanation', () => {
    const doc = page({ rows: [row({ inFlightBatches: null })] });
    const cell = byTag(doc, 'td').find((node) => node.attrs['data-label'] === 'Open batches')!;
    expect(textOf(cell)).toContain('—');
    expect(textOf(cell)).toContain('Open batch count unavailable');
  });

  it('renders a load error with a retry and no rows', () => {
    const doc = page({ state: 'error', rows: [] });
    expect(byTag(doc, 'table')).toHaveLength(0);
    expect(textOf(doc)).toContain('The series list could not be loaded. Nothing was changed.');
    const retry = byTag(doc, 'a').find((node) => textOf(node) === 'Retry')!;
    expect(retry.attrs['href']).toBe('/series');
  });

  it('marks an archived row and states why it accepts no new batch or topic (R-001-3)', () => {
    const doc = page({
      rows: [row({ summary: summary({ status: 'archived' }) })],
    });
    const rowText = textOf(byTag(byTag(doc, 'tbody')[0]!, 'tr')[0]!);
    expect(rowText).toContain('archived');
    expect(rowText).toContain('No new batch or topic.');
  });

  it('keeps five or more rows, each with its own current version', () => {
    const rows = Array.from({ length: 6 }, (_, index) =>
      row({
        summary: summary({
          id: '11111111-1111-4111-8111-11111111111' + index,
          name: 'Series ' + (index + 1),
          current_version: 3 + index,
        }),
        inFlightBatches: index,
      }),
    );
    const doc = page({ rows });
    expect(byTag(doc, 'tbody')[0]!.children.filter((node) => node.tag === 'tr')).toHaveLength(6);
    expect(textOf(doc)).toContain('v8');
  });
});

describe('timestamps and microcopy', () => {
  it('gives the relative time an absolute accessible name (§9.6)', () => {
    const doc = page();
    const time = byTag(doc, 'time')[0]!;
    expect(time.attrs['datetime']).toBe('2026-10-20T09:41:12.000Z');
    expect(textOf(time)).toContain('2 h ago');
    expect(accessibleTextOf(time)).toContain('2026-10-20T09:41:12.000Z');
  });

  it('uses no currency, cost or publishing language (UI_SPEC §9.1 rule 6)', () => {
    const html = renderSeriesList(model()).toLowerCase();
    for (const banned of [
      'cost',
      'price',
      'publish',
      'credits remaining',
      'something went wrong',
    ]) {
      expect(html).not.toContain(banned);
    }
    expect(html).not.toContain('$');
  });

  it('carries no inline style, script or handler (CSP)', () => {
    const html = renderSeriesList(model());
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/<script/);
    expect(html).not.toContain('onclick=');
  });
});
