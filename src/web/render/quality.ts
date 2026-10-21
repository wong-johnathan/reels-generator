/**
 * S-15 — Render & QC (US-024, US-025, US-028 final-approve gate; R-005-3/4,
 * R-010-2…7, UX_SPEC A-21…A-23, UI_SPEC §9.2/§9.6, AX-15).
 *
 * Server-rendered and complete without JavaScript: the output, the six QC
 * numbers, the single safe-area rectangle, the approval form and the return
 * path are all decided here. The workspace enhancer may repaint the rail and
 * the header chip from SSE; it never rewrites this panel.
 *
 * The panel never autoplays, never invents a check, and never enables approval
 * without six reported numbers, a video asset and the revision the contract
 * requires.
 */
import type { VideoDetail } from '../workspace/model.js';
import {
  qcVisible,
  renderPanelModel,
  type ApprovalView,
  type QCCheckRow,
  type RenderPanelModel,
  type RenderView,
} from '../quality/model.js';
import type { QualityNotice } from '../quality/notice.js';
import { renderChip } from './chip.js';
import { escapeAttr, escapeHtml } from './html.js';

export type { QualityNotice };

export interface QualityPanelInput {
  readonly detail: VideoDetail;
  readonly render: RenderView | null;
  /** Gap S-15-1: null when the caller cannot supply the approve revision. */
  readonly revision: number | null;
  /** False when the gateway has no approve seam (same gap). */
  readonly approveWired: boolean;
  readonly notice?: QualityNotice | null;
}

function kv(label: string, value: string): string {
  return (
    '<div class="quality-kv"><dt>' +
    escapeHtml(label) +
    '</dt><dd class="mono">' +
    escapeHtml(value) +
    '</dd></div>'
  );
}

function renderNotice(notice: QualityNotice | null | undefined): string {
  if (notice === null || notice === undefined) return '';
  return (
    '<div class="quality-notice" role="status" data-notice="' +
    escapeAttr(notice.kind) +
    '"><p>' +
    escapeHtml(notice.message) +
    '</p></div>'
  );
}

function renderPlayer(model: RenderPanelModel): string {
  const href = model.videoHref;
  if (href === null) return '';
  const poster = model.posterHref === null ? '' : ' poster="' + escapeAttr(model.posterHref) + '"';
  const track =
    model.vttHref === null
      ? ''
      : '<track kind="captions" src="' +
        escapeAttr(model.vttHref) +
        '" srclang="en" label="English captions">';
  const stats = model.stats.rows.map(([label, value]) => kv(label, value)).join('');
  return (
    '<figure class="quality-player" id="quality-player" aria-labelledby="quality-player-heading">' +
    '<h4 id="quality-player-heading">Output</h4>' +
    '<div class="quality-frame">' +
    '<video id="render-video" class="quality-video" controls preload="metadata" src="' +
    escapeAttr(href) +
    '"' +
    poster +
    ' aria-describedby="render-video-alt">' +
    track +
    '</video>' +
    '<div class="quality-safe-area" data-safe-area aria-hidden="true">' +
    '<span class="quality-safe-area-label">5 % safe area</span>' +
    '</div>' +
    '</div>' +
    '<figcaption class="quality-alt" id="render-video-alt">' +
    escapeHtml(model.stats.videoAlt) +
    '</figcaption>' +
    '<p class="quality-safe-note" id="quality-safe-note">' +
    escapeHtml(model.safeArea) +
    '</p>' +
    '<dl class="quality-stats" id="quality-stats">' +
    kv('Passes', model.stats.passLine) +
    stats +
    '</dl>' +
    '</figure>'
  );
}

function resultChip(row: QCCheckRow): string {
  if (row.status === 'pass') return renderChip('done', { size: 'sm', label: 'PASS' });
  if (row.status === 'fail') return renderChip('failed', { size: 'sm', label: 'FAIL' });
  return renderChip('not_run', { size: 'sm', label: 'NOT REPORTED' });
}

