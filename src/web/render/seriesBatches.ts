/**
 * S-05 — Batches index (nav key `batches`).
 *
 * `/batches` is now an alphabetical series index rather than a flat batch list:
 * each entry names one series, counts its batches and summarises their state and
 * video progress, and links to `/series/:seriesId/batch` — the page that lists
 * only that series' batches. The per-series list still reuses `renderBatches`,
 * so the existing batch cards and links are unchanged.
 *
 * Server-rendered and complete without scripting: the only interactive elements
 * are links.
 */
import { describeAge } from '../format.js';
import type { SeriesBatchIndexEntry } from '../batches/postgres.js';
import { escapeAttr, escapeHtml } from './html.js';

export interface BatchSeriesIndexInput {
  readonly series: readonly SeriesBatchIndexEntry[];
  readonly now: Date;
}

/** `2 active · 1 complete` — only the non-zero states are named. */
function statusSummary(entry: SeriesBatchIndexEntry): string {
  const parts: string[] = [];
  if (entry.activeBatches > 0) parts.push(entry.activeBatches + ' active');
  if (entry.completeBatches > 0) parts.push(entry.completeBatches + ' complete');
  if (entry.cancelledBatches > 0) parts.push(entry.cancelledBatches + ' cancelled');
  return parts.join(' · ');
}

function seriesEntry(entry: SeriesBatchIndexEntry, now: Date): string {
  const href = '/series/' + escapeAttr(entry.seriesId) + '/batch';
  const summary = statusSummary(entry);

  const pieces: string[] = [entry.batchCount + (entry.batchCount === 1 ? ' batch' : ' batches')];
  if (summary.length > 0) pieces.push(summary);
  if (entry.videoCount > 0) {
    pieces.push(entry.downloadableCount + ' of ' + entry.videoCount + ' videos downloadable');
  }
  if (entry.newestBatchAt !== null) {
    pieces.push('newest ' + describeAge(now.getTime(), entry.newestBatchAt).text);
  }

  return (
    '<li class="batch-series-entry">' +
    '<div class="batch-series-head">' +
    '<a class="batch-series-name" href="' +
    href +
    '">' +
    escapeHtml(entry.seriesName) +
    '</a>' +
    '<a class="btn btn-small batch-series-open" href="' +
    href +
    '">View batches</a>' +
    '</div>' +
    '<p class="batch-series-meta mono">' +
    escapeHtml(pieces.join(' · ')) +
    '</p>' +
    '</li>'
  );
}

export function renderBatchSeriesIndex(input: BatchSeriesIndexInput): string {
  if (input.series.length === 0) {
    return (
      '<div class="empty" data-state="empty">' +
      '<h2>No series yet</h2>' +
      '<p>Batches belong to series — create a series, then start a batch from its page. ' +
      'Nothing here runs on a timer.</p>' +
      '<p><a class="btn" href="/series/new">Create series</a></p>' +
      '</div>'
    );
  }

  const list = input.series.map((entry) => seriesEntry(entry, input.now)).join('');

  return (
    '<section class="batch-series-index" aria-label="Series batches">' +
    '<p class="batch-series-lead">' +
    input.series.length +
    ' series, alphabetical. Open one to see its batches.</p>' +
    '<ul class="batch-series-list">' +
    list +
    '</ul>' +
    '</section>'
  );
}
