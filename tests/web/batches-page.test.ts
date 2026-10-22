import { describe, expect, it } from 'vitest';

import { batchLabel, renderBatches } from '../../src/web/render/batches.js';
import type { BatchSummary } from '../../src/web/batches/postgres.js';

const NOW = new Date('2026-10-21T20:00:00.000Z');

function batch(overrides: Partial<BatchSummary> = {}): BatchSummary {
  return {
    id: 'b1',
    ordinal: 1,
    status: 'ACTIVE',
    targetCount: 2,
    createdAt: '2026-10-21T19:59:30.000Z',
    seriesId: 's1',
    seriesName: 'The Art of Seduction',
    seriesSlug: 'the-art-of-seduction',
    videos: [
      {
        projectId: 'p1',
        position: 1,
        status: 'COMPLETE',
        currentStage: 'QC',
        videoAssetId: 'a1',
      },
      {
        projectId: 'p2',
        position: 2,
        status: 'RUNNING',
        currentStage: 'IM',
        videoAssetId: null,
      },
    ],
    ...overrides,
  };
}

describe('batches page', () => {
  it('labels a batch the way the object store does', () => {
    expect(batchLabel(1)).toBe('batch-0001');
    expect(batchLabel(12)).toBe('batch-0012');
  });

  it('shows the readable batch number, the series and per-video state', () => {
    const html = renderBatches({ batches: [batch()], now: NOW });
    expect(html).toContain('batch-0001');
    expect(html).toContain('The Art of Seduction');
    expect(html).toContain('1 of 2 videos downloadable');
    expect(html).toContain('started 30 s ago');
    expect(html).toContain('href="/series/s1"');
    // The route resolves a project id; the asset id only ever decides whether a
    // download link is shown at all.
    expect(html).toContain('href="/videos/p1/download"');
    expect(html).toContain('no file yet');
  });

  it('says nothing is running on a timer when there are no batches', () => {
    const html = renderBatches({ batches: [], now: NOW });
    expect(html).toContain('No batches yet');
    expect(html).toContain('Nothing here runs on a timer');
    expect(html).toContain('href="/series"');
  });

  it('escapes a series name rather than injecting it', () => {
    const html = renderBatches({
      batches: [batch({ seriesName: '<script>alert(1)</script>' })],
      now: NOW,
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
