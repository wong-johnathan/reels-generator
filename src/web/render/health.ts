/**
 * S-19 — Failures & health (US-003, US-011/012/013, R-008-3, R-011-2,
 * R-012-1/2/4, R-018-1…3, UX_SPEC IP-07/IP-08/W-09, UI_SPEC §6.10).
 *
 * Server-rendered and complete without JavaScript. The page answers IP-07's
 * five questions for every degraded condition (cause, blocked, still works,
 * system, next action), shows provider presence and qualification without a
 * key value, and lists attempt rows as a debug list — newest first, 50 rows,
 * no totals (D2).
 */
import type { z } from 'zod';

import type { OverviewSchema } from '../../../contract/api.js';
import type { DegradedNotice } from './shell.js';
import { renderChip } from './chip.js';
import { escapeAttr, escapeHtml } from './html.js';
import {
  ATTEMPT_PAGE_SIZE,
  type AttemptsView,
  type HealthSummary,
  type ProviderRow,
} from '../health/model.js';

type Overview = z.infer<typeof OverviewSchema>;

export interface HealthPageInput {
  readonly summary: HealthSummary;
  readonly degraded: readonly DegradedNotice[];
  readonly overview: Overview;
  readonly attempts: AttemptsView;
  readonly now: number;
}

/** IP-07 (e): every degraded state names the operator's next action. */
function nextAction(notice: DegradedNotice): string {
  const cause = notice.cause.toLowerCase();
  if (/postgres|redis|database|queue|migration/.test(cause)) {
    return 'Wait for the self-heal (at most 30 s after the database reports ready); new batches stay rejected until then.';
  }
  if (/minio|asset|storage/.test(cause)) {
    return 'Nothing to do while it is down: stages wait instead of writing to an unready store.';
  }
  if (/disk/.test(cause)) {
    return 'Free space before new renders or image downloads; cleanup preview is a Milestone B surface.';
  }
  if (/provider|image|tts|text|research/.test(cause)) {
    return 'Check the provider block below; if its key is absent, set it in .env and restart.';
  }
  return 'Open the component rows below; nothing new can start until the condition clears.';
}

function renderDegraded(degraded: readonly DegradedNotice[], summary: HealthSummary): string {
  if (degraded.length === 0) {
    return (
      '<section class="health-degraded health-ready" id="health-degraded" data-state="ready" ' +
      'aria-labelledby="health-degraded-heading">' +
      '<h3 id="health-degraded-heading">Service state</h3>' +
      '<p class="health-ready-line" id="health-ready-line">' +
      escapeHtml(summary.readyWord) +
      '. No dependency is degraded; new batches are accepted.' +
      '</p></section>'
    );
  }

  const blocks = degraded
    .map((notice, index) => {
      const terms: Array<[string, string]> = [
        ['Cause', notice.cause],
        ['Blocked', notice.blocked ?? 'Nothing named by the health report'],
        ['Still works', notice.stillWorks ?? 'Not stated by the health report'],
        ['System', notice.system ?? 'Not stated by the health report'],
        ['Next action', nextAction(notice)],
      ];
      const rows = terms
        .map(([term, value]) => '<dt>' + term + '</dt><dd>' + escapeHtml(value) + '</dd>')
        .join('');
      return (
        '<div class="health-degraded-block" data-degraded="' +
        (index === 0 ? 'primary' : 'secondary') +
        '"><dl class="health-degraded-detail">' +
        rows +
        '</dl></div>'
      );
    })
    .join('');

  return (
    '<section class="health-degraded" id="health-degraded" data-state="degraded" ' +
    'aria-labelledby="health-degraded-heading">' +
    '<header class="health-degraded-head">' +
    '<h3 id="health-degraded-heading">Service state</h3>' +
    renderChip('blocked', {
      size: 'md',
      label: summary.ready ? 'Service degraded' : summary.readyWord,
    }) +
    '</header>' +
    blocks +
    (degraded.length > 1
      ? '<p class="health-degraded-more">' +
        (degraded.length - 1) +
        ' more condition' +
        (degraded.length - 1 === 1 ? '' : 's') +
        ' are listed above shell level.</p>'
      : '') +
    '</section>'
  );
}

