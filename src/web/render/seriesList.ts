/**
 * S-03 Series list (UX_SPEC §2.3/§6.1, UI_SPEC §5 UC-17/UC-24, §7.2, §9).
 *
 * A native table at every width — below 768 px the stylesheet turns each row
 * into a labelled card, so there is no second markup path and no page-level
 * horizontal scroll. Every state is server-rendered HTML.
 */
import { describeAge, formatCount } from '../format.js';
import type { SeriesListModel, SeriesListRow } from '../series/model.js';
import { escapeAttr, escapeHtml } from './html.js';

const HEADERS = [
  'Series',
  'Version',
  'Mode',
  'Duration',
  'Aspect',
  'Open batches',
  'Status',
  'Updated',
  'Actions',
] as const;

function renderVersion(row: SeriesListRow): string {
  return (
    '<span class="series-version mono" data-version="' +
    row.summary.current_version +
    '"><span class="sr-only">current version </span>v' +
    row.summary.current_version +
    '</span>'
  );
}

function renderOpenBatches(row: SeriesListRow): string {
  if (row.inFlightBatches === null) {
    return (
      '<span aria-hidden="true">—</span>' +
      '<span class="sr-only">Open batch count unavailable</span>'
    );
  }
  const count = row.inFlightBatches;
  return (
    '<span class="mono">' + count + ' ' + (count === 1 ? 'open batch' : 'open batches') + '</span>'
  );
}

function renderStatus(row: SeriesListRow): string {
  const status = row.summary.status;
  const badge =
    '<span class="series-status" data-status="' +
    escapeAttr(status) +
    '">' +
    escapeHtml(status) +
    '</span>';
  return status === 'archived'
    ? badge + '<span class="series-status-note">No new batch or topic.</span>'
    : badge;
}

function renderRow(row: SeriesListRow, now: number): string {
  const href = '/series/' + escapeAttr(row.summary.id);
  const age = describeAge(now, row.summary.updated_at);
  const cells = [
    '<td data-label="Series"><a class="series-name" href="' +
      href +
      '">' +
      escapeHtml(row.summary.name) +
      '</a></td>',
    '<td data-label="Version">' + renderVersion(row) + '</td>',
    '<td data-label="Mode"><span class="mono">' + escapeHtml(row.summary.mode) + '</span></td>',
    '<td data-label="Duration"><span class="mono">' +
      formatCount(row.summary.target_duration_s) +
      ' s</span></td>',
    '<td data-label="Aspect"><span class="mono">' +
      escapeHtml(row.summary.default_aspect_ratio) +
      '</span></td>',
    '<td data-label="Open batches">' + renderOpenBatches(row) + '</td>',
    '<td data-label="Status">' + renderStatus(row) + '</td>',
    '<td data-label="Updated"><time class="mono" datetime="' +
      escapeAttr(row.summary.updated_at) +
      '"><span class="sr-only">' +
      escapeHtml(age.absolute) +
      '</span>' +
      escapeHtml(age.text) +
      '</time></td>',
    '<td data-label="Actions"><a class="series-open quiet" href="' + href + '">Open</a></td>',
  ];
  return '<tr>' + cells.join('') + '</tr>';
}

function renderTable(model: SeriesListModel, loading: boolean): string {
  const caption = loading
    ? '<caption class="sr-only">Loading series</caption>'
    : '<caption class="sr-only">Series profiles: name, current version, mode, duration, ' +
      'aspect, open batches, status and last update.</caption>';

  const head =
    '<thead><tr>' +
    HEADERS.map((header) => '<th scope="col">' + header + '</th>').join('') +
    '</tr></thead>';

  const body = loading
    ? '<tbody>' +
      Array.from(
        { length: 5 },
        () =>
          '<tr>' +
          HEADERS.map(
            () => '<td><span class="series-skeleton" aria-hidden="true"></span></td>',
          ).join('') +
          '</tr>',
      ).join('') +
      '</tbody>'
    : '<tbody>' + model.rows.map((row) => renderRow(row, model.now)).join('') + '</tbody>';

  return (
    '<div class="series-table-wrap" role="region" aria-label="Series list" tabindex="0">' +
    '<table class="tbl series-table"' +
    (loading ? ' aria-busy="true"' : '') +
    '>' +
    caption +
    head +
    body +
    '</table></div>'
  );
}

function renderEmpty(): string {
  return (
    '<div class="series-empty">' +
    '<p class="series-empty-line">No series yet.</p>' +
    '<a class="btn btn-primary" href="/series/new">Create series</a>' +
    '</div>'
  );
}

function renderError(model: SeriesListModel): string {
  return (
    '<section class="series-error" aria-labelledby="series-error-heading">' +
    '<h2 id="series-error-heading">Series list unavailable</h2>' +
    '<p>' +
    escapeHtml(model.errorMessage ?? 'The series list could not be loaded. Nothing was changed.') +
    '</p>' +
    '<a class="btn" href="/series">Retry</a>' +
    '</section>'
  );
}

export function renderSeriesList(model: SeriesListModel): string {
  if (model.state === 'error') return renderError(model);
  if (model.state === 'empty') return renderEmpty();
  if (model.state === 'loading') return renderTable(model, true);

  const toolbar =
    '<div class="series-toolbar">' +
    '<p class="series-count mono">' +
    formatCount(model.rows.length) +
    ' series</p>' +
    '<a class="btn btn-primary" href="/series/new">Create series</a>' +
    '</div>';

  return (
    '<section class="series-list" aria-label="Series">' +
    toolbar +
    renderTable(model, false) +
    '</section>'
  );
}
