/**
 * S-10 — script review, claims and change impact (UI_SPEC §6.6 W-05, §5 UC-06,
 * UX_SPEC IP-01/IP-10, R-005-2, R-003-2, R-027-3).
 *
 * Server-rendered HTML plus progressive enhancement (TECH_DESIGN X-2). The
 * server render is complete without JavaScript: the budget, the 8-gram result,
 * the claim rows and the approval gate are all decided here. The impact panel
 * starts in its "no unsaved changes" state because IP-01's preview is computed
 * by the server on demand and the client only formats it.
 *
 * DOM order is AX-02's focus order (status → budget → editor → claims →
 * approval → impact); CSS places the impact column beside the editor, not the
 * DOM. Nothing here prices anything (D2).
 */
import { STAGE_LABELS } from '../../shared/stages.js';
import { isoSeconds } from '../format.js';
import {
  approvalView,
  eightGramView,
  claimsView,
  wordBudgetView,
  APPROVE_REASON_ID,
  type ScriptView,
} from '../script/model.js';
import type { VideoDetail } from '../workspace/model.js';
import { renderChip } from './chip.js';
import { escapeAttr, escapeHtml } from './html.js';

export const SCRIPT_REVIEW_SCRIPTS: readonly string[] = ['/assets/client/script-review.js'];

export interface ScriptReviewInput {
  readonly detail: VideoDetail;
  readonly script: ScriptView | null;
}

function renderEmpty(detail: VideoDetail): string {
  return (
    '<section class="script-review script-review-blocked" id="script-empty" data-script-review ' +
    'data-empty="true" data-video-id="' +
    escapeAttr(detail.id) +
    '">' +
    '<h2>No script yet</h2>' +
    '<p>The script is blocked on topic approval. Approve the topic and the script draft is generated from it.</p>' +
    '<p><a class="btn" href="/videos/' +
    escapeAttr(encodeURIComponent(detail.id)) +
    '/topic">Go to Topic</a></p>' +
    '</section>'
  );
}

function renderDrafting(detail: VideoDetail): string {
  const stage = detail.stages.find((row) => row.stage === 'SC');
  const attempt = Math.min((stage?.attempts.count ?? 0) + 1, stage?.attempts.max_attempts ?? 3);
  const max = stage?.attempts.max_attempts ?? 3;
  return (
    '<section class="script-review" id="script-drafting" data-script-review data-script-drafting="true" ' +
    'data-video-id="' +
    escapeAttr(detail.id) +
    '">' +
    '<h2>Script</h2>' +
    '<p class="script-drafting mono" data-drafting-attempt>' +
    'Drafting… schema attempt ' +
    attempt +
    ' of ' +
    max +
    '</p>' +
    '<p>No billable stage is running. The script is validated before anything downstream is charged.</p>' +
    '</section>'
  );
}

function renderSchemaFailure(detail: VideoDetail): string {
  const stage = detail.stages.find((row) => row.stage === 'SC');
  const attempts = stage?.attempts.count ?? 3;
  return (
    '<section class="script-review script-review-blocked" id="script-schema-failure" ' +
    'data-script-review data-script-schema-failure="true" data-video-id="' +
    escapeAttr(detail.id) +
    '">' +
    '<h2>The script could not be generated</h2>' +
    '<p>The script could not be generated in the required schema after ' +
    attempts +
    ' attempts. Failing field: —. Schema version: —.</p>' +
    '<p>The failing field and schema version are not exposed by the current script endpoint; they are named here only when the server supplies them.</p>' +
    '</section>'
  );
}

function field(input: {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly value: string;
  readonly rows?: number;
  readonly hint?: string;
}): string {
  const described = input.hint === undefined ? '' : ' aria-describedby="' + input.id + '-hint"';
  const hint =
    input.hint === undefined
      ? ''
      : '<p class="script-field-hint" id="' +
        input.id +
        '-hint">' +
        escapeHtml(input.hint) +
        '</p>';
  return (
    '<div class="script-field">' +
    '<label for="' +
    input.id +
    '">' +
    escapeHtml(input.label) +
    '</label>' +
    '<textarea id="' +
    input.id +
    '" name="' +
    escapeAttr(input.name) +
    '" data-field="' +
    escapeAttr(input.name) +
    '" rows="' +
    (input.rows ?? 3) +
    '"' +
    described +
    '>' +
    escapeHtml(input.value) +
    '</textarea>' +
    hint +
    '</div>'
  );
}

function textField(input: {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly value: string;
}): string {
  return (
    '<div class="script-field">' +
    '<label for="' +
    input.id +
    '">' +
    escapeHtml(input.label) +
    '</label>' +
    '<input type="text" id="' +
    input.id +
    '" name="' +
    escapeAttr(input.name) +
    '" data-field="' +
    escapeAttr(input.name) +
    '" value="' +
    escapeAttr(input.value) +
    '">' +
    '</div>'
  );
}

