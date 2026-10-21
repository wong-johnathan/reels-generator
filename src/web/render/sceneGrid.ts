/**
 * S-12 — the 17-tile scene grid, the first-three checkpoint and the selection
 * bar (UI_SPEC §5 UC-07/UC-08/UC-10, §6.7 W-06; UX_SPEC W-06, A-15/A-16,
 * PRD §10; R-007-1/2, R-006-3, R-013-1).
 *
 * Server-rendered and complete without JavaScript: the header counts, the
 * checkpoint copy with its release control, every tile's state chip, pin,
 * narration span, alt text and accessible name are decided here. The enhancer
 * adds only selection and its announcement.
 *
 * The grid always renders the target number of tiles: rows the storyboard has
 * not produced are explicit "not started" placeholders, so the count is never
 * a surprise (W-06). Tiles are never disabled — a scene held by the checkpoint
 * opens S-13, where the replace control carries the reason.
 */
import {
  checkpointState,
  gridCounts,
  gridCountText,
  RELEASE_UNWIRED_REASON,
  releaseLabel,
  releaseSubLabel,
  REORDER_NOTE,
  sceneTiles,
  type Checkpoint,
  type StoryboardView,
} from '../scenes/model.js';
import type { VideoDetail } from '../workspace/model.js';
import { renderChip } from './chip.js';
import { escapeAttr, escapeHtml } from './html.js';

export interface SceneGridRelease {
  /** False when the gateway has no checkpoint-release seam (gap F-06-1). */
  readonly wired: boolean;
}

export interface SceneGridInput {
  readonly detail: VideoDetail;
  readonly storyboard: StoryboardView | null;
  readonly release: SceneGridRelease;
  /** Columns at the widest band, for the keyboard's ArrowUp/ArrowDown step. */
  readonly columns?: number;
  /** Success or failure line from a committed action. */
  readonly notice?: string;
}

const DEFAULT_COLUMNS = 6;

function scenesHref(detail: VideoDetail): string {
  return '/videos/' + encodeURIComponent(detail.id) + '/scenes';
}

function scriptHref(detail: VideoDetail): string {
  return '/videos/' + encodeURIComponent(detail.id) + '/script';
}

function sceneHrefOf(detail: VideoDetail, sceneId: string): string {
  return scenesHref(detail) + '/' + encodeURIComponent(sceneId);
}

function renderRelease(input: {
  detail: VideoDetail;
  storyboard: StoryboardView;
  checkpoint: Checkpoint;
  wired: boolean;
}): string {
  if (input.checkpoint.kind !== 'open') return '';
  const remaining = input.checkpoint.remaining;
  if (!input.wired) {
    return (
      '<div class="scene-release">' +
      '<button class="btn btn-primary" type="button" data-release disabled ' +
      'aria-describedby="release-reason">' +
      escapeHtml(releaseLabel(remaining)) +
      ' <span class="btn-sub">· ' +
      escapeHtml(releaseSubLabel(remaining)) +
      '</span></button>' +
      '<p class="scene-release-reason" id="release-reason">' +
      escapeHtml(RELEASE_UNWIRED_REASON) +
      '</p>' +
      '</div>'
    );
  }
  return (
    '<form class="scene-release" method="post" action="' +
    escapeAttr(scenesHref(input.detail) + '/release-checkpoint') +
    '">' +
    '<input type="hidden" name="revision" value="' +
    input.storyboard.revision +
    '">' +
    '<button class="btn btn-primary" type="submit" data-release>' +
    escapeHtml(releaseLabel(remaining)) +
    ' <span class="btn-sub">· ' +
    escapeHtml(releaseSubLabel(remaining)) +
    '</span></button>' +
    '</form>'
  );
}

