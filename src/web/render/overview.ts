/**
 * S-02 — Overview / attention inbox (UI_SPEC §6.2 W-01, UX_SPEC W-01/IP-05).
 *
 * Milestone A's single-video form: attention rows grouped by batch, with the
 * batchless project standing on its own card. Every row links straight to the
 * tab that holds its gate (IP-03), because "which video needs me" is only half
 * the answer — the other half is where to go.
 *
 * The SSE enhancer updates rows and batch counters in place (see
 * `client/workspace.ts`); the server-rendered state is complete on its own.
 */
import { describeAge, countPair } from '../format.js';
import {
  batchesWithoutAttention,
  overviewModel,
  type Overview,
  type OverviewGroup,
  type OverviewModel,
  type OverviewRow,
} from '../workspace/model.js';
import { escapeAttr, escapeHtml } from './html.js';

export type OverviewState = 'loading' | 'ready' | 'empty' | 'error';

export interface OverviewInput {
  readonly state: OverviewState;
  readonly overview?: Overview;
  readonly now: number;
  /** How many series exist, used only to tell "first run" from "no batches". */
  readonly seriesCount?: number | null;
  readonly errorMessage?: string;
}

function renderRow(row: OverviewRow, now: number): string {
  const age = describeAge(now, row.updatedAt);
  const position =
    row.position === null
      ? '<span aria-hidden="true">—</span>'
      : '#' + escapeHtml(String(row.position));
  return (
    '<li class="attention-row" data-attention-row="' +
    escapeAttr(row.videoId) +
    '" data-stage-state="' +
    escapeAttr(row.state) +
    '" data-stage="' +
    escapeAttr(row.stage) +
    '">' +
    '<span class="attention-position mono">' +
    position +
    '<span class="sr-only"> ' +
    escapeHtml(row.label) +
    '</span></span>' +
    '<span class="attention-label">' +
    escapeHtml(row.label) +
    '</span>' +
    '<span class="attention-reason" data-attention-reason>' +
    escapeHtml(row.reason) +
    '</span>' +
    '<span class="attention-detail" data-attention-detail>' +
    escapeHtml(row.detail) +
    '</span>' +
    '<time class="attention-age mono" datetime="' +
    escapeAttr(row.updatedAt) +
    '">' +
    '<span class="sr-only">' +
    escapeHtml(age.absolute) +
    '</span>' +
    escapeHtml(age.text) +
    '</time>' +
    '<a class="attention-open" href="' +
    escapeAttr(row.href) +
    '">Open<span class="sr-only"> ' +
    escapeHtml(row.label) +
    ' — ' +
    escapeHtml(row.reason) +
    '</span></a>' +
    '</li>'
  );
}

function renderGroup(group: OverviewGroup, now: number): string {
  const progress =
    group.progress === null
      ? ''
      : '<span class="attention-progress mono" data-batch-progress="' +
        escapeAttr(group.batchId ?? '') +
        '">' +
        escapeHtml(group.progress) +
        '</span>';
  return (
    '<article class="attention-card" data-attention-group="' +
    escapeAttr(group.key) +
    '">' +
    '<header class="attention-card-head">' +
    '<h3 class="attention-group-title">' +
    escapeHtml(group.seriesName) +
    '</h3>' +
    '<span class="attention-batch mono">' +
    escapeHtml(group.batchLabel) +
    '</span>' +
    progress +
    '</header>' +
    '<ul class="attention-rows">' +
    group.rows.map((row) => renderRow(row, now)).join('') +
    '</ul>' +
    '</article>'
  );
}

function renderBatchCard(overview: Overview, now: number): string {
  return batchesWithoutAttention(overview)
    .map((batch) => {
      const age = describeAge(now, batch.created_at);
      return (
        '<article class="attention-card attention-card-quiet" data-batch-card="' +
        escapeAttr(batch.id) +
        '">' +
        '<header class="attention-card-head">' +
        '<h3 class="attention-group-title">' +
        escapeHtml(batch.series_name) +
        '</h3>' +
        '<span class="attention-batch mono">batch ' +
        escapeHtml(batch.id.slice(0, 8)) +
        '</span>' +
        '<span class="attention-progress mono" data-batch-progress="' +
        escapeAttr(batch.id) +
        '">' +
        batch.completed_count +
        ' of ' +
        batch.target_count +
        ' complete</span>' +
        '<span class="attention-age mono">' +
        escapeHtml(age.text) +
        '</span>' +
        '</header>' +
        '<p class="attention-quiet-line">No video in this batch needs attention.</p>' +
        '</article>'
      );
    })
    .join('');
}