const PROVIDER_GLYPH: Readonly<Record<ProviderRow['state'], string>> = {
  ok: '✓',
  key_absent: '⊘',
  not_qualified: '⊘',
};

function renderProvider(provider: ProviderRow): string {
  return (
    '<article class="health-provider" data-provider="' +
    escapeAttr(provider.provider) +
    '" data-state="' +
    escapeAttr(provider.state) +
    '">' +
    '<header class="health-provider-head">' +
    '<h4>' +
    escapeHtml(provider.label) +
    '</h4>' +
    '<span class="health-state" data-state="' +
    escapeAttr(provider.state) +
    '"><span class="health-state-glyph" aria-hidden="true">' +
    PROVIDER_GLYPH[provider.state] +
    '</span>' +
    escapeHtml(provider.stateWord) +
    '</span></header>' +
    '<p class="health-provider-detail mono">' +
    escapeHtml(provider.detail) +
    '</p>' +
    '<dl class="health-provider-kv">' +
    '<dt>Key</dt><dd class="mono">' +
    (provider.keyPresent ? 'present' : 'absent') +
    ' · ' +
    escapeHtml(provider.envKey) +
    '</dd>' +
    '<dt>Qualification</dt><dd class="mono">' +
    (provider.qualified
      ? 'passed' + (provider.qualifiedAt === null ? '' : ' ' + escapeHtml(provider.qualifiedAt))
      : 'not run') +
    '</dd>' +
    '<dt>Idempotency</dt><dd class="mono">' +
    (provider.idempotencyProtected ? 'protected' : 'unprotected') +
    '</dd>' +
    (provider.note === null ? '' : '<dt>Note</dt><dd>' + escapeHtml(provider.note) + '</dd>') +
    '</dl></article>'
  );
}

function renderProviders(summary: HealthSummary): string {
  return (
    '<section class="health-section" id="health-providers" aria-labelledby="health-providers-heading">' +
    '<h3 id="health-providers-heading">Providers</h3>' +
    '<div class="health-provider-grid">' +
    summary.providers.map(renderProvider).join('') +
    '</div></section>'
  );
}

function renderQualification(summary: HealthSummary): string {
  const chips = summary.qualification
    .map(
      (row) =>
        '<li class="health-qual" data-provider="' +
        escapeAttr(row.provider) +
        '" data-passed="' +
        (row.passed ? 'true' : 'false') +
        '"><span class="health-qual-label">' +
        escapeHtml(row.label) +
        '</span>' +
        (row.passed
          ? renderChip('done', { size: 'sm', label: row.line })
          : renderChip('not_run', { size: 'sm', label: row.line })) +
        '</li>',
    )
    .join('');
  return (
    '<section class="health-section" id="health-qualification" aria-labelledby="health-qualification-heading">' +
    '<h3 id="health-qualification-heading">Qualification</h3>' +
    '<p class="health-note">A recorded pass/fail check run before integration (R-008-3). Absence of a record reads NOT RUN; it is never treated as a pass.</p>' +
    '<ul class="health-qual-list">' +
    chips +
    '</ul></section>'
  );
}

