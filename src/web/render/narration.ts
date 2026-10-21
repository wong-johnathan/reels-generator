/**
 * S-14 — Narration & timing (US-021, US-022, R-009-3, R-009-4, UX_SPEC A-18/
 * A-19, UI_SPEC §9.5/§9.6).
 *
 * Server-rendered and complete without JavaScript: the audio element, the
 * transcript, the band arithmetic, the verdict, the return-to-review link and
 * both commits are decided here. The enhancer (`client/narration.ts`) only
 * follows playback with the word rows and seeks the take.
 *
 * The panel never autoplays (AX-16) and never claims a stretch: a miss is the
 * A-19 sentence, with the contract's own numbers.
 */
import { narrationModel, type NarrationModel, type NarrationView } from '../narration/model.js';
import type { VideoDetail } from '../workspace/model.js';
import { renderChip } from './chip.js';
import { escapeAttr, escapeHtml } from './html.js';
import type { NarrationNotice } from '../narration/notice.js';

export const NARRATION_SCRIPTS: readonly string[] = ['/assets/client/narration.js'];

export type { NarrationNotice };

export interface NarrationPanelInput {
  readonly detail: VideoDetail;
  readonly narration: NarrationView | null;
  /** S-14-1: null in every build today — `audio.get` carries no alignment id. */
  readonly alignmentId?: string | null;
  /** False when the gateway has no accept seam (same gap). */
  readonly acceptWired?: boolean;
  readonly notice?: NarrationNotice | null;
}

function kv(label: string, value: string, mono = true): string {
  return (
    '<div class="narration-kv"><dt>' +
    escapeHtml(label) +
    '</dt><dd' +
    (mono ? ' class="mono"' : '') +
    '>' +
    escapeHtml(value) +
    '</dd></div>'
  );
}

function renderNotice(notice: NarrationNotice | null | undefined): string {
  if (notice === null || notice === undefined) return '';
  return (
    '<div class="narration-notice" role="status" data-notice="' +
    escapeAttr(notice.kind) +
    '"><p>' +
    escapeHtml(notice.message) +
    '</p></div>'
  );
}

function renderEmptyOrBlocked(model: NarrationModel): string {
  const parts: string[] = [];
  // The summary line above already names a blocked reason, a running call or a
  // failure, so the body adds only what those lines cannot say.
  if (model.emptyLine !== null) {
    parts.push(
      '<p class="narration-empty" id="narration-empty">' + escapeHtml(model.emptyLine) + '</p>',
    );
  }
  const needsScript = model.state === 'empty' || model.state === 'blocked';
  if (needsScript) {
    parts.push(
      '<p class="narration-unlock">Approving the script unlocks the image stage and 1 TTS call.</p>',
    );
    parts.push(
      '<p class="narration-empty-action"><a class="btn" href="' +
        escapeAttr(model.scriptHref) +
        '">Go to Script</a></p>',
    );
  }
  return parts.join('');
}

function renderPlayer(model: NarrationModel): string {
  if (model.assetHref === null) {
    return '';
  }
  const duration = model.band?.actualLabel ?? null;
  const label =
    duration === null ? 'Narration audio' : 'Narration, ' + duration.replace(/ s$/, ' seconds');
  const words = model.words === null ? 0 : model.words.totalWords;
  const transcriptCount =
    words > 0 ? 'Transcript — ' + words + ' words with timings' : 'Transcript';
  return (
    '<section class="narration-player" id="narration-player" aria-labelledby="narration-player-heading">' +
    '<h4 id="narration-player-heading">Audio</h4>' +
    '<audio id="narration-audio" class="narration-audio" controls preload="metadata" src="' +
    escapeAttr(model.assetHref) +
    '" aria-label="' +
    escapeAttr(label) +
    '"></audio>' +
    '<p class="narration-transport mono" aria-hidden="true">' +
    '<span data-narration-position>00:00.0</span>' +
    '<span class="narration-transport-sep"> / </span>' +
    '<span data-narration-total>' +
    escapeHtml(duration ?? '—') +
    '</span>' +
    '</p>' +
    '<p class="narration-transcript-link"><a href="#narration-timings">' +
    escapeHtml(transcriptCount) +
    '</a></p>' +
    '<p class="narration-note">Playback never starts on its own. The word timings below follow the audio as it plays.</p>' +
    '</section>'
  );
}

