/**
 * S-13 — one scene: image, prompt, narration span, provenance and the
 * single-call replace (UI_SPEC §5 UC-09, §6.7; UX_SPEC S-13, A-17; R-007-1,
 * R-013-1/2, US-019/US-020).
 *
 * Server-rendered and complete without JavaScript. C-02's consequence sentence
 * is printed verbatim above the control, the control carries the one-call
 * label, and it is never the initial focus (AX-04). Provenance prints what the
 * contract carries and names, in words, the two fields it does not.
 */
import {
  CAMERA_MOVE_LABELS,
  provenanceRows,
  PROVENANCE_GAPS,
  promptSummary,
  replaceButtonLabel,
  replaceConsequence,
  scenePin,
  sceneSpan,
  type SceneView,
} from '../scenes/model.js';
import { isoSeconds } from '../format.js';
import type { VideoDetail } from '../workspace/model.js';
import { renderChip } from './chip.js';
import { escapeAttr, escapeHtml } from './html.js';

export interface SceneDetailReplace {
  /** False when the replace route is not mounted; the control stays disabled. */
  readonly wired: boolean;
  /** Named precondition shown when the control is disabled. */
  readonly blockedReason: string | null;
}

export interface SceneDetailInput {
  readonly detail: VideoDetail;
  readonly scene: SceneView;
  readonly total: number;
  readonly replace: SceneDetailReplace;
  readonly notice?: string;
}

function gridHref(detail: VideoDetail): string {
  return '/videos/' + encodeURIComponent(detail.id) + '/scenes';
}

function scenePath(detail: VideoDetail, scene: SceneView): string {
  return gridHref(detail) + '/' + encodeURIComponent(scene.id);
}

function attemptCaption(detail: VideoDetail, scene: SceneView): string {
  const stage = detail.stages.find((row) => row.stage === 'IM');
  const count = stage?.attempts.count ?? 0;
  const max = stage?.attempts.max_attempts ?? 3;
  const attempt = Math.min(count + 1, max);
  const asset = scene.asset;
  const created = asset === null ? '' : ' · ' + isoSeconds(asset.provenance.created_at);
  const hash =
    asset === null || asset.provenance.prompt_hash === null
      ? ''
      : ' · prompt hash ' + asset.provenance.prompt_hash;
  return 'current · attempt ' + attempt + ' of ' + max + created + hash;
}

function renderFigure(detail: VideoDetail, scene: SceneView): string {
  if (scene.asset === null) {
    return (
      '<figure class="scene-detail-figure">' +
      '<div class="scene-detail-image scene-detail-image-empty" data-image-empty>' +
      '<span class="scene-empty-glyph" aria-hidden="true">▦</span>' +
      '<p>No image yet</p>' +
      '</div>' +
      '<figcaption class="scene-detail-caption mono">' +
      escapeHtml(attemptCaption(detail, scene)) +
      '</figcaption>' +
      '</figure>'
    );
  }
  return (
    '<figure class="scene-detail-figure">' +
    '<img class="scene-detail-image" src="' +
    escapeAttr(scene.asset.urls.detail) +
    '" alt="' +
    escapeAttr(promptSummary(scene.image_prompt)) +
    '" width="360" height="640" loading="eager" decoding="async">' +
    '<figcaption class="scene-detail-caption mono">' +
    escapeHtml(attemptCaption(detail, scene)) +
    '</figcaption>' +
    '</figure>'
  );
}

function renderFacts(detail: VideoDetail, scene: SceneView): string {
  const span = sceneSpan(scene);
  const rows: string[] = [];
  if (span !== null) {
    rows.push(
      '<dt>Narration</dt><dd class="mono">' +
        escapeHtml(span.compact) +
        ' <span class="sr-only">' +
        escapeHtml(span.spoken) +
        '</span></dd>',
    );
  } else {
    rows.push('<dt>Narration</dt><dd>—</dd>');
  }
  rows.push(
    '<dt>Camera move</dt><dd>' + escapeHtml(CAMERA_MOVE_LABELS[scene.camera_move]) + '</dd>',
  );
  rows.push(
    '<dt>Protagonist reference</dt><dd>' +
      (scene.uses_protagonist ? 'used by this scene' : 'not used by this scene') +
      '</dd>',
  );
  if (scene.caption_emphasis !== null) {
    rows.push('<dt>Caption emphasis</dt><dd>' + escapeHtml(scene.caption_emphasis) + '</dd>');
  }
  if (scene.fallback_text !== null) {
    rows.push('<dt>Fallback text</dt><dd>' + escapeHtml(scene.fallback_text) + '</dd>');
  }
  const stage = detail.stages.find((row) => row.stage === 'IM');
  rows.push(
    '<dt>Image state</dt><dd>' +
      renderChip(scene.state, { size: 'sm' }) +
      (stage === undefined
        ? ''
        : ' <span class="mono">stage attempt ' +
          Math.min(stage.attempts.count + 1, stage.attempts.max_attempts) +
          ' of ' +
          stage.attempts.max_attempts +
          '</span>') +
      '</dd>',
  );
  return '<dl class="scene-detail-dl">' + rows.join('') + '</dl>';
}