function renderQueueAndDisk(summary: HealthSummary): string {
  const queue = summary.queue;
  const disk = summary.disk;
  const queueRows =
    queue === null
      ? '<dt>Queue</dt><dd class="health-missing">Queue metrics are not reported by the health endpoint.</dd>'
      : '<dt>Queue</dt><dd class="mono">' +
        escapeHtml(queue.line) +
        '</dd>' +
        (queue.note === null ? '' : '<dt>Note</dt><dd>' + escapeHtml(queue.note) + '</dd>');
  const diskRows =
    disk === null
      ? '<dt>Disk</dt><dd class="health-missing">Disk metrics are not reported by the health endpoint.</dd>'
      : '<dt>Disk</dt><dd><span class="mono">' +
        escapeHtml(disk.line) +
        '</span>' +
        '<progress class="health-disk-meter" max="100" value="' +
        disk.usedPercent +
        '">' +
        disk.usedPercent +
        '% used</progress>' +
        '<span class="health-disk-headroom" data-headroom="' +
        (disk.headroomOk ? 'ok' : 'low') +
        '">' +
        (disk.headroomOk ? 'Headroom ok' : 'Headroom below the safety margin') +
        '</span></dd>' +
        (disk.warning === null
          ? ''
          : '<dt>Warning</dt><dd class="health-warning">' + escapeHtml(disk.warning) + '</dd>');
  return (
    '<section class="health-section" id="health-system" aria-labelledby="health-system-heading">' +
    '<h3 id="health-system-heading">Queue, disk and migration</h3>' +
    '<dl class="health-kv">' +
    queueRows +
    diskRows +
    '<dt>Migration</dt><dd class="mono" data-migration="' +
    escapeAttr(summary.migration.status) +
    '">' +
    escapeHtml(summary.migration.line) +
    '</dd>' +
    '</dl></section>'
  );
}

function renderAttemptRow(row: AttemptsView['rows'][number]): string {
  return (
    '<tr data-attempt="' +
    escapeAttr(row.id) +
    '" data-charge="' +
    escapeAttr(row.chargeTone) +
    '">' +
    '<th scope="row"><span class="health-att-empty mono">' +
    escapeHtml(row.stage) +
    '</span> ' +
    escapeHtml(row.stageLabel) +
    '</th>' +
    '<td class="mono">' +
    escapeHtml(row.provider) +
    '</td>' +
    '<td class="mono">' +
    escapeHtml(row.model) +
    '</td>' +
    '<td class="mono health-att-hash">' +
    escapeHtml(row.promptHash) +
    '</td>' +
    '<td class="mono health-att-req">' +
    escapeHtml(row.requestId) +
    '</td>' +
    '<td class="mono">' +
    escapeHtml(row.attempt) +
    '</td>' +
    '<td class="mono">' +
    escapeHtml(row.idempotency) +
    '</td>' +
    '<td class="health-att-charge" data-charge="' +
    escapeAttr(row.chargeTone) +
    '">' +
    escapeHtml(row.charge) +
    '</td>' +
    '<td class="health-att-status">' +
    escapeHtml(row.status) +
    (row.errorLine === null
      ? ''
      : '<span class="health-att-error">' + escapeHtml(row.errorLine) + '</span>') +
    (row.backoff === null
      ? ''
      : '<span class="health-att-backoff">backoff ' + escapeHtml(row.backoff) + '</span>') +
    '</td>' +
    '<td class="health-att-time"><time datetime="' +
    escapeAttr(row.createdAbsolute) +
    '" title="' +
    escapeAttr(row.createdAbsolute) +
    '">' +
    escapeHtml(row.createdRelative) +
    '</time></td></tr>'
  );
}

