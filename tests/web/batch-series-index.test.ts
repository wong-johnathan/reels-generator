import { describe, expect, it } from 'vitest';

import type { SeriesBatchIndexEntry } from '../../src/web/batches/postgres.js';
import { renderBatchSeriesIndex } from '../../src/web/render/seriesBatches.js';

const NOW = new Date('2026-10-21T20:00:00.000Z');

function entry(overrides: Partial<SeriesBatchIndexEntry> = {}): SeriesBatchIndexEntry {
  return {
    seriesId: 's1',
    seriesName: 'The Art of Seduction',
    seriesSlug: 'the-art-of-seduction',
    batchCount: 2,
    activeBatches: 1,
    completeBatches: 1,
    cancelledBatches: 0,
    videoCount: 4,
    downloadableCount: 3,
    newestBatchAt: '2026-10-21T19:59:30.000Z',
    ...overrides,
  };
}

describe('batches series index (S-05)', () => {
  it('links each series to its own batch page and summarises counts and progress', () => {
    const html = renderBatchSeriesIndex({ series: [entry()], now: NOW });
    expect(html).toContain('href="/series/s1/batch"');
    expect(html).toContain('The Art of Seduction');
    expect(html).toContain('2 batches');
    expect(html).toContain('1 active · 1 complete');
    expect(html).toContain('3 of 4 videos downloadable');
    expect(html).toContain('newest 30 s ago');
  });

  it('omits zero states and progress when nothing has run', () => {
    const html = renderBatchSeriesIndex({
      series: [
        entry({
          batchCount: 0,
          activeBatches: 0,
          completeBatches: 0,
          cancelledBatches: 0,
          videoCount: 0,
          downloadableCount: 0,
          newestBatchAt: null,
        }),
      ],
      now: NOW,
    });
    expect(html).toContain('0 batches');
    expect(html).not.toContain('active');
    expect(html).not.toContain('complete');
    expect(html).not.toContain('downloadable');
    expect(html).not.toContain('newest');
  });

  it('renders the empty state and points at series creation', () => {
    const html = renderBatchSeriesIndex({ series: [], now: NOW });
    expect(html).toContain('No series yet');
    expect(html).toContain('href="/series/new"');
    expect(html).toContain('Nothing here runs on a timer');
  });

  it('escapes a series name rather than injecting its markup', () => {
    const html = renderBatchSeriesIndex({
      series: [entry({ seriesName: '<script>alert(1)</script>' })],
      now: NOW,
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders entries in the order supplied (the read model owns the sort)', () => {
    const html = renderBatchSeriesIndex({
      series: [
        entry({ seriesName: 'Zulu', seriesId: 'z' }),
        entry({ seriesName: 'Alpha', seriesId: 'a' }),
      ],
      now: NOW,
    });
    expect(html.indexOf('Zulu')).toBeLessThan(html.indexOf('Alpha'));
  });
});
