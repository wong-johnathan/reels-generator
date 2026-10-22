/**
 * S-05 — Batches (nav key `batches`).
 *
 * One card per batch, newest first: the batch's readable number (`batch-0002`,
 * the same label used in the object store), the series it belongs to, its state,
 * and one row per video with the stage it is sitting at and a download link once
 * an MP4 exists.
 *
 * Server-rendered and complete without scripting, in keeping with the rest of the
 * console: the one interactive element is a link.
 */
import { describeAge } from '../format.js';
import type { BatchSummary, BatchVideo } from '../batches/postgres.js';
import { escapeAttr, escapeHtml } from './html.js';

export type BatchesState = 'ready' | 'empty';

export interface BatchesInput {
  readonly batches: readonly BatchSummary[];
  readonly now: Date;
}

/** `batch-0002` — the same zero-padded label the object store uses (D-F). */
export function batchLabel(ordinal: number): string {
  return 'batch-' + String(ordinal).padStart(4, '0');
}

const STATUS_CLASS: Record<string, string> = {
  ACTIVE: 'is-running',
  COMPLETE: 'is-complete',
  CANCELLED: 'is-muted',
};

function statusCell(batch: BatchSummary): string {
  const cls = STATUS_CLASS[batch.status] ?? 'is-muted';
  return `<span class="chip ${cls}">${escapeHtml(batch.status.toLowerCase())}</span>`;
}

function videoRow(video: BatchVideo): string {
  const stage = video.currentStage === null ? '—' : escapeHtml(video.currentStage);
  const download =
    video.videoAssetId === null
      ? '<span class="muted">no file yet</span>'
      : `<a class="btn btn-small" href="/videos/${escapeAttr(video.projectId)}/download">Download MP4</a>`;
  return (
    '<tr>' +
    `<td>${video.position}</td>` +
    `<td>${escapeHtml(video.status.toLowerCase())}</td>` +
    `<td>${stage}</td>` +
    `<td>${download}</td>` +
    '</tr>'
  );
}

function batchCard(batch: BatchSummary, now: Date): string {
  const ready = batch.videos.filter((video) => video.videoAssetId !== null).length;
  const heading = `<a href="/series/${escapeAttr(batch.seriesId)}">${escapeHtml(batch.seriesName)}</a>`;
  const rows =
    batch.videos.length === 0
      ? '<tr><td colspan="4" class="muted">No videos in this batch.</td></tr>'
      : batch.videos.map(videoRow).join('');

  return (
    '<section class="batch-card" aria-labelledby="batch-' +
    escapeAttr(batch.id) +
    '">' +
    '<header class="batch-card-head">' +
    `<h2 id="batch-${escapeAttr(batch.id)}">` +
    `<a href="/batches/${escapeAttr(batch.id)}">${batchLabel(batch.ordinal)}</a></h2>` +
    statusCell(batch) +
    `<p class="batch-subject">${heading}</p>` +
    `<p class="batch-meta">${ready} of ${batch.videos.length} ` +
    `${batch.videos.length === 1 ? 'video' : 'videos'} downloadable · ` +
    `started ${escapeHtml(describeAge(now.getTime(), batch.createdAt).text)}</p>` +
    '</header>' +
    '<table class="batch-videos"><thead><tr>' +
    '<th scope="col">#</th><th scope="col">Video</th>' +
    '<th scope="col">Stage</th><th scope="col">File</th>' +
    `</tr></thead><tbody>${rows}</tbody></table>` +
    '</section>'
  );
}

export function renderBatches(input: BatchesInput): string {
  if (input.batches.length === 0) {
    return (
      '<div class="empty" data-state="empty">' +
      '<h2>No batches yet</h2>' +
      '<p>A batch is started from a series page — open a series and press ' +
      '<strong>Start batch</strong>. Nothing here runs on a timer.</p>' +
      '<p><a class="btn" href="/series">Go to series</a></p>' +
      '</div>'
    );
  }

  return (
    '<div class="batches" data-state="ready">' +
    input.batches.map((batch) => batchCard(batch, input.now)).join('') +
    '</div>'
  );
}