function renderAttempts(input: HealthPageInput): string {
  const attempts = input.attempts;
  const videoLinks = input.overview.attention
    .map(
      (item) =>
        '<li' +
        (item.video_id === attempts.videoId ? ' class="health-video-current"' : '') +
        '><a href="' +
        escapeAttr('/health?video=' + encodeURIComponent(item.video_id)) +
        '">' +
        escapeHtml(item.video_label) +
        '</a> <span class="health-video-reason">' +
        escapeHtml(item.attention_reason ?? item.attention_kind) +
        '</span></li>',
    )
    .join('');

  const filter =
    attempts.videoId === null
      ? ''
      : '<form class="health-filter" method="get" action="/health" id="health-filter">' +
        '<input type="hidden" name="video" value="' +
        escapeAttr(attempts.videoId) +
        '">' +
        '<label class="health-filter-label" for="health-stage-filter">Stage</label>' +
        '<select class="health-filter-select" id="health-stage-filter" name="stage">' +
        '<option value="">All stages</option>' +
        attempts.stageOptions
          .map(
            (option) =>
              '<option value="' +
              escapeAttr(option.code) +
              '"' +
              (option.code === attempts.stage ? ' selected' : '') +
              '>' +
              escapeHtml(option.code + ' · ' + option.label) +
              '</option>',
          )
          .join('') +
        '</select>' +
        '<button type="submit" class="btn health-filter-submit" id="health-filter-button">Filter attempts</button>' +
        (attempts.stage === null
          ? ''
          : '<a class="health-filter-clear" href="' +
            escapeAttr('/health?video=' + encodeURIComponent(attempts.videoId)) +
            '">Show all stages</a>') +
        '</form>';

  const rows = attempts.rows.map(renderAttemptRow).join('');
  const body =
    attempts.errorLine !== null
      ? '<tr class="health-att-message"><td colspan="10">' +
        escapeHtml(attempts.errorLine) +
        '</td></tr>'
      : attempts.rows.length === 0
        ? '<tr class="health-att-message"><td colspan="10">' +
          escapeHtml(attempts.emptyLine ?? 'No attempt rows.') +
          '</td></tr>'
        : rows;

  return (
    '<section class="health-section health-attempts" id="health-attempts" aria-labelledby="health-attempts-heading">' +
    '<header class="health-att-head">' +
    '<h3 id="health-attempts-heading">Attempt rows</h3>' +
    '<span class="health-limit mono" id="health-attempt-limit">last ' +
    ATTEMPT_PAGE_SIZE +
    '</span>' +
    (attempts.videoLabel === null
      ? ''
      : '<span class="health-att-video mono" id="health-attempt-video">' +
        escapeHtml(attempts.videoLabel) +
        '</span>') +
    '</header>' +
    '<p class="health-note">Each row is one provider call: provider, model, prompt hash, request id, idempotency and charge status. This is a debug list, not a cost report — no totals are computed (D2), and the attempt row carries no billed-units field, so no units column is shown.</p>' +
    (attempts.videoId === null
      ? '<div class="health-video-picker" id="health-video-picker"><p class="health-picker-line">Choose a video that needs attention:</p><ul class="health-video-list">' +
        (videoLinks.length === 0
          ? '<li class="health-missing">No video needs attention right now.</li>'
          : videoLinks) +
        '</ul></div>'
      : filter) +
    '<p class="health-limit-line mono" id="health-limit-line">' +
    escapeHtml(attempts.limitLine) +
    '</p>' +
    '<div class="health-table-wrap" role="region" aria-label="Attempt rows" tabindex="0">' +
    '<table class="health-attempt-table" data-attempt-rows>' +
    '<caption>Attempt rows — newest first, up to ' +
    ATTEMPT_PAGE_SIZE +
    ' rows, no totals.</caption>' +
    '<thead><tr>' +
    '<th scope="col">Stage</th><th scope="col">Provider</th><th scope="col">Model</th>' +
    '<th scope="col">Prompt hash</th><th scope="col">Request id</th><th scope="col">Attempt</th>' +
    '<th scope="col">Idempotency</th><th scope="col">Charge</th><th scope="col">Status</th>' +
    '<th scope="col">Created</th></tr></thead>' +
    '<tbody>' +
    body +
    '</tbody></table></div>' +
    '</section>'
  );
}

export function renderHealthPage(input: HealthPageInput): string {
  const summary = input.summary;
  return (
    '<div class="health" id="health" data-health data-state="' +
    (summary.ready && input.degraded.length === 0 ? 'ready' : 'degraded') +
    '">' +
    '<header class="health-head">' +
    '<h2 id="health-heading" class="sr-only">Health details</h2>' +
    '<p class="health-checked mono" id="health-checked">' +
    escapeHtml(summary.checkedLine) +
    ' · ' +
    escapeHtml(summary.serviceLine) +
    '</p></header>' +
    renderDegraded(input.degraded, summary) +
    renderProviders(summary) +
    renderQualification(summary) +
    renderQueueAndDisk(summary) +
    renderAttempts(input) +
    '</div>'
  );
}