function renderStatusBar(script: ScriptView): string {
  const eightGram = eightGramView(script);
  return (
    '<div class="script-status" id="script-status">' +
    '<p class="script-rev mono" id="script-rev">' +
    '<span id="script-rev-number" data-script-rev-number>Script rev ' +
    script.revision +
    '</span>' +
    '<span class="script-dirty" data-script-dirty hidden> (unsaved changes)</span>' +
    '</p>' +
    renderChip(eightGram.pass ? 'done' : 'failed', {
      size: 'sm',
      id: 'script-eight-gram',
      label: '8-gram ' + eightGram.word,
    }) +
    '</div>' +
    '<p class="script-eight-gram-text" id="script-eight-gram-text">' +
    escapeHtml(eightGram.text) +
    '</p>'
  );
}

function renderBudget(script: ScriptView): string {
  const budget = wordBudgetView(script);
  return (
    '<div class="script-budget" data-word-budget data-within-band="' +
    (budget.withinBand ? 'true' : 'false') +
    '">' +
    '<p class="script-budget-line mono">' +
    '<span id="script-budget-words">' +
    escapeHtml(budget.wordsLine) +
    '</span>' +
    '<span class="script-budget-band" id="script-budget-band">' +
    escapeHtml(budget.bandLine) +
    '</span>' +
    '</p>' +
    (budget.warning === null
      ? ''
      : '<p class="script-budget-warning" id="script-budget-warning" role="status">' +
        escapeHtml(budget.warning) +
        '</p>') +
    '</div>'
  );
}

function renderClaims(script: ScriptView): string {
  const claims = claimsView(script);
  const rows = claims.rows
    .map(
      (row) =>
        '<tr data-claim-id="' +
        escapeAttr(row.id) +
        '" data-claim-status="' +
        escapeAttr(row.status) +
        '" data-unresolved="' +
        (row.unresolved ? 'true' : 'false') +
        '">' +
        '<td class="claims-text">' +
        escapeHtml(row.text) +
        ' <span class="sr-only">(' +
        (row.unresolved ? 'no resolvable source' : 'resolved') +
        ')</span></td>' +
        '<td class="claims-source mono">' +
        escapeHtml(row.sourceLabel) +
        '</td>' +
        '</tr>',
    )
    .join('');
  return (
    '<section class="script-claims" id="script-claims" data-claims aria-labelledby="script-claims-summary">' +
    '<h3 class="claims-heading" id="script-claims-summary">' +
    escapeHtml(claims.summary) +
    '</h3>' +
    (claims.rows.length === 0
      ? '<p class="claims-empty">No claims are recorded for this revision.</p>'
      : '<div class="ops-table-wrap" role="region" aria-label="Claims and their sources" tabindex="0">' +
        '<table class="claims-table"><caption class="sr-only">Claims and their sources</caption>' +
        '<thead><tr><th scope="col">Claim</th><th scope="col">Source</th></tr></thead>' +
        '<tbody>' +
        rows +
        '</tbody></table></div>') +
    '</section>'
  );
}

function renderApproval(script: ScriptView, detail: VideoDetail): string {
  const approval = approvalView(script, detail);
  const reasons = approval.reasons
    .map(
      (reason, index) =>
        '<p class="script-approve-reason"' +
        (index === 0 ? ' id="' + APPROVE_REASON_ID + '"' : '') +
        '>' +
        escapeHtml(reason) +
        '</p>',
    )
    .join('');

  const describedBy =
    approval.describedBy === null ? '' : ' aria-describedby="' + approval.describedBy + '"';
  // The record line and the control are both present so a successful approval
  // can swap them in place without re-deriving claims in the browser; exactly
  // one of them is exposed at a time.
  const recordAttributes = approval.approved ? '' : ' hidden';
  const buttonAttributes =
    (approval.approved ? ' hidden' : '') +
    (approval.canApprove ? '' : ' disabled aria-disabled="true"') +
    describedBy;

  return (
    '<div class="script-approval" id="script-approval" data-approval data-approved="' +
    (approval.approved ? 'true' : 'false') +
    '" data-blocked="' +
    (approval.blocked ? 'true' : 'false') +
    '">' +
    renderChip(approval.approved ? 'done' : approval.blocked ? 'blocked' : 'awaiting_approval', {
      size: 'md',
    }) +
    (approval.approved ? '' : reasons) +
    '<p class="script-approved-record mono" id="script-approved-record" data-approved-record' +
    recordAttributes +
    '>' +
    escapeHtml(approval.record ?? '') +
    '</p>' +
    '<button type="button" class="btn btn-primary script-approve" id="script-approve" data-script-approve' +
    buttonAttributes +
    '>' +
    escapeHtml(approval.label) +
    '</button>' +
    (approval.approved
      ? ''
      : '<p class="script-unlock" id="script-unlock">' +
        escapeHtml(approval.unlockLine) +
        '</p>' +
        (approval.note === null
          ? ''
          : '<p class="script-approve-note" id="script-approve-note">' +
            escapeHtml(approval.note) +
            '</p>')) +
    '</div>'
  );
}

