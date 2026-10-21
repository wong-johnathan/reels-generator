/**
 * W-04 — the video workspace shell (UI_SPEC §6.5), own by F-04.
 *
 * Composition only: the breadcrumb and `<h1>` stay shell-owned (UC-02), the
 * stage rail and ribbon are `stageRail.ts`, the header chip is `chip.ts`, and
 * each tab renders an honest, data-derived summary of its stage. The working
 * surfaces (script editor, scene grid, players, approval controls) belong to
 * F-05…F-09 and are not stubbed here.
 */
import { STAGE_LABELS, type StageState } from '../../shared/stages.js';
import { describeAge, isoSeconds } from '../format.js';
import {
  attentionReasonText,
  chipStateForVideo,
  sentenceState,
  stagePanelModel,
  TAB_STAGES,
  tabModels,
  workspaceFooterItems,
  type TabKey,
  type VideoDetail,
} from '../workspace/model.js';
import { renderChip } from './chip.js';
import { escapeAttr, escapeHtml } from './html.js';
import { renderStageRail } from './stageRail.js';

export interface WorkspaceParts {
  /** Trusted HTML for the content region. */
  readonly content: string;
  /** Trusted HTML for the `<h1>` row's right-hand side. */
  readonly titleAside: string;
  /** The sticky footer's text content. */
  readonly footer: string;
  /** Modules loaded after the shell module. */
  readonly scripts: readonly string[];
}

const WORKSPACE_SCRIPTS: readonly string[] = ['/assets/client/workspace.js'];

function renderTitleAside(detail: VideoDetail): string {
  const chipState = chipStateForVideo(detail);
  const reason = attentionReasonText(detail);
  const reasonNode =
    detail.attention_kind === 'none'
      ? ''
      : '<span class="workspace-reason" data-video-reason>' + escapeHtml(reason) + '</span>';
  return (
    '<span class="workspace-status">' +
    renderChip(chipState, {
      size: 'lg',
      id: 'video-chip',
      label: sentenceState(chipState),
    }) +
    reasonNode +
    '</span>'
  );
}

function renderTabs(detail: VideoDetail, selected: TabKey): string {
  const tabs = tabModels(detail, selected)
    .map((tab) => {
      const state = tab.state === null ? 'not run' : sentenceState(tab.state).toLowerCase();
      return (
        '<a class="workspace-tab" id="workspace-tab-' +
        tab.key +
        '" role="tab" data-tab="' +
        tab.key +
        '" href="' +
        escapeAttr(tab.href) +
        '"' +
        (tab.selected
          ? ' aria-selected="true" tabindex="0"'
          : ' aria-selected="false" tabindex="-1"') +
        ' aria-controls="workspace-panel">' +
        escapeHtml(tab.label) +
        '<span class="sr-only"> (' +
        escapeHtml(state) +
        ')</span>' +
        '</a>'
      );
    })
    .join('');
  return (
    '<div class="workspace-tablist" role="tablist" aria-label="Video sections">' + tabs + '</div>'
  );
}

function renderStageSummary(detail: VideoDetail, code: string, index: number): string {
  const stage = detail.stages.find((row) => row.stage === code);
  const label = STAGE_LABELS[code as keyof typeof STAGE_LABELS] ?? code;
  const state: StageState = stage?.state ?? 'not_run';
  const headingId = 'stage-summary-' + code + '-' + index;

  const rows: string[] = [];
  if (stage === undefined) {
    rows.push('<dt>Pin</dt><dd>—</dd>', '<dt>Progress</dt><dd>Not run</dd>');
  } else {
    rows.push(
      '<dt>Pin</dt><dd class="mono">' +
        (stage.series_version === null ? '—' : 'v' + stage.series_version) +
        '</dd>',
    );
    rows.push(
      '<dt>Progress</dt><dd class="mono">' +
        (stage.progress.total === 0
          ? '—'
          : stage.progress.current + ' of ' + stage.progress.total) +
        '</dd>',
    );
    rows.push(
      '<dt>Attempts</dt><dd class="mono">' +
        stage.attempts.count +
        ' of ' +
        stage.attempts.max_attempts +
        (stage.attempts.last_error_class === null
          ? ''
          : ' · last error ' + stage.attempts.last_error_class) +
        '</dd>',
    );
    if (stage.blocked_reason !== null) {
      rows.push('<dt>Blocked</dt><dd>' + escapeHtml(stage.blocked_reason) + '</dd>');
    }
    if (stage.stale) {
      rows.push(
        '<dt>Stale</dt><dd>' +
          escapeHtml(stage.stale_cause ?? 'An edit made this stage out of date.') +
          (stage.stale_at === null ? '' : ' · ' + escapeHtml(isoSeconds(stage.stale_at))) +
          '</dd>',
      );
    }
    if (stage.last_event !== null) {
      rows.push(
        '<dt>Last event</dt><dd>' +
          escapeHtml(stage.last_event) +
          (stage.last_event_at === null
            ? ''
            : ' · ' + escapeHtml(isoSeconds(stage.last_event_at))) +
          '</dd>',
      );
    }
  }

  return (
    '<article class="stage-summary" data-stage-summary="' +
    code +
    '" aria-labelledby="' +
    headingId +
    '">' +
    '<header class="stage-summary-head">' +
    '<h2 id="' +
    headingId +
    '">' +
    escapeHtml(label) +
    '</h2>' +
    renderChip(state, { size: 'md' }) +
    '</header>' +
    '<dl class="stage-summary-dl">' +
    rows.join('') +
    '</dl>' +
    '</article>'
  );
}

export function renderWorkspace(detail: VideoDetail, tab: TabKey): WorkspaceParts {
  const panel = stagePanelModel(detail, tab);
  const summaries = TAB_STAGES[tab]
    .map((code, index) => renderStageSummary(detail, code, index))
    .join('');
  const content =
    '<div class="workspace" data-workspace data-video-id="' +
    escapeAttr(detail.id) +
    '" data-video-status="' +
    escapeAttr(detail.status) +
    '" data-current-stage="' +
    escapeAttr(detail.current_stage) +
    '" data-attention-kind="' +
    escapeAttr(detail.attention_kind) +
    '" data-attention-reason="' +
    escapeAttr(detail.attention_reason ?? '') +
    '">' +
    renderStageRail(detail) +
    renderTabs(detail, tab) +
    '<section class="workspace-panel" id="workspace-panel" role="tabpanel" tabindex="0" ' +
    'aria-labelledby="workspace-tab-' +
    tab +
    '" data-panel-tab="' +
    tab +
    '">' +
    '<h2 class="sr-only">' +
    escapeHtml(panel.label) +
    '</h2>' +
    summaries +
    '</section>' +
    '</div>';

  return {
    content,
    titleAside: renderTitleAside(detail),
    footer: workspaceFooterItems(detail).join(' · '),
    scripts: WORKSPACE_SCRIPTS,
  };
}

/** `<title>` and breadcrumb labels for a video (used by the route and tests). */
export function workspaceTitle(detail: VideoDetail): string {
  return detail.series_name + ' · video ' + (detail.position_in_batch + 1);
}

/** The footer's relative time for the workspace's own "updated" hint. */
export function updatedHint(detail: VideoDetail, now: number): string {
  return describeAge(now, detail.updated_at).text;
}