function renderBand(model: NarrationModel): string {
  const band = model.band;
  if (band === null || band.actualLabel === null) return '';
  const rows: string[] = [];
  rows.push(kv('Actual', band.actualLabel));
  rows.push(kv('Target', band.targetLabel));
  rows.push(kv('Band', band.bandLabel));
  rows.push(kv('Tolerance', band.toleranceLabel));
  if (band.deviationLabel !== null) rows.push(kv('Deviation', band.deviationLabel));

  const callout =
    band.sentence === null
      ? ''
      : '<div class="narration-out-of-band" id="narration-out-of-band" role="note">' +
        '<p class="narration-out-of-band-sentence" id="narration-band-sentence">' +
        escapeHtml(band.sentence) +
        '</p>' +
        (model.returnHref === null
          ? ''
          : '<p class="narration-out-of-band-action"><a class="btn" href="' +
            escapeAttr(model.returnHref) +
            '">Return to script review</a></p>') +
        '</div>';

  return (
    '<section class="narration-band" id="narration-band" aria-labelledby="narration-band-heading">' +
    '<h4 id="narration-band-heading">Duration vs target</h4>' +
    '<dl class="narration-band-dl">' +
    rows.join('') +
    '</dl>' +
    '<p class="narration-verdict mono" id="narration-verdict" data-verdict="' +
    (band.withinBand ? 'within' : 'outside') +
    '">' +
    escapeHtml(band.verdict) +
    '</p>' +
    callout +
    '</section>'
  );
}

function renderTimings(model: NarrationModel): string {
  const words = model.words;
  if (words === null) return '';
  const body =
    words.rows.length === 0
      ? '<p class="narration-words-empty" id="narration-words-empty">No word timings were derived for this take.</p>'
      : '<div class="narration-table-wrap" id="narration-table-region" role="region" ' +
        'aria-labelledby="narration-timings-heading" tabindex="0">' +
        '<table class="narration-words" data-narration-words>' +
        '<caption>' +
        escapeHtml(
          'Derived word timings — ' + words.totalWords + ' words, from the character alignment.',
        ) +
        '</caption>' +
        '<thead><tr><th scope="col">Start</th><th scope="col">Word</th><th scope="col">Span</th></tr></thead>' +
        '<tbody>' +
        words.rows
          .map(
            (row) =>
              '<tr data-word-index="' +
              row.index +
              '" data-word-start="' +
              row.startMs +
              '" data-word-end="' +
              row.endMs +
              '"><td class="mono narration-time">' +
              escapeHtml(row.startLabel) +
              '</td><th scope="row" class="narration-word">' +
              escapeHtml(row.word) +
              '</th><td class="mono narration-span">' +
              escapeHtml(row.spanLabel) +
              '</td></tr>',
          )
          .join('') +
        '</tbody></table></div>';

  return (
    '<section class="narration-timings" id="narration-timings" aria-labelledby="narration-timings-heading">' +
    '<h4 id="narration-timings-heading">Word timings</h4>' +
    '<p class="narration-coverage mono" id="narration-coverage">' +
    escapeHtml(words.coverageLine) +
    (words.firstLabel === null || words.lastLabel === null
      ? ''
      : ' · ' + escapeHtml(words.firstLabel) + '–' + escapeHtml(words.lastLabel)) +
    '</p>' +
    (words.monotonicLine === null
      ? ''
      : '<p class="narration-monotonic" id="narration-monotonic" role="note">' +
        escapeHtml(words.monotonicLine) +
        '</p>') +
    body +
    '</section>'
  );
}

function renderProvenance(model: NarrationModel): string {
  if (model.alignmentLines.length === 0) return '';
  return (
    '<section class="narration-provenance" id="narration-provenance" aria-labelledby="narration-provenance-heading">' +
    '<h4 id="narration-provenance-heading">Alignment provenance</h4>' +
    '<dl class="narration-provenance-dl">' +
    model.alignmentLines.map(([label, value]) => kv(label, value)).join('') +
    '</dl>' +
    '</section>'
  );
}

function renderAccept(model: NarrationModel): string {
  const accept = model.accept;
  if (!accept.visible && accept.acceptedLine === null) return '';
  const heading = '<h4 id="narration-accept-heading">Accept timing</h4>';

  if (accept.acceptedLine !== null) {
    return (
      '<div class="narration-accept" id="narration-accept" data-accept="accepted" aria-labelledby="narration-accept-heading">' +
      heading +
      '<p class="narration-accepted mono" id="narration-accepted">' +
      escapeHtml(accept.acceptedLine) +
      '</p></div>'
    );
  }

  const state = accept.enabled
    ? 'ready'
    : model.band !== null && !model.band.withinBand
      ? 'out_of_band'
      : 'unwired';
  const reason =
    accept.reason === null
      ? ''
      : '<p class="narration-reason" id="narration-accept-reason">' +
        escapeHtml(accept.reason) +
        '</p>';
  const control = accept.enabled
    ? '<form class="narration-accept-form" method="post" action="' +
      escapeAttr('/videos/' + encodeURIComponent(model.videoId) + '/audio/accept') +
      '">' +
      '<input type="hidden" name="alignment_id" value="' +
      escapeAttr(model.alignmentId ?? '') +
      '">' +
      '<button type="submit" class="btn btn-primary narration-accept-button">Accept timing</button>' +
      '</form>'
    : '<button type="button" class="btn narration-accept-button" disabled aria-disabled="true">Accept timing</button>';

  return (
    '<div class="narration-accept" id="narration-accept" data-accept="' +
    state +
    '" aria-labelledby="narration-accept-heading">' +
    heading +
    reason +
    control +
    '</div>'
  );
}