function renderImpact(): string {
  return (
    '<aside class="script-impact" id="script-impact" data-impact aria-labelledby="script-impact-heading">' +
    '<header class="impact-head">' +
    '<h3 id="script-impact-heading">Change impact</h3>' +
    '<span class="impact-chip mono" data-impact-chip id="script-impact-chip">no changes</span>' +
    '</header>' +
    '<div class="impact-body">' +
    '<p class="impact-message" id="script-impact-message" data-impact-message>No unsaved changes</p>' +
    '<div class="impact-detail" data-impact-detail hidden>' +
    '<section class="impact-group"><h4>What changes</h4><p data-impact-changes id="script-impact-changes"></p></section>' +
    '<section class="impact-group"><h4 class="impact-stale-label">Becomes stale</h4><ul class="impact-stale" data-impact-stale id="script-impact-stale"></ul></section>' +
    '<section class="impact-group"><h4 class="impact-survives-label">Survives</h4><ul class="impact-survives" data-impact-survives id="script-impact-survives"></ul></section>' +
    '<section class="impact-group impact-calls"><h4>Calls if regenerated</h4><p class="mono" data-impact-calls id="script-impact-calls"></p></section>' +
    '<p class="impact-conditional" data-impact-conditional id="script-impact-conditional" hidden></p>' +
    '<ul class="impact-blockers" data-impact-blockers id="script-impact-blockers" hidden></ul>' +
    '</div>' +
    '<div class="impact-skeleton" data-impact-skeleton hidden aria-hidden="true"><span></span><span></span><span></span></div>' +
    '<button type="button" class="btn impact-retry" data-impact-retry id="script-impact-retry" hidden>Retry</button>' +
    '</div>' +
    '<footer class="impact-actions">' +
    '<button type="submit" class="btn" data-commit="edit" id="script-apply" disabled>' +
    'Apply edit (no regeneration)' +
    '</button>' +
    '<button type="submit" class="btn btn-primary" data-commit="regenerate" id="script-regenerate" disabled aria-disabled="true">' +
    'Apply and regenerate now' +
    '</button>' +
    '</footer>' +
    '</aside>'
  );
}

export function renderScriptReview(input: ScriptReviewInput): string {
  const { detail, script } = input;
  if (script === null) {
    const stage = detail.stages.find((row) => row.stage === 'SC');
    if (stage?.state === 'running') return renderDrafting(detail);
    if (stage?.state === 'failed') return renderSchemaFailure(detail);
    return renderEmpty(detail);
  }

  const content = script.content;
  return (
    '<section class="script-review" id="script-review" data-script-review ' +
    'data-video-id="' +
    escapeAttr(detail.id) +
    '" data-script-revision="' +
    script.revision +
    '" data-script-status="' +
    escapeAttr(script.status) +
    '">' +
    '<div class="script-main">' +
    renderStatusBar(script) +
    renderBudget(script) +
    '<form class="script-form" id="script-editor" data-script-form data-video-id="' +
    escapeAttr(detail.id) +
    '" data-revision="' +
    script.revision +
    '" novalidate>' +
    '<input type="hidden" name="revision" value="' +
    script.revision +
    '" data-revision-field>' +
    // One field, because the script is one thing: the opening line, the argument and
    // the landing all live in the same piece of prose the voice will read.
    field({
      id: 'script-body',
      name: 'script',
      label: 'Script',
      value: content.script,
      rows: 14,
    }) +
    '<div class="script-meta-divider" aria-hidden="true"></div>' +
    textField({ id: 'script-title', name: 'title', label: 'Title', value: content.title }) +
    field({
      id: 'script-description',
      name: 'description',
      label: 'Description',
      value: content.description,
      rows: 3,
    }) +
    textField({
      id: 'script-hashtags',
      name: 'hashtags',
      label: 'Hashtags (comma separated)',
      value: content.hashtags.join(', '),
    }) +
    '<div class="script-conflict" id="script-conflict" data-conflict role="alert" hidden>' +
    '<p data-conflict-text id="script-conflict-text"></p>' +
    '<p class="script-conflict-actions">' +
    '<button type="button" class="btn" data-conflict-load>Load the saved revision</button>' +
    '<button type="button" class="btn" data-conflict-keep>Keep my text</button>' +
    '</p>' +
    '</div>' +
    renderClaims(script) +
    renderApproval(script, detail) +
    '</form>' +
    '</div>' +
    renderImpact() +
    '</section>'
  );
}

/** Used by the SSE/approval enhancer to label a stage code in the ribbon. */
export function stageName(code: keyof typeof STAGE_LABELS): string {
  return STAGE_LABELS[code];
}

/** `2026-10-20T09:41:12.000Z` → `2026-10-20T09:41:12Z` (kept next to the copy it feeds). */
export function approvalStamp(iso: string): string {
  return isoSeconds(iso);
}
