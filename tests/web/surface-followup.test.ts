import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ScriptViewSchema, SeriesDetailSchema, VideoDetailSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { renderScriptReview } from '../../src/web/render/scriptReview.js';
import { renderSeriesEditor } from '../../src/web/render/seriesEditor.js';
import { renderSeriesList } from '../../src/web/render/seriesList.js';
import { FIELDS, profileToValues } from '../../src/web/series/fields.js';
import { extractBlock, mediaBlocks } from './helpers/css.js';
import { byTag, parseHtml } from './helpers/html.js';

const css = (name: string) =>
  readFileSync(new URL(`../../src/web/styles/${name}.css`, import.meta.url), 'utf8');
const phone = (name: string) =>
  mediaBlocks(css(name))
    .filter((b) => b.query === '(max-width: 767px)')
    .map((b) => b.body)
    .join('\n');

describe('AX-17 shell target', () => {
  it('gives Open Health the 24px token floor in both dimensions', () => {
    const link = extractBlock(css('shell'), '.degraded-link');
    expect(link).toContain('display: inline-flex');
    expect(link).toContain('min-height: var(--target-min)');
    expect(link).toContain('min-width: var(--target-min)');
  });
});

describe('AX-14 series scroll region', () => {
  it('labels and exposes keyboard focus on the native table region', () => {
    const html = renderSeriesList({ state: 'loading', rows: [], now: 0 });
    const region = byTag(parseHtml(html), 'div').find(
      (n) => n.attrs['class'] === 'series-table-wrap',
    );
    expect(region?.attrs).toMatchObject({
      role: 'region',
      'aria-label': 'Series list',
      tabindex: '0',
    });
    expect(byTag(region!, 'table')).toHaveLength(1);
  });
  it('contains overflow with a focus ring and sticky scroll cue', () => {
    expect(extractBlock(css('series'), '.series-table-wrap')).toContain('position: relative');
    expect(extractBlock(css('series'), '.series-table-wrap')).toContain('overflow-x: auto');
    expect(extractBlock(css('series'), '.series-table-wrap:focus-visible')).toContain('outline:');
    const cue = extractBlock(css('series'), '.series-table-wrap::before');
    expect(cue).toContain('Scroll table horizontally when needed');
    expect(cue).toContain('position: sticky');
  });
});

describe('AX-22 server-rendered monitoring copies', () => {
  it('keeps draft script copies readonly, unnamed and separate from editable hooks', () => {
    const fixture = ScriptViewSchema.parse(FIXTURES['script.get']);
    const script = ScriptViewSchema.parse({
      ...fixture,
      claims: fixture.claims.filter((claim) => claim.status === 'sourced'),
      status: 'draft',
      approved_at: null,
    });
    const html = renderScriptReview({
      detail: VideoDetailSchema.parse(FIXTURES['video.get']),
      script,
    });
    const doc = parseHtml(html);
    const copies = [...byTag(doc, 'input'), ...byTag(doc, 'textarea')].filter(
      (n) => n.attrs['data-monitor-for'] !== undefined,
    );
    expect(copies).toHaveLength(4);
    for (const copy of copies) {
      expect(copy.attrs['readonly']).toBeDefined();
      expect(copy.attrs['name']).toBeUndefined();
      expect(copy.attrs['data-field']).toBeUndefined();
    }
    expect(html).toContain(
      'Approvals need a screen 1024 px or wider. This view is monitoring only.',
    );
    expect(html).toContain('class="script-impact-summary"');
    expect(html).toContain('id="script-approve"');
    const approve = byTag(doc, 'button').find((node) => node.attrs['id'] === 'script-approve');
    expect(approve?.attrs['disabled']).toBeUndefined();
  });
  it('renders every active series field as readonly or a selected-label text summary', () => {
    const detail = SeriesDetailSchema.parse(FIXTURES['series.get']);
    const values = { ...profileToValues(detail.profile), name: detail.name, slug: detail.slug };
    const html = renderSeriesEditor({
      mode: 'edit',
      status: 'active',
      detail,
      values,
      initial: values,
      changed: [],
      errors: {},
    });
    const doc = parseHtml(html.main);
    const copies = [...byTag(doc, 'textarea'), ...byTag(doc, 'p')].filter(
      (n) => n.attrs['data-monitor-for'] !== undefined,
    );
    expect(copies).toHaveLength(FIELDS.length);
    for (const copy of copies) {
      expect(copy.attrs['name']).toBeUndefined();
      expect(copy.attrs['data-field']).toBeUndefined();
      if (copy.tag === 'textarea') expect(copy.attrs['readonly']).toBeDefined();
    }
    expect(html.main).toContain(
      'Editing needs a screen 1024 px or wider. This view is monitoring only.',
    );
    expect(html.aside).toContain('Start batch');
  });
  it('CSS hides desktop edits and all mutation controls, not just disables them', () => {
    const script = phone('workspace');
    for (const selector of [
      '.script-field > textarea:not([readonly])',
      '.script-field > input',
      '#script-approve',
      '.script-conflict-actions',
      '.script-impact > .impact-body',
      '.script-impact > .impact-actions',
    ]) {
      expect(script).toContain(selector);
    }
    expect(
      extractBlock(
        script,
        '.script-field > textarea:not([readonly]), .script-field > input, #script-approve, .script-conflict-actions, .script-impact > .impact-body, .script-impact > .impact-actions',
      ),
    ).toContain('display: none');
    expect(
      extractBlock(script, '.script-monitor, .script-width-note, .script-impact-summary'),
    ).toContain('display: block');
    const series = phone('series');
    expect(
      extractBlock(series, '.series-form, .series-commit .series-save, .series-batch form'),
    ).toContain('display: none');
    expect(extractBlock(series, '.series-monitor, .series-width-note')).toContain('display: block');
    expect(extractBlock(css('series'), '.series-monitor, .series-width-note')).toContain(
      'display: none',
    );
  });
});
