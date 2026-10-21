/**
 * S-16 — Export & provenance (US-026, R-014-1, R-002-4, R-013-1, UX_SPEC
 * A-24/A-25, UI_SPEC §6.5/§9.2/§9.3/§9.6).
 *
 * Server-rendered panel, no client state: the package is a file list with
 * sizes and hashes, the pins are eleven rows, and every disabled control
 * carries the reason it is disabled in text.
 */
import { exportPanelModel } from '../provenance/model.js';
import type {
  ExportFileRow,
  ExportPanelInput,
  ExportPanelModel,
  PinRow,
} from '../provenance/model.js';
import type { ExportNotice } from '../provenance/notice.js';
import { renderChip } from './chip.js';
import { escapeAttr, escapeHtml } from './html.js';

function renderNotice(notice: ExportNotice | null | undefined): string {
  if (notice === null || notice === undefined) return '';
  return (
    '<div class="export-notice" id="export-notice" role="status" data-notice="' +
    escapeAttr(notice.kind) +
    '"><p>' +
    escapeHtml(notice.message) +
    '</p></div>'
  );
}

function renderDownload(model: ExportPanelModel): string {
  if (model.downloadable) {
    const links = model.files
      .map(
        (file) =>
          '<li><a class="export-file-download" href="' +
          escapeAttr(file.href ?? '#') +
          '" download="' +
          escapeAttr(file.name) +
          '"' +
          (file.href === null ? ' aria-disabled="true"' : '') +
          '>' +
          '<span class="export-download-kind">' +
          escapeHtml(file.kindLabel) +
          '</span>' +
          '<span class="export-download-name mono">' +
          escapeHtml(file.name) +
          '</span>' +
          '<span class="export-download-size mono num">' +
          escapeHtml(file.size) +
          '</span></a></li>',
      )
      .join('');
    return (
      '<details class="export-download" id="export-download">' +
      '<summary class="btn btn-primary export-download-summary" id="export-download-button">' +
      '<span>Download package</span>' +
      '<span class="export-sub">' +
      escapeHtml(model.totalLine) +
      '</span></summary>' +
      '<div class="export-download-body">' +
      '<p class="export-download-note">' +
      'The five files are exposed individually by the export API, so each one downloads on its own ' +
      '— there is no package archive URL to fetch.</p>' +
      '<ul class="export-download-list">' +
      links +
      '</ul></div></details>'
    );
  }

  const describedBy = 'export-download-reason export-download-summary';
  return (
    '<div class="export-download export-download-disabled" id="export-download">' +
    '<button type="button" class="btn export-download-summary" id="export-download-button" ' +
    'disabled aria-disabled="true" aria-describedby="' +
    describedBy +
    '">' +
    '<span>Download package</span>' +
    '<span class="export-sub">' +
    escapeHtml(model.totalLine) +
    '</span></button>' +
    '<p class="export-download-note" id="export-download-summary">' +
    escapeHtml(model.downloadReason ?? 'The package cannot be downloaded.') +
    '</p></div>'
  );
}

function renderExpectedKinds(model: ExportPanelModel): string {
  const items = model.expectedKinds
    .map(
      (kind) =>
        '<li class="export-kind" data-kind="' +
        escapeAttr(kind.kind) +
        '"><span class="export-kind-label">' +
        escapeHtml(kind.label) +
        '</span><span class="export-kind-detail">' +
        escapeHtml(kind.detail) +
        '</span></li>',
    )
    .join('');
  return (
    '<div class="export-expected" id="export-expected">' +
    '<p class="export-expected-line">' +
    'R-014-1 defines five files for a per-video package. Filenames, sizes and SHA-256 appear ' +
    'once the package is built.</p>' +
    '<ul class="export-kind-list">' +
    items +
    '</ul></div>'
  );
}

function downloadLink(file: ExportFileRow): string {
  if (file.href === null) return '<span class="export-no-link">No URL</span>';
  return (
    '<a class="btn export-row-download" href="' +
    escapeAttr(file.href) +
    '" download="' +
    escapeAttr(file.name) +
    '">Download<span class="sr-only"> ' +
    escapeHtml(file.name) +
    '</span></a>'
  );
}