function renderBanner(input: {
  detail: VideoDetail;
  checkpoint: Checkpoint;
  firstSceneId: string | null;
}): string {
  const checkpoint = input.checkpoint;
  if (checkpoint.kind === 'open') {
    const fix =
      input.firstSceneId === null
        ? ''
        : '<a class="btn" href="' +
          escapeAttr(sceneHrefOf(input.detail, input.firstSceneId)) +
          '">Fix scenes 1–3 first</a>';
    return (
      '<div class="checkpoint-banner" data-checkpoint-banner="open">' +
      '<p class="checkpoint-title"><strong>CHECKPOINT</strong> — comparing scenes 1–3 for the recurring protagonist</p>' +
      '<p class="checkpoint-copy" data-checkpoint-copy>' +
      escapeHtml(checkpoint.copy) +
      '</p>' +
      '<div class="checkpoint-actions">' +
      fix +
      '</div>' +
      '</div>'
    );
  }
  if (checkpoint.kind === 'not_applicable') {
    return (
      '<div class="checkpoint-banner checkpoint-banner-quiet" data-checkpoint-banner="not_applicable">' +
      '<p class="checkpoint-copy" data-checkpoint-copy>' +
      escapeHtml(checkpoint.copy) +
      '</p>' +
      '</div>'
    );
  }
  return '';
}

function renderTile(tile: ReturnType<typeof sceneTiles>[number]): string {
  const span = tile.span;
  const attrs = [
    'class="scene-tile"',
    'data-scene-tile',
    'data-scene-no="' + escapeAttr(tile.no) + '"',
    'data-state="' + escapeAttr(tile.state) + '"',
    'data-announce="' + escapeAttr(tile.announce) + '"',
    ...(tile.blockedByCheckpoint ? ['data-blocked="checkpoint"'] : []),
    'href="' + escapeAttr(tile.href) + '"',
    'aria-selected="false"',
    'aria-label="' + escapeAttr(tile.accessibleName) + '"',
  ].join(' ');
  return (
    '<li class="scene-tile-item">' +
    '<a ' +
    attrs +
    '>' +
    renderChip(tile.state, { size: 'sm' }) +
    (tile.pin === null ? '' : '<span class="scene-pin mono">' + escapeHtml(tile.pin) + '</span>') +
    (tile.imageUrl === null
      ? '<span class="scene-thumb scene-thumb-empty" aria-hidden="true">▦</span>'
      : '<span class="scene-thumb"><img src="' +
        escapeAttr(tile.imageUrl) +
        '" alt="' +
        escapeAttr(tile.alt) +
        '" width="168" height="298" loading="' +
        (tile.position <= 6 ? 'eager' : 'lazy') +
        '" decoding="async"></span>') +
    '<span class="scene-meta">' +
    '<span class="scene-no mono">' +
    escapeHtml(tile.no) +
    '</span>' +
    (span === null
      ? '<span class="scene-span mono">—</span>'
      : '<span class="scene-span mono" title="' +
        escapeAttr(span.spoken) +
        '">' +
        escapeHtml(span.compact) +
        '</span>') +
    '</span>' +
    '</a>' +
    '</li>'
  );
}

/** Placeholder for a target scene the storyboard has not produced yet. */
function renderPendingTile(position: number): string {
  const no = 'S' + String(position).padStart(2, '0');
  return (
    '<li class="scene-tile-item">' +
    '<div class="scene-tile scene-tile-pending" data-scene-pending="' +
    escapeAttr(no) +
    '">' +
    '<span class="scene-thumb scene-thumb-empty" aria-hidden="true">▦</span>' +
    '<span class="scene-meta">' +
    '<span class="scene-no mono">' +
    no +
    '</span><span class="scene-span mono">not started</span>' +
    '</span>' +
    '</div>' +
    '</li>'
  );
}

function renderSelectionBar(firstHref: string | null): string {
  const href = firstHref === null ? '#replace-image' : firstHref + '#replace-image';
  return (
    '<div class="scene-selection" data-scene-selection>' +
    '<p class="scene-selection-text mono" data-selection-text>' +
    'selected: — · replace 1 image call · reorder 0 calls</p>' +
    '<div class="scene-selection-buttons">' +
    '<a class="btn" data-selection-replace href="' +
    escapeAttr(href) +
    '" aria-disabled="true" tabindex="-1">Replace image <span class="btn-sub">· 1 image call</span></a>' +
    '<button class="btn" type="button" data-reorder="up" disabled aria-describedby="reorder-note">↑</button>' +
    '<button class="btn" type="button" data-reorder="down" disabled aria-describedby="reorder-note">↓</button>' +
    '</div>' +
    '<p class="scene-reorder-note" id="reorder-note">' +
    escapeHtml(REORDER_NOTE) +
    '</p>' +
    '</div>'
  );
}

