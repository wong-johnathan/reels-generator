/**
 * S-04 Series editor (UX_SPEC §2.3/§4 IP-02, A-4/A-5/D-2/D-3; UI_SPEC §4.3,
 * §5 UC-17/UC-19/UC-20, §6.1 S-04 states, §8.1).
 *
 * The whole screen is in the HTML: five labelled field blocks, the IP-02
 * commit panel with its change summary, per-field changed marks, the archived
 * read-only state, the IP-09 conflict banner and the post-redirect
 * confirmation. `client/seriesEditor.ts` only re-computes the marks while the
 * operator types and names the mint in flight.
 */
import { isoSeconds } from '../format.js';
import { commitState } from '../series/commit.js';
import { BLOCKS, createSummary, FIELDS, type FieldSpec } from '../series/fields.js';
import type { SeriesEditorModel } from '../series/model.js';
import { escapeAttr, escapeHtml } from './html.js';

export interface SeriesEditorParts {
  /** The form and its banners — the content column. */
  readonly main: string;
  /** The IP-02 commit panel — the aside column. */
  readonly aside: string;
}

const keyOf = (path: string): string => path.replace(/[^a-z0-9]+/gi, '-');
const fieldId = (path: string): string => 'field-' + keyOf(path);
const helpId = (path: string): string => 'help-' + keyOf(path);
const errorId = (path: string): string => 'error-' + keyOf(path);

function describedBy(field: FieldSpec, hasError: boolean): string {
  return hasError ? helpId(field.path) + ' ' + errorId(field.path) : helpId(field.path);
}

function changedMark(path: string, changed: boolean): string {
  const hidden = changed ? '' : ' hidden';
  return (
    '<span class="series-changed" data-changed-for="' +
    escapeAttr(path) +
    '"' +
    hidden +
    '>Changed</span>'
  );
}

function controlAttributes(field: FieldSpec, model: SeriesEditorModel): string {
  const hasError = model.errors[field.path] !== undefined;
  const disabled = model.status === 'archived';
  const initial = model.initial[field.path] ?? '';
  return (
    ' id="' +
    fieldId(field.path) +
    '"' +
    ' name="' +
    escapeAttr(field.path) +
    '"' +
    ' data-field="' +
    escapeAttr(field.path) +
    '"' +
    ' data-kind="' +
    field.kind +
    '"' +
    ' data-initial="' +
    escapeAttr(initial) +
    '"' +
    ' aria-describedby="' +
    describedBy(field, hasError) +
    '"' +
    (hasError ? ' aria-invalid="true"' : '') +
    (field.required === true && model.mode === 'create' ? ' required' : '') +
    (disabled ? ' disabled' : '')
  );
}

function controlMarkup(field: FieldSpec, model: SeriesEditorModel, attributes: string): string {
  const value = model.values[field.path] ?? '';
  switch (field.kind) {
    case 'textarea':
    case 'lines': {
      const rows = field.rows ?? 3;
      const readonly = model.status === 'archived' ? ' readonly' : '';
      return (
        '<textarea class="series-control" rows="' +
        rows +
        '"' +
        attributes +
        readonly +
        '>' +
        escapeHtml(value) +
        '</textarea>'
      );
    }
    case 'number': {
      const readonly = model.status === 'archived' ? ' readonly' : '';
      return (
        '<div class="series-control-wrap">' +
        '<input class="series-control" type="number" inputmode="decimal"' +
        (field.min === undefined ? '' : ' min="' + field.min + '"') +
        (field.max === undefined ? '' : ' max="' + field.max + '"') +
        (field.step === undefined ? '' : ' step="' + field.step + '"') +
        attributes +
        readonly +
        ' value="' +
        escapeAttr(value) +
        '">' +
        (field.unit === undefined
          ? ''
          : '<span class="series-unit" aria-hidden="true">' + field.unit + '</span>') +
        '</div>'
      );
    }
    case 'select': {
      const options = (field.options ?? [])
        .map(
          (option) =>
            '<option value="' +
            escapeAttr(option.value) +
            '"' +
            (option.value === value ? ' selected' : '') +
            '>' +
            escapeHtml(option.label) +
            '</option>',
        )
        .join('');
      return '<select class="series-control"' + attributes + '>' + options + '</select>';
    }
    case 'checkbox': {
      return (
        '<input class="series-check" type="checkbox" value="true"' +
        attributes +
        (value === 'true' ? ' checked' : '') +
        '>'
      );
    }
    case 'radio':
      // Radios are a group; rendered by radioGroup().
      return '';
    default: {
      const readonly = model.status === 'archived' ? ' readonly' : '';
      return (
        '<input class="series-control" type="text"' +
        attributes +
        readonly +
        ' value="' +
        escapeAttr(value) +
        '">'
      );
    }
  }
}