function renderReady(model: OverviewModel, overview: Overview, now: number): string {
  const header =
    '<div class="overview-head">' +
    '<h2 id="attention-heading">Needs attention <span class="overview-count mono" ' +
    'data-attention-count>' +
    model.attentionCount +
    '</span></h2>' +
    (model.nextHref === null
      ? ''
      : '<a class="btn btn-primary" href="' +
        escapeAttr(model.nextHref) +
        '">Review next needing attention <span aria-hidden="true">&#8594;</span></a>') +
    '</div>';

  const quiet =
    model.attentionCount === 0
      ? '<p class="overview-none">Nothing needs attention right now.</p>'
      : '';

  const progress =
    '<section class="overview-progress" aria-labelledby="progress-heading">' +
    '<h2 id="progress-heading">Progress</h2>' +
    '<ul class="overview-groups">' +
    '<li class="overview-group"><span class="overview-group-label">Running</span>' +
    '<span class="mono" data-overview-running>' +
    countPair(model.running, 'video', 'videos') +
    '</span></li>' +
    '<li class="overview-group"><span class="overview-group-label">Complete</span>' +
    '<span class="mono" data-overview-complete>' +
    countPair(model.complete, 'video', 'videos') +
    '</span></li>' +
    '<li class="overview-group"><span class="overview-group-label">Batches</span>' +
    '<span class="mono" data-overview-batches>' +
    countPair(model.batchCount, 'batch', 'batches') +
    '</span></li>' +
    '</ul>' +
    '</section>';

  return (
    '<div class="overview" data-overview aria-labelledby="attention-heading">' +
    header +
    '<p class="overview-new" data-overview-new hidden></p>' +
    quiet +
    model.groups.map((group) => renderGroup(group, now)).join('') +
    renderBatchCard(overview, now) +
    progress +
    '</div>'
  );
}

function renderEmpty(seriesCount: number | null | undefined): string {
  const firstRun = seriesCount === 0;
  const line = firstRun ? 'No series yet. No batches yet.' : 'No batches yet.';
  const quiet = firstRun
    ? 'Three provider keys are checked in Settings.'
    : 'Open a series to create its first video.';
  return (
    '<div class="overview-empty" data-overview data-overview-empty>' +
    '<p class="overview-empty-line">' +
    escapeHtml(line) +
    '</p>' +
    '<a class="btn btn-primary" href="/series/new">Create series</a>' +
    '<p class="overview-empty-quiet">' +
    escapeHtml(quiet) +
    '</p>' +
    '</div>'
  );
}

function renderLoading(): string {
  const cards = Array.from(
    { length: 3 },
    () =>
      '<article class="attention-card" aria-hidden="true">' +
      '<div class="attention-skeleton attention-skeleton-head"></div>' +
      '<div class="attention-skeleton attention-skeleton-row"></div>' +
      '<div class="attention-skeleton attention-skeleton-row"></div>' +
      '</article>',
  ).join('');
  return (
    '<div class="overview" data-overview aria-busy="true">' +
    '<div class="overview-head"><h2>Needs attention</h2></div>' +
    '<p class="sr-only" role="status">Loading the attention queue</p>' +
    cards +
    '</div>'
  );
}

function renderError(input: OverviewInput): string {
  const message = input.errorMessage ?? 'Status feed unavailable. Nothing was changed.';
  return (
    '<section class="overview-error" data-overview data-overview-error ' +
    'aria-labelledby="overview-error-heading">' +
    '<h2 id="overview-error-heading">Status feed unavailable</h2>' +
    '<p>' +
    escapeHtml(message) +
    '</p>' +
    '<a class="btn" href="/">Retry</a>' +
    '</section>'
  );
}

export function renderOverview(input: OverviewInput): string {
  switch (input.state) {
    case 'loading':
      return renderLoading();
    case 'error':
      return renderError(input);
    case 'empty':
      return renderEmpty(input.seriesCount);
    case 'ready': {
      if (input.overview === undefined) {
        throw new Error('renderOverview: the ready state needs an overview payload');
      }
      return renderReady(overviewModel(input.overview), input.overview, input.now);
    }
  }
}
