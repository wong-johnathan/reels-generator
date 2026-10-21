/**
 * S-21 — Settings (US-004, US-012, R-008-3, R-015-5, UX_SPEC DI-08,
 * UI_SPEC §9.3).
 *
 * Server-rendered, read-only, and deliberately small: key presence, the env
 * key name, qualification pass/fail with its date, and whether the provider
 * honours an idempotency key. No input element exists on this page, so no key
 * value can be typed, echoed or read back.
 */
import type { SettingsModel } from '../settings/model.js';
import { renderChip } from './chip.js';
import { escapeAttr, escapeHtml } from './html.js';

function renderRow(row: SettingsModel['rows'][number]): string {
  return (
    '<tr data-provider="' +
    escapeAttr(row.provider) +
    '" data-key="' +
    (row.keyPresent ? 'present' : 'absent') +
    '" data-qualified="' +
    (row.qualified ? 'true' : 'false') +
    '">' +
    '<th scope="row"><span class="settings-provider">' +
    escapeHtml(row.label) +
    '</span><span class="settings-provider-detail">' +
    escapeHtml(row.detail) +
    '</span></th>' +
    '<td class="settings-key"><span class="settings-key-word" data-key="' +
    (row.keyPresent ? 'present' : 'absent') +
    '">' +
    escapeHtml(row.keyWord) +
    '</span><code class="mono settings-env">' +
    escapeHtml(row.envKey) +
    '</code></td>' +
    '<td class="settings-qual">' +
    (row.qualified
      ? renderChip('done', { size: 'sm', label: row.qualification })
      : renderChip('not_run', { size: 'sm', label: row.qualification })) +
    (row.qualificationAbsolute === null
      ? ''
      : '<time class="mono settings-qual-time" datetime="' +
        escapeAttr(row.qualificationAbsolute) +
        '">' +
        escapeHtml(row.qualificationAbsolute) +
        '</time>') +
    '</td>' +
    '<td class="mono settings-idem">' +
    escapeHtml(row.idempotency) +
    '</td>' +
    '<td class="settings-note">' +
    (row.note === null ? '—' : escapeHtml(row.note)) +
    '</td></tr>'
  );
}

export function renderSettings(model: SettingsModel): string {
  return (
    '<div class="settings" id="settings" data-settings data-read-only="true">' +
    '<header class="settings-head">' +
    '<h2 id="settings-heading" class="sr-only">Provider settings</h2>' +
    '<p class="settings-readonly mono" id="settings-readonly">' +
    escapeHtml(model.readOnlyLine) +
    '</p></header>' +
    '<p class="settings-summary" id="settings-summary" role="status">' +
    escapeHtml(model.summaryLine) +
    '</p>' +
    '<p class="settings-qualification mono" id="settings-qualification">' +
    escapeHtml(model.qualificationLine) +
    '</p>' +
    '<section class="settings-section" id="settings-providers" aria-labelledby="settings-providers-heading">' +
    '<h3 id="settings-providers-heading">Provider keys</h3>' +
    '<div class="settings-table-wrap" role="region" aria-label="Provider key status" tabindex="0">' +
    '<table class="settings-table" data-settings-providers>' +
    '<caption>Provider key presence and qualification — values are never read back.</caption>' +
    '<thead><tr><th scope="col">Provider</th><th scope="col">Key</th>' +
    '<th scope="col">Qualification</th><th scope="col">Idempotency</th><th scope="col">Note</th></tr></thead>' +
    '<tbody>' +
    model.rows.map(renderRow).join('') +
    '</tbody></table></div></section>' +
    '<p class="settings-key-note" id="settings-key-values">' +
    escapeHtml(model.keyValuesLine) +
    '</p>' +
    '<p class="settings-setup" id="settings-setup">' +
    'Provider credentials live in the worker environment. A change takes effect when the worker restarts; ' +
    'the web page never reads a value to confirm it.' +
    '</p></div>'
  );
}