function fieldMarkup(field: FieldSpec, model: SeriesEditorModel): string {
  if (field.kind === 'radio') return radioGroup(field, model);

  const changed = model.changed.some((change) => change.path === field.path);
  const error = model.errors[field.path];
  const attributes = controlAttributes(field, model);

  return (
    '<div class="series-field" data-field-row="' +
    escapeAttr(field.path) +
    '" data-changed="' +
    (changed ? 'true' : 'false') +
    '">' +
    '<div class="series-label-row">' +
    '<label class="series-label" for="' +
    fieldId(field.path) +
    '">' +
    escapeHtml(field.label) +
    '</label>' +
    changedMark(field.path, changed) +
    '</div>' +
    '<div class="series-control-cell">' +
    controlMarkup(field, model, attributes) +
    '<p class="series-help" id="' +
    helpId(field.path) +
    '">' +
    escapeHtml(field.helper) +
    '</p>' +
    (error === undefined
      ? ''
      : '<p class="series-field-error" id="' +
        errorId(field.path) +
        '"><span aria-hidden="true">⚠</span> ' +
        escapeHtml(error) +
        '</p>') +
    '</div>' +
    '</div>'
  );
}

function radioGroup(field: FieldSpec, model: SeriesEditorModel): string {
  const value = model.values[field.path] ?? '';
  const initial = model.initial[field.path] ?? '';
  const changed = model.changed.some((change) => change.path === field.path);
  const error = model.errors[field.path];
  const disabled = model.status === 'archived';

  const options = (field.options ?? []).map((option, index) => {
    const id = index === 0 ? fieldId(field.path) : fieldId(field.path) + '-' + option.value;
    const help = index === 0 ? helpId(field.path) : helpId(field.path) + '-' + option.value;
    const selected = value === option.value;
    return (
      '<div class="series-radio-option" data-field-row="' +
      escapeAttr(field.path) +
      '" data-changed="' +
      (changed ? 'true' : 'false') +
      '">' +
      '<input class="series-radio" type="radio" id="' +
      id +
      '" name="' +
      escapeAttr(field.path) +
      '" value="' +
      escapeAttr(option.value) +
      '" data-field="' +
      escapeAttr(field.path) +
      '" data-kind="radio" data-initial="' +
      escapeAttr(initial) +
      '" aria-describedby="' +
      (error === undefined ? help : help + ' ' + errorId(field.path)) +
      '"' +
      (error === undefined ? '' : ' aria-invalid="true"') +
      (selected ? ' checked' : '') +
      (disabled ? ' disabled' : '') +
      '>' +
      (index === 0 ? changedMark(field.path, changed) : '') +
      '<label class="series-radio-label" for="' +
      id +
      '">' +
      escapeHtml(option.label) +
      '</label>' +
      '<p class="series-help" id="' +
      help +
      '">' +
      escapeHtml(option.helper) +
      '</p>' +
      '</div>'
    );
  });

  return (
    '<div class="series-field series-field-group" role="radiogroup" aria-labelledby="mode-label"' +
    ' data-field-row="' +
    escapeAttr(field.path) +
    '" data-changed="' +
    (changed ? 'true' : 'false') +
    '">' +
    '<p class="series-label" id="mode-label">' +
    escapeHtml(field.label) +
    '</p>' +
    '<div class="series-control-cell">' +
    options.join('') +
    (error === undefined
      ? ''
      : '<p class="series-field-error" id="' +
        errorId(field.path) +
        '"><span aria-hidden="true">⚠</span> ' +
        escapeHtml(error) +
        '</p>') +
    '</div>' +
    '</div>'
  );
}