export function renderSceneGrid(input: SceneGridInput): string {
  const { detail, storyboard } = input;
  const im = detail.stages.find((row) => row.stage === 'IM');
  const blockedReason = im?.blocked_reason ?? null;
  const total = Math.max(detail.scene_count, storyboard?.scene_count ?? 0);
  const checkpoint = checkpointState({ storyboard, blockedReason, total });
  const counts = gridCounts(storyboard?.scenes ?? [], total);
  const tiles = sceneTiles({
    videoId: detail.id,
    scenes: storyboard?.scenes ?? [],
    total: counts.total,
    checkpoint,
  });
  const pending = Array.from({ length: Math.max(0, counts.total - tiles.length) }, (_, index) =>
    renderPendingTile(tiles.length + index + 1),
  ).join('');

  const stageLine =
    im === undefined
      ? ''
      : '<p class="scene-stage-line mono" data-im-state="' +
        escapeAttr(im.state) +
        (blockedReason === null ? '' : '" data-im-reason="' + escapeAttr(blockedReason)) +
        '">image stage: ' +
        escapeHtml(im.state.replace(/_/g, ' ')) +
        (blockedReason === null ? '' : ' · ' + escapeHtml(blockedReason)) +
        '</p>';

  const notice =
    input.notice === undefined
      ? ''
      : '<p class="scene-notice" data-scene-notice>' + escapeHtml(input.notice) + '</p>';

  if (tiles.length === 0) {
    const line =
      checkpoint.kind === 'blocked'
        ? checkpoint.copy
        : '0 of ' + counts.total + ' generated. Images have not started.';
    return (
      '<section class="scene-grid" data-scene-grid data-video-id="' +
      escapeAttr(detail.id) +
      '" data-checkpoint="' +
      escapeAttr(checkpoint.kind) +
      '">' +
      '<header class="scene-grid-head">' +
      '<div class="scene-grid-heading">' +
      '<h2 class="scene-grid-title">Scenes</h2>' +
      (im === undefined ? '' : renderChip(im.state, { size: 'md' })) +
      '<p class="scene-grid-count mono" data-grid-count>' +
      escapeHtml(gridCountText(counts)) +
      '</p>' +
      '</div>' +
      '</header>' +
      notice +
      stageLine +
      '<div class="scene-grid-blocked" data-grid-blocked="' +
      escapeAttr(checkpoint.kind) +
      '">' +
      '<p class="scene-grid-blocked-line">' +
      escapeHtml(line) +
      '</p>' +
      (checkpoint.kind === 'blocked'
        ? '<p class="scene-grid-reason">Blocked: ' + escapeHtml(checkpoint.reason) + '.</p>'
        : '') +
      '<p><a class="btn" href="' +
      escapeAttr(scriptHref(detail)) +
      '">Go to Script</a></p>' +
      '</div>' +
      '</section>'
    );
  }

  const firstScene = storyboard?.scenes.find((scene) => scene.position === 1) ?? null;
  return (
    '<section class="scene-grid" data-scene-grid data-video-id="' +
    escapeAttr(detail.id) +
    '" data-checkpoint="' +
    escapeAttr(checkpoint.kind) +
    '" data-columns="' +
    (input.columns ?? DEFAULT_COLUMNS) +
    '">' +
    '<header class="scene-grid-head">' +
    '<div class="scene-grid-heading">' +
    '<h2 class="scene-grid-title">Scenes</h2>' +
    (im === undefined ? '' : renderChip(im.state, { size: 'md' })) +
    '<p class="scene-grid-count mono" data-grid-count>' +
    escapeHtml(gridCountText(counts)) +
    '</p>' +
    '</div>' +
    (storyboard === null
      ? ''
      : renderRelease({ detail, storyboard, checkpoint, wired: input.release.wired })) +
    '</header>' +
    notice +
    stageLine +
    renderBanner({ detail, checkpoint, firstSceneId: firstScene?.id ?? null }) +
    '<p class="sr-only" data-grid-announce aria-live="polite"></p>' +
    '<ul class="scene-tiles" data-scene-tiles role="list">' +
    tiles.map(renderTile).join('') +
    pending +
    '</ul>' +
    renderSelectionBar(tiles[0]?.href ?? null) +
    '</section>'
  );
}
