/**
 * S-11 — storyboard review (UX_SPEC §6 S-11, US-018; R-009-2, R-004-1,
 * R-013-1; UI_SPEC §5 UC-02/UC-04, §8.4 focus order).
 *
 * Server-rendered and complete without JavaScript: the scene count against the
 * target, every scene's narration span, prompt, protagonist reference, camera
 * move and state are decided here. The optional storyboard gate is a plain
 * form; nothing on this page spends a provider call, and nothing is invented
 * when the split has not happened (each state says why in words).
 */
import { STAGE_LABELS } from '../../shared/stages.js';
import { isoSeconds } from '../format.js';
import {
  CAMERA_MOVE_LABELS,
  storyboardRows,
  storyboardState,
  type StoryboardStageInput,
  type StoryboardView,
} from '../scenes/model.js';
import type { VideoDetail } from '../workspace/model.js';
import { renderChip } from './chip.js';
import { escapeAttr, escapeHtml } from './html.js';

export interface StoryboardInput {
  readonly detail: VideoDetail;
  readonly storyboard: StoryboardView | null;
}

const NO_STAGE: StoryboardStageInput = {
  state: 'not_run',
  attempts: { count: 0, max_attempts: 3, last_error_class: null },
  blocked_reason: null,
};

function sbStage(detail: VideoDetail): StoryboardStageInput {
  const stage = detail.stages.find((row) => row.stage === 'SB');
  if (stage === undefined) return NO_STAGE;
  return {
    state: stage.state,
    attempts: {
      count: stage.attempts.count,
      max_attempts: stage.attempts.max_attempts,
      last_error_class: stage.attempts.last_error_class,
    },
    blocked_reason: stage.blocked_reason,
  };
}

function scriptHref(detail: VideoDetail): string {
  return '/videos/' + encodeURIComponent(detail.id) + '/script';
}

function scenesHref(detail: VideoDetail): string {
  return '/videos/' + encodeURIComponent(detail.id) + '/scenes';
}

function renderHead(detail: VideoDetail, state: string, count: string, gate: string): string {
  return (
    '<header class="storyboard-head">' +
    '<div class="storyboard-heading">' +
    '<h2 class="storyboard-title">' +
    escapeHtml(STAGE_LABELS.SB) +
    '</h2>' +
    renderChip(sbStage(detail).state, { size: 'md' }) +
    '<p class="storyboard-count mono" data-storyboard-count>' +
    escapeHtml(count) +
    '</p>' +
    '</div>' +
    gate +
    '</header>' +
    '<p class="sr-only" data-storyboard-state="' +
    escapeAttr(state) +
    '"></p>'
  );
}

function renderGate(detail: VideoDetail, storyboard: StoryboardView): string {
  if (storyboard.approved) {
    return (
      '<p class="storyboard-approved" data-storyboard-approved>' +
      'Approved rev ' +
      storyboard.revision +
      (storyboard.approved_at === null
        ? ''
        : ' · ' + escapeHtml(isoSeconds(storyboard.approved_at))) +
      ' <span class="storyboard-gate-note">optional gate</span>' +
      '</p>'
    );
  }
  return (
    '<p class="storyboard-monitoring-note">Approvals need a screen 1024 px or wider. This view is monitoring only.</p>' +
    '<form class="storyboard-approve" method="post" action="' +
    escapeAttr('/videos/' + encodeURIComponent(detail.id) + '/storyboard/approve') +
    '">' +
    '<input type="hidden" name="revision" value="' +
    storyboard.revision +
    '">' +
    '<button class="btn btn-primary" type="submit" data-approve-storyboard>' +
    'Approve storyboard <span class="btn-sub">· optional gate</span>' +
    '</button>' +
    '</form>'
  );
}