function renderForm(model: SeriesEditorModel): string {
  const action =
    model.mode === 'create' ? '/series' : '/series/' + escapeAttr(model.detail?.id ?? '');
  const currentVersion = model.conflict?.currentVersion ?? model.detail?.current_version ?? 0;

  const blocks = BLOCKS.map((block) => {
    const fields = FIELDS.filter((field) => field.block === block.id)
      .map((field) => fieldMarkup(field, model))
      .join('');
    // The advanced block is the only one collapsed away, because its defaults
    // are fine and the primary form stays short; it must remain a disclosure so
    // nothing is lost, not a fieldset that competes with the primary inputs.
    if (block.id === 'advanced') {
      return (
        '<details class="series-block series-advanced"><summary>' +
        escapeHtml(block.title) +
        '</summary><div class="series-fields">' +
        fields +
        '</div></details>'
      );
    }
    return (
      '<fieldset class="series-block"><legend>' +
      escapeHtml(block.title) +
      '</legend><div class="series-fields">' +
      fields +
      '</div></fieldset>'
    );
  }).join('');

  const revision =
    model.mode === 'edit'
      ? '<input type="hidden" name="revision" value="' +
        (model.conflict?.currentRevision ?? model.detail?.revision ?? 1) +
        '">'
      : '';

  const archived = model.status === 'archived' ? ' aria-readonly="true"' : '';

  return (
    '<form class="series-form" id="series-form" method="post" action="' +
    action +
    '" novalidate data-series-form data-mode="' +
    model.mode +
    '" data-current-version="' +
    currentVersion +
    '" data-in-flight-batches="' +
    (model.inFlightBatches ?? 0) +
    (model.inFlightVideos === undefined || model.inFlightVideos === null
      ? ''
      : '" data-in-flight-videos="' + model.inFlightVideos) +
    '"' +
    archived +
    '>' +
    revision +
    blocks +
    '</form>'
  );
}

function renderPanel(model: SeriesEditorModel): string {
  const currentVersion = model.conflict?.currentVersion ?? model.detail?.current_version ?? 0;
  const state = commitState({
    mode: model.mode,
    currentVersion,
    changed: model.changed,
    ...(model.inFlightBatches === undefined ? {} : { inFlightBatches: model.inFlightBatches }),
    ...(model.inFlightVideos === undefined ? {} : { inFlightVideos: model.inFlightVideos }),
    ...(model.createReady === undefined ? {} : { createReady: model.createReady }),
    archived: model.status === 'archived',
  });

  const summaryItems =
    model.mode === 'create'
      ? createSummary(model.values).map((row) => ({
          path: row.path,
          text: row.label + ': ' + (row.value.trim().length === 0 ? '(empty)' : row.value),
          hidden: false,
        }))
      : FIELDS.map((field) => {
          const change = model.changed.find((candidate) => candidate.path === field.path);
          return {
            path: field.path,
            text: change === undefined ? '' : change.label + ': ' + change.from + ' → ' + change.to,
            hidden: change === undefined,
          };
        });

  const summary = summaryItems
    .map(
      (item) =>
        '<li data-summary-for="' +
        escapeAttr(item.path) +
        '"' +
        (item.hidden ? ' hidden' : '') +
        '>' +
        (item.hidden ? '' : escapeHtml(item.text)) +
        '</li>',
    )
    .join('');

  const button =
    model.status === 'archived'
      ? ''
      : '<button class="btn btn-primary series-save" type="submit" form="series-form"' +
        ' data-commit-button' +
        (state.saveDisabled ? ' disabled' : '') +
        (state.reason.length > 0 ? ' aria-describedby="commit-reason"' : '') +
        '><span class="spinner" data-spinner hidden aria-hidden="true"></span>' +
        '<span data-commit-label>' +
        escapeHtml(state.saveLabel) +
        '</span></button>';

  const versionAt = state.lead.lastIndexOf(state.version);
  const leadPrefix = versionAt === -1 ? state.lead : state.lead.slice(0, versionAt);
  const leadSuffix = versionAt === -1 ? '' : state.lead.slice(versionAt + state.version.length);

  const parts = [
    '<h2 class="series-commit-heading" id="commit-heading">Version commit</h2>',
    '<p class="series-commit-lead">' +
      escapeHtml(leadPrefix) +
      '<strong class="mono" data-commit-version>' +
      escapeHtml(state.version) +
      '</strong>' +
      escapeHtml(leadSuffix) +
      '</p>',
    '<p class="series-commit-body" data-commit-body>' + escapeHtml(state.body) + '</p>',
    '<h3 class="series-change-heading">What changed</h3>',
    '<ul class="series-summary">' + summary + '</ul>',
    model.mode === 'create'
      ? ''
      : '<p class="series-change-empty" data-change-empty' +
        (model.changed.length > 0 ? ' hidden' : '') +
        '>No changes</p>',
    button,
    model.status === 'archived'
      ? ''
      : '<noscript><p class="series-noscript">Saving a series needs JavaScript in this ' +
        'browser.</p></noscript>',
    '<p class="series-commit-reason" id="commit-reason" data-commit-reason' +
      (state.reason.length === 0 ? ' hidden' : '') +
      '>' +
      escapeHtml(state.reason) +
      '</p>',
  ].filter((part) => part.length > 0);

  return (
    '<section class="series-commit" aria-labelledby="commit-heading">' +
    parts.join('\n') +
    '</section>'
  );
}