function renderFileTable(model: ExportPanelModel): string {
  const rows = model.files
    .map(
      (file) =>
        '<tr data-file="' +
        escapeAttr(file.kind) +
        '"><th scope="row"><span class="export-file-name mono">' +
        escapeHtml(file.name) +
        '</span><span class="export-file-kind">' +
        escapeHtml(file.kindLabel) +
        ' · ' +
        escapeHtml(file.detail) +
        '</span></th>' +
        '<td class="mono num export-file-size">' +
        escapeHtml(file.size) +
        '</td>' +
        '<td class="export-file-hash"><code class="mono">' +
        escapeHtml(file.sha256) +
        '</code></td>' +
        '<td class="export-file-action">' +
        downloadLink(file) +
        '</td></tr>',
    )
    .join('');

  // Below 768 px the four-column table would squeeze every filename into a
  // 60 px gutter, so the same rows are offered as a stacked list instead.
  const stacked = model.files
    .map(
      (file) =>
        '<li class="export-file-item" data-file="' +
        escapeAttr(file.kind) +
        '"><span class="export-file-item-head"><span class="export-file-name mono">' +
        escapeHtml(file.name) +
        '</span><span class="export-file-kind">' +
        escapeHtml(file.kindLabel) +
        ' · ' +
        escapeHtml(file.detail) +
        ' · ' +
        escapeHtml(file.size) +
        '</span></span>' +
        '<a class="btn export-file-download" href="' +
        escapeAttr(file.href ?? '') +
        '" download="' +
        escapeAttr(file.name) +
        '">Download<span class="sr-only"> ' +
        escapeHtml(file.name) +
        ' (' +
        escapeHtml(file.size) +
        ')</span></a></li>',
    )
    .join('');

  return (
    '<div class="export-table-wrap export-package-table" role="region" aria-label="Package contents" tabindex="0">' +
    '<table class="export-table" data-export-files>' +
    '<caption>Package contents — every file with its size and SHA-256.</caption>' +
    '<thead><tr><th scope="col">File</th><th scope="col">Size</th>' +
    '<th scope="col">SHA-256</th><th scope="col">Download</th></tr></thead>' +
    '<tbody>' +
    rows +
    '</tbody></table></div>' +
    '<ul class="export-file-list" aria-label="Package contents">' +
    stacked +
    '</ul>'
  );
}

function renderPins(model: ExportPanelModel): string {
  const rows = model.pins
    .map((row: PinRow) => {
      const chip = row.state === null ? '' : renderChip(row.state, { size: 'sm' });
      return (
        '<tr data-stage="' +
        escapeAttr(row.stage) +
        '" data-source="' +
        escapeAttr(row.source) +
        '"><th scope="row"><span class="export-pin-code mono">' +
        escapeHtml(row.stage) +
        '</span> ' +
        escapeHtml(row.label) +
        '</th>' +
        '<td class="mono export-pin-value">' +
        escapeHtml(row.pin) +
        '</td>' +
        '<td class="export-pin-source">' +
        (row.source === 'export' ? 'package' : 'video') +
        '</td>' +
        '<td class="export-pin-state">' +
        chip +
        '</td></tr>'
      );
    })
    .join('');
  const ids = model.pins
    .filter((row) => row.versionId !== null)
    .map(
      (row) =>
        '<li><span class="mono">' +
        escapeHtml(row.stage) +
        '</span> ' +
        escapeHtml(row.versionId ?? '') +
        '</li>',
    )
    .join('');
  return (
    '<section class="export-pins" id="export-pins" aria-labelledby="export-pins-heading">' +
    '<h4 id="export-pins-heading">Series pins, per stage</h4>' +
    '<p class="export-pin-summary mono" id="export-pin-summary">' +
    'pins: ' +
    escapeHtml(model.pinSummary) +
    '</p>' +
    '<p class="export-pin-line" id="export-pin-line">' +
    escapeHtml(model.pinLine) +
    '</p>' +
    '<div class="export-table-wrap" role="region" aria-label="Per-stage series pins" tabindex="0">' +
    '<table class="export-pin-table" data-export-pins>' +
    '<caption>Every stage’s series pin, and whether it came from the package or the video.</caption>' +
    '<thead><tr><th scope="col">Stage</th><th scope="col">Pin</th>' +
    '<th scope="col">Source</th><th scope="col">Stage state</th></tr></thead>' +
    '<tbody>' +
    rows +
    '</tbody></table></div>' +
    (ids.length === 0
      ? ''
      : '<details class="export-pin-ids"><summary>Series version ids</summary>' +
        '<ul class="mono">' +
        ids +
        '</ul></details>') +
    '</section>'
  );
}