function renderCheckRow(row: QCCheckRow): string {
  return (
    '<tr data-check="' +
    escapeAttr(row.requirement) +
    '" data-status="' +
    escapeAttr(row.status) +
    '">' +
    '<th scope="row">' +
    '<span class="quality-check-head">' +
    '<span class="quality-check-id mono">' +
    escapeHtml(row.id) +
    '</span>' +
    '<span class="quality-check-req mono">' +
    escapeHtml(row.requirement) +
    '</span>' +
    '</span>' +
    '<span class="quality-check-label">' +
    escapeHtml(row.label) +
    '</span>' +
    '</th>' +
    '<td class="mono quality-cell-measured">' +
    escapeHtml(row.measured) +
    '</td>' +
    '<td class="mono quality-cell-expected">' +
    escapeHtml(row.expected) +
    '</td>' +
    '<td class="quality-result">' +
    resultChip(row) +
    '</td>' +
    '</tr>'
  );
}

function renderChecks(model: RenderPanelModel): string {
  const qc = model.qc;
  const failing =
    qc.failingLine === null
      ? ''
      : '<p class="quality-failing" id="quality-failing" role="note">' +
        escapeHtml(qc.failingLine) +
        '</p>';
  const missing =
    qc.missingLine === null
      ? ''
      : '<p class="quality-missing" id="quality-missing" role="note">' +
        escapeHtml(qc.missingLine) +
        '</p>';
  return (
    '<section class="quality-checks" id="quality-checks" aria-labelledby="quality-checks-heading">' +
    '<h4 id="quality-checks-heading">Quality checks</h4>' +
    '<p class="quality-checked mono" id="quality-checked">' +
    escapeHtml(qc.checkedLine) +
    '</p>' +
    '<p class="quality-checks-summary mono" id="quality-checks-summary">' +
    escapeHtml(qc.summaryLine) +
    '</p>' +
    failing +
    missing +
    '<div class="quality-table-wrap" role="region" aria-label="Quality checks results" tabindex="0">' +
    '<table class="quality-table" data-quality-checks>' +
    '<caption>Six checks, R-010-2 to R-010-7 — each with the number it measured.</caption>' +
    '<colgroup>' +
    '<col class="quality-col-check"><col class="quality-col-measured">' +
    '<col class="quality-col-expected"><col class="quality-col-result"></colgroup>' +
    '<thead><tr>' +
    '<th scope="col">Check</th>' +
    '<th scope="col">Measured</th>' +
    '<th scope="col">Expected</th>' +
    '<th scope="col">Result</th>' +
    '</tr></thead>' +
    '<tbody>' +
    qc.rows.map(renderCheckRow).join('') +
    '</tbody></table></div></section>'
  );
}

function renderApproval(model: RenderPanelModel): string {
  const approval: ApprovalView = model.approval;
  const state =
    approval.approvedLine !== null ? 'approved' : approval.enabled ? 'ready' : 'blocked';

  let body: string;
  if (approval.approvedLine !== null) {
    body =
      '<p class="quality-approved" id="quality-approved">' +
      escapeHtml(approval.approvedLine) +
      '</p>' +
      '<p class="quality-export-enabled"><a class="btn btn-secondary quality-export-link" href="' +
      escapeAttr('/videos/' + encodeURIComponent(model.videoId) + '/export') +
      '">Open Export</a></p>';
  } else if (approval.enabled) {
    body =
      '<form class="quality-approve-form" method="post" action="' +
      escapeAttr('/videos/' + encodeURIComponent(model.videoId) + '/render/approve') +
      '">' +
      '<input type="hidden" name="revision" value="' +
      escapeAttr(String(approval.revision ?? '')) +
      '">' +
      '<label class="quality-note-label" for="quality-note">Note (optional)</label>' +
      '<textarea class="quality-note-input" id="quality-note" name="note" rows="2" maxlength="' +
      escapeAttr(String(approval.noteMaxLength)) +
      '"></textarea>' +
      '<button type="submit" id="quality-approve-button" class="btn btn-primary quality-approve-button" aria-describedby="quality-gate-line">' +
      'Approve final</button>' +
      '</form>';
  } else {
    body =
      '<button type="button" id="quality-approve-button" class="btn quality-approve-button" ' +
      'disabled aria-disabled="true" aria-describedby="quality-gate-line quality-approval-reason">' +
      'Approve final</button>' +
      (approval.reason === null
        ? ''
        : '<p class="quality-reason" id="quality-approval-reason">' +
          escapeHtml(approval.reason) +
          '</p>');
  }

  const links = approval.returnLinks
    .map(
      (link) =>
        '<li><a class="btn quality-return-link" href="' +
        escapeAttr(link.href) +
        '">' +
        escapeHtml(link.label) +
        '</a></li>',
    )
    .join('');

  return (
    '<footer class="quality-approval" id="quality-approval" data-approval="' +
    state +
    '" aria-labelledby="quality-approval-heading">' +
    '<h4 id="quality-approval-heading">Final approval</h4>' +
    '<p class="quality-gate-line" id="quality-gate-line">' +
    escapeHtml(approval.gateLine) +
    '</p>' +
    body +
    '<div class="quality-return" id="quality-return" aria-labelledby="quality-return-heading">' +
    '<h4 id="quality-return-heading">Return to a stage</h4>' +
    '<p class="quality-return-line" id="quality-return-line">' +
    escapeHtml(approval.returnLine) +
    '</p>' +
    '<ul class="quality-return-links">' +
    links +
    '</ul></div>' +
    '</footer>' +
    '<p class="quality-band-note" id="quality-band-note">' +
    escapeHtml(model.monitoringNote) +
    '</p>'
  );
}