export function renderSeriesEditor(model: SeriesEditorModel): SeriesEditorParts {
  const effectiveVersion = model.conflict?.currentVersion ?? model.detail?.current_version ?? 0;
  const savedVersion = model.savedVersion;
  const showSaved = savedVersion !== undefined && savedVersion === effectiveVersion;

  const archived =
    model.status === 'archived'
      ? '<section class="series-archived" aria-label="Archived series">' +
        'Archived series cannot be edited or used for new batches.</section>'
      : '';

  const conflict =
    model.conflict === undefined
      ? ''
      : '<section class="series-conflict" aria-labelledby="conflict-heading">' +
        '<h2 id="conflict-heading">Save conflict</h2>' +
        '<p>This series was saved by another tab at ' +
        escapeHtml(isoSeconds(model.conflict.savedAt)) +
        ' (revision ' +
        model.conflict.currentRevision +
        '). Your revision ' +
        model.conflict.yourRevision +
        ' was not saved. Nothing was overwritten.</p>' +
        '<p class="series-conflict-note">Your edits are still in the form below. Saving again ' +
        'keeps them and mints the next version.</p>' +
        '<a class="btn" href="/series/' +
        escapeAttr(model.detail?.id ?? '') +
        '">Discard mine</a>' +
        '</section>';

  const saved =
    showSaved && savedVersion !== undefined
      ? '<p class="series-saved" data-saved-version="' +
        savedVersion +
        '" data-message="' +
        escapeAttr(
          'Saved as v' +
            savedVersion +
            '.' +
            ((model.inFlightBatches ?? 0) > 0 || (model.inFlightVideos ?? 0) > 0
              ? ' Existing projects and their assets are untouched.'
              : ''),
        ) +
        '">Saved as v' +
        savedVersion +
        '</p>'
      : '';

  const unchanged =
    model.unchanged === true
      ? '<p class="series-unchanged">No changes. Nothing was saved.</p>'
      : '';

  const saveError =
    model.saveError === undefined
      ? ''
      : '<section class="series-save-error" role="alert"><h2 class="sr-only">Save failed</h2>' +
        '<p>' +
        escapeHtml(model.saveError) +
        '</p></section>';

  const meta =
    model.mode === 'create'
      ? '<p class="series-meta"><span class="series-version mono" data-version="1">' +
        '<span class="sr-only">first version </span>v1</span>' +
        '<span class="series-meta-item">not saved yet</span></p>'
      : (() => {
          const detail = model.detail;
          if (detail === undefined) return '';
          const batches =
            model.inFlightBatches === undefined || model.inFlightBatches === null
              ? ''
              : '<span class="series-meta-item">' +
                model.inFlightBatches +
                ' ' +
                (model.inFlightBatches === 1 ? 'open batch' : 'open batches') +
                '</span>';
          return (
            '<p class="series-meta">' +
            '<span class="series-version mono" data-version="' +
            effectiveVersion +
            '"><span class="sr-only">current version </span>v' +
            effectiveVersion +
            '</span>' +
            '<span class="series-meta-item">' +
            escapeHtml(detail.mode) +
            '</span>' +
            '<span class="series-meta-item mono">' +
            detail.target_duration_s +
            ' s</span>' +
            '<span class="series-meta-item mono">' +
            escapeHtml(detail.default_aspect_ratio) +
            '</span>' +
            batches +
            '</p>'
          );
        })();

  const main =
    '<section class="series-editor" aria-label="Series profile">' +
    archived +
    conflict +
    saved +
    unchanged +
    saveError +
    meta +
    renderForm(model) +
    '</section>';

  return { main, aside: renderPanel(model) };
}