function renderRerun(model: NarrationModel): string {
  const rerun = model.rerun;
  if (!rerun.visible) return '';
  const heading = '<h4 id="narration-rerun-heading">Re-run narration</h4>';
  const action = '/videos/' + encodeURIComponent(model.videoId) + '/audio/rerun';

  if (!rerun.enabled) {
    return (
      '<div class="narration-spend" id="narration-spend" data-rerun="disabled" aria-labelledby="narration-rerun-heading">' +
      heading +
      '<button type="submit" class="btn narration-rerun-button" disabled aria-disabled="true">' +
      escapeHtml(rerun.label) +
      '</button>' +
      (rerun.reason === null
        ? ''
        : '<p class="narration-reason" id="narration-rerun-reason">' +
          escapeHtml(rerun.reason) +
          '</p>') +
      '</div>'
    );
  }

  return (
    '<div class="narration-spend" id="narration-spend" data-rerun="enabled" aria-labelledby="narration-rerun-heading">' +
    heading +
    '<details class="narration-rerun" data-rerun-details>' +
    '<summary class="btn narration-rerun-summary" data-rerun-summary>' +
    escapeHtml(rerun.label) +
    '</summary>' +
    '<div class="narration-rerun-body">' +
    '<p class="narration-rerun-scope" id="narration-rerun-scope">' +
    escapeHtml(rerun.scopeLine) +
    '</p>' +
    '<form class="narration-rerun-form" method="post" action="' +
    escapeAttr(action) +
    '">' +
    '<label for="narration-rerun-reason-input">Reason (optional)</label>' +
    '<input type="text" id="narration-rerun-reason-input" name="reason" maxlength="500" autocomplete="off">' +
    '<button type="submit" class="btn btn-primary narration-rerun-confirm">Re-run narration · ' +
    escapeHtml(rerun.callLine) +
    '</button>' +
    '</form>' +
    '<button type="button" class="btn narration-rerun-cancel" data-close>Cancel</button>' +
    '</div>' +
    '</details>' +
    '</div>'
  );
}

export function renderNarrationPanel(input: NarrationPanelInput): string {
  const model = narrationModel({
    detail: input.detail,
    narration: input.narration,
    alignmentId: input.alignmentId ?? null,
    acceptWired: input.acceptWired ?? false,
  });

  const isTake =
    model.state === 'ready' || model.state === 'out_of_band' || model.state === 'stale';
  const summary =
    model.summaryLine === null
      ? ''
      : '<p class="narration-summary mono" id="narration-summary">' +
        escapeHtml(model.summaryLine) +
        '</p>';
  const detailLine =
    model.detailLine === null
      ? ''
      : '<p class="narration-detail" id="narration-detail">' +
        escapeHtml(model.detailLine) +
        '</p>';
  const stale =
    model.staleLine === null
      ? ''
      : '<p class="narration-stale" id="narration-stale" role="note">' +
        escapeHtml(model.staleLine) +
        '</p>';
  const body = isTake
    ? '<div class="narration-grid">' +
      renderPlayer(model) +
      renderBand(model) +
      '</div>' +
      renderTimings(model) +
      renderProvenance(model)
    : renderEmptyOrBlocked(model);

  return (
    '<section class="narration" id="narration" data-narration data-state="' +
    escapeAttr(model.state) +
    '" data-video-id="' +
    escapeAttr(input.detail.id) +
    '" aria-labelledby="narration-heading">' +
    renderNotice(input.notice) +
    '<header class="narration-head">' +
    '<h3 id="narration-heading">' +
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
    '<footer class="narration-actions" id="narration-actions">' +
    renderAccept(model) +
    renderRerun(model) +
    '<p class="narration-band-note" id="narration-band-note">' +
    'Approvals need a screen 1024 px or wider. This view is monitoring only.' +
    '</p>' +
    '</footer>' +
    '</section>'
  );
}
