/**
 * UC-03 stage rail and UC-05 stale ribbon (UI_SPEC §5, §6.5 W-04; UX IP-03).
 *
 * The rail is navigation *and* status: eleven nodes in pipeline order, each
 * with its state word, its pin and — while running — a determinate bar for the
 * scenes it has finished. The state is never carried by colour alone: every
 * node renders a glyph, a word and a border pattern (AX-13).
 *
 * The server renders the initial state from `VideoDetail.stages`; the SSE
 * enhancer (`client/workspace.ts`) rewrites the same `data-*` hooks in place,
 * so the rail reflects a live stage change without a reload.
 */
import type { StageState } from '../../shared/stages.js';
import {
  RAIL_STATE_LABELS,
  railNodes,
  ribbonCause,
  ribbonRuns,
  staleSummary,
  type RailNode,
  type VideoDetail,
} from '../workspace/model.js';
import { escapeAttr, escapeHtml } from './html.js';
import { stateGlyph } from '../workspace/glyphs.js';

function renderNode(node: RailNode, firstTabStop: boolean): string {
  const current = node.current ? ' data-current="true"' : ' data-current="false"';
  const aria =
    node.label +
    ', ' +
    RAIL_STATE_LABELS[node.state].toLowerCase() +
    (node.pin === null ? '' : ', pin v' + node.pin) +
    (node.stale ? ', stale' : '') +
    (node.blockedReason === null ? '' : ', blocked: ' + node.blockedReason);
  const progress =
    node.progress === null
      ? '<span class="stage-progress" data-progress hidden></span>'
      : '<span class="stage-progress" data-progress>' +
        '<span class="stage-bar" data-bar style="--pct:' +
        (node.progressPercent ?? 0) +
        '%"></span>' +
        '<span class="sr-only">' +
        escapeHtml(node.progress) +
        '</span></span>';
  const pin =
    node.pin === null
      ? '<span class="stage-pin" data-pin hidden></span>'
      : '<span class="stage-pin mono" data-pin>v' + node.pin + '</span>';
  const gate = node.gate ? '<span class="stage-gate" aria-hidden="true">gate</span>' : '';
  return (
    '<li class="stage-node" data-stage="' +
    node.code +
    '" data-state="' +
    escapeAttr(node.state) +
    '" data-stale="' +
    (node.stale ? 'true' : 'false') +
    '" data-progress-text="' +
    escapeAttr(node.progress ?? '') +
    '" data-progress-percent="' +
    (node.progressPercent ?? 0) +
    '"' +
    current +
    '>' +
    '<a class="stage-link" href="' +
    escapeAttr(node.href) +
    '" title="' +
    escapeAttr(node.tooltip) +
    '" aria-label="' +
    escapeAttr(aria) +
    '"' +
    (node.current ? ' aria-current="step"' : '') +
    (firstTabStop ? ' tabindex="0"' : ' tabindex="-1"') +
    '>' +
    '<span class="stage-code mono">' +
    node.code +
    '</span>' +
    '<span class="stage-state">' +
    '<span class="stage-glyph" data-glyph>' +
    stateGlyph(node.state) +
    '</span>' +
    '<span class="stage-state-word" data-state-word>' +
    escapeHtml(RAIL_STATE_LABELS[node.state]) +
    '</span>' +
    '</span>' +
    pin +
    progress +
    gate +
    '</a></li>'
  );
}

/**
 * One ribbon for the rail (UC-05 variant a). It is always in the DOM so the
 * enhancer can reveal it when a run of three or more stale stages appears; the
 * server marks it `hidden` when there is no such run.
 */
function renderRibbon(model: StageRailModel, detail: VideoDetail): string {
  const codes = model.ribbons.flat();
  const hidden = codes.length === 0;
  const list = codes
    .map(
      (code) =>
        '<span class="stale-ribbon-stage mono" data-ribbon-stage="' +
        code +
        '">' +
        code +
        ' ' +
        stateGlyph('stale') +
        ' stale</span>',
    )
    .join('<span class="stale-separator" aria-hidden="true"> · </span>');
  const cause = hidden ? '' : ribbonCause(model.nodes, detail.stages);
  return (
    '<div class="stale-ribbon" data-stale-ribbon role="note" aria-label="Stale stages"' +
    (hidden ? ' hidden' : '') +
    '>' +
    '<span class="stale-ribbon-list" data-ribbon-list>' +
    list +
    '</span>' +
    '<span class="stale-ribbon-cause mono" data-ribbon-cause>' +
    escapeHtml(cause) +
    '</span>' +
    '<details class="stale-ribbon-why"><summary>Why?</summary>' +
    '<p>These stages were completed, then an edit made the stored work out of date. ' +
    'The work is still stored and downloadable; it clears only when the stage re-runs ' +
    'or the staleness is explicitly accepted.</p></details>' +
    '</div>'
  );
}

export interface StageRailModel {
  readonly nodes: readonly RailNode[];
  readonly summary: string;
  readonly ribbons: readonly RailNode[][];
}

export function stageRailModel(detail: VideoDetail): StageRailModel {
  const nodes = railNodes(detail);
  return {
    nodes,
    summary: staleSummary(nodes),
    ribbons: ribbonRuns(nodes),
  };
}

export function renderStageRail(detail: VideoDetail): string {
  const model = stageRailModel(detail);
  const current = model.nodes.findIndex((node) => node.current);
  const firstTabStop = current >= 0 ? current : 0;
  const nodes = model.nodes.map((node, index) => renderNode(node, index === firstTabStop)).join('');
  return (
    '<section class="stage-rail" aria-labelledby="stage-rail-heading" data-stage-rail>' +
    '<h2 class="sr-only" id="stage-rail-heading">Stage rail</h2>' +
    '<div class="stage-rail-head">' +
    '<ol class="stage-list">' +
    nodes +
    '</ol>' +
    '<p class="stage-stale-summary mono" data-stale-summary>' +
    escapeHtml(model.summary) +
    '</p>' +
    '</div>' +
    '<div class="stage-ribbons" data-stale-ribbons>' +
    renderRibbon(model, detail) +
    '</div>' +
    '</section>'
  );
}

/** The word a rail node renders for a state (shared with the enhancer's parity test). */
export function railWord(state: StageState): string {
  return RAIL_STATE_LABELS[state];
}