function renderBuild(model: ExportPanelModel): string {
  if (model.buildsEnabled) {
    return (
      '<form class="export-build" id="export-build" method="post" action="' +
      escapeAttr('/videos/' + encodeURIComponent(model.videoId) + '/export') +
      '">' +
      '<button type="submit" class="btn btn-primary export-build-button" id="export-build-button">' +
      escapeHtml(model.buildLabel) +
      '</button></form>'
    );
  }
  if (model.buildBlockedReason === null) return '';
  return (
    '<div class="export-build export-build-blocked" id="export-build">' +
    '<button type="button" class="btn export-build-button" id="export-build-button" ' +
    'disabled aria-disabled="true" aria-describedby="export-build-reason">' +
    escapeHtml(model.buildLabel) +
    '</button>' +
    '<p class="export-build-reason" id="export-build-reason">' +
    escapeHtml(model.buildBlockedReason) +
    '</p></div>'
  );
}

export interface RenderExportPanelInput extends ExportPanelInput {
  readonly notice?: ExportNotice | null;
}

export function renderExportPanel(input: RenderExportPanelInput): string {
  const model = exportPanelModel({
    detail: input.detail,
    view: input.view,
    buildWired: input.buildWired,
  });

  const lines = [
    model.builtLine,
    model.detailLine,
    model.eligibilityLine,
    model.staleLine,
    model.failureLine,
    model.missingLine,
    model.blockedLine,
  ]
    .filter((line): line is string => line !== null)
    .map(
      (line, index) =>
        '<p class="export-line' +
        (index === 0 ? ' export-line-first' : '') +
        '">' +
        escapeHtml(line) +
        '</p>',
    )
    .join('');

  const packageBody = model.filesAreBuilt ? renderFileTable(model) : renderExpectedKinds(model);

  const notEligible =
    model.state === 'not_eligible'
      ? '<p class="export-eligibility-action"><a class="btn btn-primary export-render-link" ' +
        'id="export-render-link" href="' +
        escapeAttr(model.renderHref) +
        '">Open Render and review final approval</a></p>'
      : '';

  return (
    '<section class="export" id="export" data-export data-state="' +
    escapeAttr(model.state) +
    '" data-video-id="' +
    escapeAttr(model.videoId) +
    '" aria-labelledby="export-heading">' +
    renderNotice(input.notice) +
    '<header class="export-head">' +
    '<h3 id="export-heading">' +
    escapeHtml(model.heading) +
    '</h3>' +
    renderChip(model.chip, { size: 'md' }) +
    '</header>' +
    '<p class="export-summary mono" id="export-summary">' +
    escapeHtml(model.summaryLine) +
    '</p>' +
    lines +
    notEligible +
    '<div class="export-grid">' +
    '<section class="export-package" id="export-package" aria-labelledby="export-package-heading">' +
    '<h4 id="export-package-heading">Package contents</h4>' +
    renderDownload(model) +
    packageBody +
    '</section>' +
    renderPins(model) +
    '</div>' +
    renderManifest(model) +
    '<footer class="export-actions" id="export-actions">' +
    renderBuild(model) +
    '</footer>' +
    '<p class="export-band-note" id="export-band-note">' +
    escapeHtml(model.monitoringNote) +
    '</p>' +
    '</section>'
  );
}

function renderManifest(model: ExportPanelModel): string {
  if (model.manifest === null) {
    return (
      '<section class="export-manifest" id="export-manifest" aria-labelledby="export-manifest-heading">' +
      '<h4 id="export-manifest-heading">Source manifest</h4>' +
      '<p class="export-manifest-empty" id="export-manifest-empty">No source manifest is recorded for this package yet.</p>' +
      '</section>'
    );
  }
  return (
    '<section class="export-manifest" id="export-manifest" aria-labelledby="export-manifest-heading">' +
    '<h4 id="export-manifest-heading">Source manifest</h4>' +
    '<details class="export-manifest-details"><summary>Show the recorded manifest</summary>' +
    '<pre class="export-manifest-json mono">' +
    escapeHtml(JSON.stringify(model.manifest, null, 2)) +
    '</pre></details></section>'
  );
}