function renderTable(detail: VideoDetail, storyboard: StoryboardView): string {
  const rows = storyboardRows(storyboard, detail.id)
    .map(
      (row) =>
        '<tr data-scene-no="' +
        escapeAttr(row.no) +
        '">' +
        '<td data-label="Scene"><a class="storyboard-scene mono" data-scene-link href="' +
        escapeAttr(row.href) +
        '">' +
        escapeHtml(row.no) +
        '</a></td>' +
        '<td data-label="Narration" class="mono">' +
        (row.span === null ? '—' : escapeHtml(row.span)) +
        '</td>' +
        '<td data-label="Prompt" class="storyboard-prompt">' +
        escapeHtml(row.prompt) +
        '</td>' +
        '<td data-label="Protagonist">' +
        escapeHtml(row.protagonist) +
        '</td>' +
        '<td data-label="Camera">' +
        escapeHtml(row.camera) +
        '</td>' +
        '<td data-label="State">' +
        renderChip(row.state, { size: 'sm' }) +
        '</td>' +
        '</tr>',
    )
    .join('');
  return (
    '<table class="storyboard-table">' +
    '<caption class="sr-only">Storyboard scenes: scene, narration span, prompt, protagonist reference, camera move and image state</caption>' +
    '<thead><tr>' +
    '<th scope="col">Scene</th><th scope="col">Narration</th><th scope="col">Prompt</th>' +
    '<th scope="col">Protagonist</th><th scope="col">Camera</th><th scope="col">State</th>' +
    '</tr></thead>' +
    '<tbody>' +
    rows +
    '</tbody>' +
    '</table>'
  );
}

export function renderStoryboard(input: StoryboardInput): string {
  const { detail, storyboard } = input;
  const stage = sbStage(detail);
  const state = storyboardState({ storyboard, stage });
  const videoId = escapeAttr(detail.id);
  const open = '<section class="storyboard" data-storyboard data-video-id="' + videoId + '"';

  if (state === 'empty') {
    const reason =
      stage.blocked_reason === null
        ? 'The split runs after the script is approved.'
        : 'Blocked: ' + stage.blocked_reason + '.';
    return (
      open +
      ' data-state="empty">' +
      renderHead(
        detail,
        'empty',
        detail.scene_count + ' scenes · target ' + detail.scene_count,
        '',
      ) +
      '<p class="storyboard-empty-line">No storyboard yet. Approve the script first.</p>' +
      '<p class="storyboard-reason">' +
      escapeHtml(reason) +
      '</p>' +
      '<p><a class="btn" href="' +
      escapeAttr(scriptHref(detail)) +
      '">Go to Script</a></p>' +
      '</section>'
    );
  }

  if (state === 'splitting') {
    return (
      open +
      ' data-state="splitting">' +
      renderHead(detail, 'splitting', 'splitting the script into scenes', '') +
      '<p class="storyboard-splitting mono">Splitting the script into scenes…</p>' +
      '<p>The scene list appears when the split completes; narration spans appear when the split completes.</p>' +
      '<p>No image call is made by this stage.</p>' +
      '<p><a class="btn" href="' +
      escapeAttr(scenesHref(detail)) +
      '">Go to Scenes</a></p>' +
      '</section>'
    );
  }

  if (state === 'failed') {
    const errorClass = stage.attempts.last_error_class ?? null;
    return (
      open +
      ' data-state="failed">' +
      renderHead(detail, 'failed', 'no scenes yet', '') +
      '<p class="storyboard-failure">The storyboard could not be generated after ' +
      stage.attempts.count +
      ' attempts.</p>' +
      (errorClass === null
        ? ''
        : '<p class="mono">Last error class: ' + escapeHtml(errorClass) + '</p>') +
      '<p>Nothing downstream has run. A retry is offered on the failure panel (IP-06), where its scope is named before any call is made.</p>' +
      '</section>'
    );
  }

  const board = storyboard!;
  return (
    open +
    ' data-state="ready">' +
    renderHead(
      detail,
      'ready',
      board.scene_count + ' scenes · target ' + board.target_scene_count,
      renderGate(detail, board),
    ) +
    '<p class="storyboard-note">Editing one prompt in S-13 affects that scene only (R-007-1). Scene ids stay stable across replace and reorder (R-007-2).' +
    ' Camera moves read from the storyboard: ' +
    escapeHtml([...new Set(storyboardRows(board, detail.id).map((row) => row.camera))].join(', ')) +
    '.</p>' +
    renderTable(detail, board) +
    '</section>'
  );
}

/** Re-exported so the client test can assert SSR/enhancer parity on camera words. */
export { CAMERA_MOVE_LABELS };