function renderProvenance(scene: SceneView): string {
  if (scene.asset === null) {
    return (
      '<section class="scene-provenance" data-provenance data-provenance-empty>' +
      '<h3 class="scene-detail-heading">Provenance</h3>' +
      '<p>There is no stored asset for this scene yet, so there is no provenance to show. Nothing is invented here.</p>' +
      '</section>'
    );
  }
  const rows = provenanceRows(scene.asset)
    .map(
      (row) =>
        '<dt>' +
        escapeHtml(row.label) +
        '</dt><dd' +
        (row.missing ? ' data-missing="true"' : '') +
        '>' +
        escapeHtml(row.value) +
        '</dd>',
    )
    .join('');
  return (
    '<section class="scene-provenance" data-provenance>' +
    '<h3 class="scene-detail-heading">Provenance</h3>' +
    '<dl class="scene-provenance-dl">' +
    rows +
    '</dl>' +
    '<p class="scene-provenance-gaps">' +
    escapeHtml(PROVENANCE_GAPS) +
    '</p>' +
    '</section>'
  );
}

function renderReplace(input: SceneDetailInput): string {
  const { detail, scene, replace } = input;
  if (scene.asset === null) {
    return (
      '<section class="scene-replace" id="replace-image" data-scene-replace="empty">' +
      '<h3 class="scene-detail-heading">Replace this image</h3>' +
      '<p>Replace needs a stored image. Once the image stage has produced one, this scene can be replaced on its own.' +
      (replace.blockedReason === null ? '' : ' ' + escapeHtml(replace.blockedReason)) +
      '</p>' +
      '</section>'
    );
  }
  const blocked = replace.blockedReason;
  const disabled = !replace.wired || blocked !== null;
  const reason =
    blocked ?? (replace.wired ? null : 'Replace is not wired to the backend in this build.');
  const button =
    '<button class="btn btn-primary" type="submit" data-replace' +
    (disabled ? ' disabled' : '') +
    (reason === null ? '' : ' aria-describedby="replace-reason"') +
    '>' +
    replaceButtonLabel() +
    '</button>';
  return (
    '<section class="scene-replace" id="replace-image" data-scene-replace="' +
    (disabled ? 'blocked' : 'ready') +
    '">' +
    '<h3 class="scene-detail-heading">Replace this image</h3>' +
    '<p class="scene-replace-copy" data-replace-copy>' +
    escapeHtml(replaceConsequence(scene, input.total)) +
    '</p>' +
    '<form class="scene-replace-form" method="post" action="' +
    escapeAttr(scenePath(detail, scene) + '/replace-image') +
    '">' +
    '<input type="hidden" name="revision" value="' +
    scene.revision +
    '">' +
    '<label class="scene-replace-label" for="image-prompt">Image prompt for this scene</label>' +
    '<textarea class="scene-replace-prompt" id="image-prompt" name="image_prompt" rows="3"' +
    (disabled ? ' disabled' : '') +
    '>' +
    escapeHtml(scene.image_prompt) +
    '</textarea>' +
    button +
    '</form>' +
    (reason === null
      ? ''
      : '<p class="scene-replace-reason" id="replace-reason">' + escapeHtml(reason) + '</p>') +
    '</section>'
  );
}

export function renderSceneDetail(input: SceneDetailInput): string {
  const { detail, scene, total } = input;
  const pin = scenePin(scene);
  const notice =
    input.notice === undefined
      ? ''
      : '<p class="scene-notice" data-scene-notice>' + escapeHtml(input.notice) + '</p>';
  return (
    '<section class="scene-detail" data-scene-detail data-video-id="' +
    escapeAttr(detail.id) +
    '" data-scene-no="' +
    escapeAttr(scene.scene_no) +
    '" data-state="' +
    escapeAttr(scene.state) +
    '">' +
    '<header class="scene-detail-head">' +
    '<p class="scene-detail-back"><a href="' +
    escapeAttr(gridHref(detail)) +
    '">← All scenes</a></p>' +
    '<h2 class="scene-detail-title" id="scene-detail-title">' +
    escapeHtml(scene.scene_no) +
    ' · scene ' +
    scene.position +
    ' of ' +
    total +
    '</h2>' +
    renderChip(scene.state, { size: 'md' }) +
    (pin === null ? '' : '<span class="scene-pin mono">' + escapeHtml(pin) + '</span>') +
    '</header>' +
    notice +
    '<div class="scene-detail-body">' +
    renderFigure(detail, scene) +
    '<div class="scene-detail-info">' +
    '<section class="scene-detail-block">' +
    '<h3 class="scene-detail-heading">Prompt</h3>' +
    '<p class="scene-prompt mono" data-scene-prompt>' +
    escapeHtml(scene.image_prompt) +
    '</p>' +
    '</section>' +
    '<section class="scene-detail-block">' +
    '<h3 class="scene-detail-heading">Scene facts</h3>' +
    renderFacts(detail, scene) +
    '</section>' +
    renderProvenance(scene) +
    renderReplace(input) +
    '</div>' +
    '</div>' +
    '</section>'
  );
}