function renderEmpty(model: RenderPanelModel): string {
  return (
    '<div class="quality-empty" id="quality-empty-block">' +
    '<p class="quality-empty-line" id="quality-empty">' +
    escapeHtml(model.emptyLine ?? '') +
    '</p>' +
    (model.emptyUnlockLine === null
      ? ''
      : '<p class="quality-unlock" id="quality-empty-unlock">' +
        escapeHtml(model.emptyUnlockLine) +
        '</p>') +
    '<p class="quality-empty-action"><a class="btn" id="quality-empty-action" href="' +
    escapeAttr('/videos/' + encodeURIComponent(model.videoId) + '/audio') +
    '">Go to Audio</a></p>' +
    '</div>'
  );
}

export function renderQualityPanel(input: QualityPanelInput): string {
  const model = renderPanelModel({
    detail: input.detail,
    render: input.render,
    revision: input.revision,
    approveWired: input.approveWired,
  });

  const summary =
    model.summaryLine === null
      ? ''
      : '<p class="quality-summary mono" id="quality-summary">' +
        escapeHtml(model.summaryLine) +
        '</p>';
  const detailLine =
    model.detailLine === null
      ? ''
      : '<p class="quality-detail" id="quality-detail">' + escapeHtml(model.detailLine) + '</p>';
  const stale =
    model.staleLine === null
      ? ''
      : '<p class="quality-stale" id="quality-stale" role="note">' +
        escapeHtml(model.staleLine) +
        '</p>';

  const body =
    model.state === 'empty'
      ? renderEmpty(model)
      : '<div class="quality-grid">' +
        renderPlayer(model) +
        (qcVisible(model.state)
          ? renderChecks(model)
          : '<p class="quality-qc-pending" id="quality-qc-pending">QC has not run. It runs after the render finishes.</p>') +
        '</div>' +
        (model.failureNote === null
          ? ''
          : '<p class="quality-failure" id="quality-failure" role="note">' +
            escapeHtml(model.failureNote) +
            '</p>') +
        (model.leaveNote === null
          ? ''
          : '<p class="quality-leave-note" id="quality-leave-note">' +
            escapeHtml(model.leaveNote) +
            '</p>');

  return (
    '<section class="quality" id="quality" data-quality data-state="' +
    escapeAttr(model.state) +
    '" data-video-id="' +
    escapeAttr(model.videoId) +
    '" aria-labelledby="quality-heading">' +
    renderNotice(input.notice) +
    '<header class="quality-head">' +
    '<h3 id="quality-heading">' +
    escapeHtml(model.heading) +
    '</h3>' +
    renderChip(model.chip, {
      size: 'md',
      ...(model.chipLabel === null ? {} : { label: model.chipLabel }),
    }) +
    '</header>' +
    summary +
    detailLine +
    stale +
    body +
    renderApproval(model) +
    '</section>'
  );
}
