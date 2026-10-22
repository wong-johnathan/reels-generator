/**
 * S-06 — Batch detail.
 *
 * What a batch actually produced, per video: the topic the pipeline chose, the
 * script it wrote (hook, narration, the description you would paste into the
 * upload form), and — when something broke — the stage, the attempt and the
 * provider's own error text.
 *
 * The Regenerate control posts to `/batches/:id/regenerate`, which requeues only
 * the failed jobs in this batch (D-H). It is an explicit operator click; nothing
 * here runs on a timer (R-019-4).
 */
import { describeAge } from '../format.js';
import type { BatchDetail, BatchVideoDetail } from '../batches/postgres.js';
import { escapeAttr, escapeHtml } from './html.js';
import { batchLabel } from './batches.js';

function paragraph(label: string, value: string | null): string {
  if (value === null) return '';
  return (
    `<div class="field"><span class="field-label">${escapeHtml(label)}</span>` +
    `<p class="field-value">${escapeHtml(value)}</p></div>`
  );
}

function failureBlock(video: BatchVideoDetail): string {
  const failure = video.failure;
  if (failure === null) return '';
  const attempt = `attempt ${failure.attemptNo}`;
  const kind = failure.errorClass === null ? '' : ` · ${failure.errorClass}`;
  const message =
    failure.message === null ? 'The stage failed without recording a message.' : failure.message;
  return (
    '<section class="batch-failure" role="alert">' +
    `<h4>Stage ${escapeHtml(failure.stage)} failed — ${escapeHtml(attempt + kind)}</h4>` +
    `<p class="mono">${escapeHtml(message)}</p>` +
    '</section>'
  );
}

function topicBlock(video: BatchVideoDetail): string {
  if (video.topic === null) {
    return (
      '<p class="muted">No topic recorded yet — the research stage has not run for ' +
      'this video.</p>'
    );
  }
  return (
    '<div class="batch-topic">' +
    paragraph('Topic', video.topic.title) +
    paragraph('Angle', video.topic.description) +
    paragraph('Why this one', video.topic.rationale) +
    '</div>'
  );
}

function scriptBlock(video: BatchVideoDetail): string {
  const script = video.script;
  if (script === null) {
    return '<p class="muted">No script yet — the T stage has not produced one.</p>';
  }
  const stats: string[] = [];
  if (script.wordCount !== null) stats.push(`${script.wordCount} words`);
  if (script.estimatedRuntimeS !== null) {
    stats.push(`~${Math.round(script.estimatedRuntimeS)} s`);
  }
  stats.push(`${video.sceneCount} ${video.sceneCount === 1 ? 'scene' : 'scenes'}`);
  stats.push(`revision ${script.revision}`);

  const hashtags =
    script.hashtags.length === 0
      ? ''
      : '<p class="batch-hashtags">' +
        script.hashtags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join(' ') +
        '</p>';

  return (
    '<div class="batch-script">' +
    `<p class="batch-script-meta">${escapeHtml(stats.join(' · '))}</p>` +
    paragraph('Title', script.title) +
    paragraph('Description', script.description) +
    hashtags +
    (script.script === null
      ? ''
      : '<details class="batch-narration" open><summary>Script</summary>' +
        `<p>${escapeHtml(script.script)}</p></details>`) +
    '</div>'
  );
}

function videoCard(video: BatchVideoDetail): string {
  const download =
    video.videoAssetId === null
      ? '<span class="muted">no file yet</span>'
      : `<a class="btn btn-small" href="/videos/${escapeAttr(video.projectId)}/download">Download MP4</a>`;
  const stage = video.currentStage === null ? '—' : escapeHtml(video.currentStage);

  return (
    `<section class="batch-video" id="video-${escapeAttr(video.projectId)}">` +
    '<header class="batch-video-head">' +
    `<h3>Video ${video.position}</h3>` +
    `<span class="chip is-muted">${escapeHtml(video.status.toLowerCase())}</span>` +
    `<span class="batch-video-stage">stage <strong>${stage}</strong></span>` +
    download +
    '</header>' +
    failureBlock(video) +
    '<h4>Generated topic</h4>' +
    topicBlock(video) +
    '<h4>Generated script</h4>' +
    scriptBlock(video) +
    '</section>'
  );
}

export function renderBatchDetail(input: {
  readonly batch: BatchDetail;
  readonly now: Date;
  readonly regenerated?: number;
}): string {
  const batch = input.batch;
  const failures = batch.videos.filter((video) => video.failure !== null).length;
  const regenerate =
    failures === 0
      ? ''
      : '<form class="batch-regenerate" method="post" action="/batches/' +
        escapeAttr(batch.id) +
        '/regenerate">' +
        '<p>' +
        failures +
        (failures === 1 ? ' video has a failed stage.' : ' videos have a failed stage.') +
        ' Regenerating requeues only what failed and keeps everything already generated.</p>' +
        '<button class="btn" type="submit">Regenerate failed videos</button>' +
        '</form>';

  const notice =
    input.regenerated === undefined
      ? ''
      : '<p class="series-batched" role="status">Requeued ' +
        input.regenerated +
        (input.regenerated === 1 ? ' job' : ' jobs') +
        '. The worker will pick them up.</p>';

  return (
    '<div class="batch-detail">' +
    '<header class="batch-detail-head">' +
    `<h1>${batchLabel(batch.ordinal)}</h1>` +
    `<p class="batch-subject"><a href="/series/${escapeAttr(batch.seriesId)}">` +
    `${escapeHtml(batch.seriesName)}</a> · ${escapeHtml(batch.status.toLowerCase())} · ` +
    `started ${escapeHtml(describeAge(input.now.getTime(), batch.createdAt).text)}</p>` +
    `</header>` +
    notice +
    regenerate +
    batch.videos.map(videoCard).join('') +
    (batch.videos.length === 0 ? '<p class="muted">This batch has no videos.</p>' : '') +
    '</div>'
  );
}
