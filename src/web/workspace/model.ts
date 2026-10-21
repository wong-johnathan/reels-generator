/**
 * The video workspace's view model — UI_SPEC §5 UC-02/UC-03/UC-04/UC-05, §6.5
 * W-04, and UX_SPEC IP-03.
 *
 * Everything here is a pure derivation from the frozen contract's
 * `VideoDetail`/`Overview` shapes (`VideoDetailSchema`, `OverviewSchema`). No
 * field is invented: where UI_SPEC asks for something the contract does not
 * carry (per-video call counts, series mode, batch neighbours), the model
 * leaves it out and the evidence file names the gap.
 */
import type { z } from 'zod';

import {
  GATE_STAGE_CODES,
  STAGE_CODES,
  STAGE_LABELS,
  type StageCode,
  type StageState,
} from '../../shared/stages.js';
import type {
  AttentionItemSchema,
  BatchSummarySchema,
  OverviewSchema,
  StageViewSchema,
  VideoDetailSchema,
} from '../../../contract/api.js';

export type VideoDetail = z.infer<typeof VideoDetailSchema>;
export type StageView = z.infer<typeof StageViewSchema>;
export type Overview = z.infer<typeof OverviewSchema>;
export type AttentionItem = z.infer<typeof AttentionItemSchema>;
export type BatchSummary = z.infer<typeof BatchSummarySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// State words and glyphs (UI_SPEC §3.1)
// ─────────────────────────────────────────────────────────────────────────────

/** The exact uppercase state words of UI_SPEC §3.1 — one word per state (AX-20). */
export const STATE_LABELS: Readonly<Record<StageState, string>> = {
  not_run: 'NOT RUN',
  running: 'RUNNING',
  done: 'DONE',
  awaiting_approval: 'AWAITING APPROVAL',
  stale: 'STALE',
  failed: 'FAILED',
  blocked: 'BLOCKED',
  cancelled: 'CANCELLED',
};

/** Rail nodes have one word less room: UI_SPEC §3.1 says `AWAITING` on the rail. */
export const RAIL_STATE_LABELS: Readonly<Record<StageState, string>> = {
  ...STATE_LABELS,
  awaiting_approval: 'AWAITING',
};

/** Sentence case for the `md`/`lg` chip sizes (§3.1). */
export function sentenceState(state: StageState): string {
  const word = STATE_LABELS[state].toLowerCase();
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** §3.4: the attention reason is text, never a chip. */
export function attentionReasonText(item: {
  readonly attention_kind: string;
  readonly attention_reason: string | null;
}): string {
  if (item.attention_reason !== null && item.attention_reason.length > 0) {
    return item.attention_reason;
  }
  return item.attention_kind === 'none' ? 'none' : item.attention_kind;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tabs (UI_SPEC §5 UC-02)
// ─────────────────────────────────────────────────────────────────────────────

export const TAB_KEYS = [
  'topic',
  'script',
  'storyboard',
  'scenes',
  'audio',
  'render',
  'export',
] as const;
export type TabKey = (typeof TAB_KEYS)[number];

export const TAB_LABELS: Readonly<Record<TabKey, string>> = {
  topic: 'Topic',
  script: 'Script',
  storyboard: 'Storyboard',
  scenes: 'Scenes',
  audio: 'Audio',
  render: 'Render',
  export: 'Export',
};

/** Which stages a tab reports. Used for the tab's accessible name, not to disable it. */
export const TAB_STAGES: Readonly<Record<TabKey, readonly StageCode[]>> = {
  topic: ['T', 'RS'],
  script: ['SC'],
  storyboard: ['SB'],
  scenes: ['IM'],
  audio: ['NA', 'TC'],
  render: ['RE', 'QC', 'FA'],
  export: ['EX'],
};

/**
 * IP-03: an attention row links straight to the tab that holds its gate.
 * `FA` opens the approval control, which the render tab carries (§5 UC-03).
 */
export function tabKeyForStage(stage: StageCode): TabKey {
  switch (stage) {
    case 'T':
    case 'RS':
      return 'topic';
    case 'SC':
      return 'script';
    case 'SB':
      return 'storyboard';
    case 'IM':
      return 'scenes';
    case 'NA':
    case 'TC':
      return 'audio';
    case 'RE':
    case 'QC':
    case 'FA':
      return 'render';
    case 'EX':
      return 'export';
  }
}

export function isTabKey(value: string): value is TabKey {
  return (TAB_KEYS as readonly string[]).includes(value);
}

export function workspaceHref(videoId: string, tab: TabKey): string {
  return '/videos/' + encodeURIComponent(videoId) + '/' + tab;
}

export interface TabModel {
  readonly key: TabKey;
  readonly label: string;
  readonly href: string;
  readonly selected: boolean;
  /** State of the first stage the tab reports, for its accessible name. */
  readonly state: StageState | null;
}

export function tabModels(detail: VideoDetail, selected: TabKey): TabModel[] {
  return TAB_KEYS.map((key) => {
    const first = TAB_STAGES[key][0];
    const stage =
      first === undefined ? undefined : detail.stages.find((row) => row.stage === first);
    return {
      key,
      label: TAB_LABELS[key],
      href: workspaceHref(detail.id, key),
      selected: key === selected,
      state: stage?.state ?? null,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Video state chip (UC-04)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The workspace header chip reports the *video* state, resolved to one of the
 * eight chip states. A NEEDS_ATTENTION video borrows its stage's state so the
 * chip says `FAILED` / `BLOCKED` / `AWAITING` rather than a ninth state name.
 */
export function chipStateForVideo(detail: {
  readonly status: string;
  readonly stage_state: StageState;
}): StageState {
  switch (detail.status) {
    case 'COMPLETE':
      return 'done';
    case 'RUNNING':
      return 'running';
    case 'CANCELLED':
      return 'cancelled';
    case 'NOT_STARTED':
      return 'not_run';
    default:
      return detail.stage_state;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage rail (UC-03) and stale ribbon (UC-05)
// ─────────────────────────────────────────────────────────────────────────────

export interface RailNode {
  readonly code: StageCode;
  readonly label: string;
  readonly state: StageState;
  readonly stale: boolean;
  readonly staleCause: string | null;
  /** The series version this stage started on, when it has one (R-002-4). */
  readonly pin: number | null;
  /** `11 of 17` while running, else null. Never a percentage of a whole stage. */
  readonly progress: string | null;
  readonly progressPercent: number | null;
  /** `FA`/`EX` are gates, not producing stages. */
  readonly gate: boolean;
  readonly current: boolean;
  readonly href: string;
  readonly tooltip: string;
  readonly blockedReason: string | null;
}

function stageProgress(stage: StageView): string | null {
  if (stage.state !== 'running' || stage.progress.total <= 0) return null;
  return stage.progress.current + ' of ' + stage.progress.total;
}

/**
 * DI-05: staleness is a first-class visible state — a stale stage shows the
 * word `STALE` on the rail even though its stored state is still `done`. The
 * tooltip keeps both facts: the displayed state and the state underneath it.
 */
export function railStateFor(stage: {
  readonly state: StageState;
  readonly stale: boolean;
}): StageState {
  return stage.stale ? 'stale' : stage.state;
}

function tooltipFor(stage: StageView, pin: number | null): string {
  const displayed = railStateFor(stage);
  const parts = [stage.stage, RAIL_STATE_LABELS[displayed].toLowerCase()];
  if (stage.stale && stage.state !== 'stale') {
    parts.push('was ' + RAIL_STATE_LABELS[stage.state].toLowerCase());
  }
  parts.push(pin === null ? 'no pin' : 'pin v' + pin);
  if (stage.progress.total > 0 && stage.state === 'running') {
    parts.push(stage.progress.current + ' of ' + stage.progress.total + ' done');
  }
  if (stage.stale && stage.stale_cause !== null) parts.push('stale: ' + stage.stale_cause);
  if (stage.blocked_reason !== null) parts.push('blocked: ' + stage.blocked_reason);
  if (stage.last_event !== null) parts.push(stage.last_event);
  return parts.join(' · ');
}

/** One rail node per contract stage row, in pipeline order (UX_SPEC §0.2). */
export function railNodes(detail: VideoDetail): RailNode[] {
  const byCode = new Map(detail.stages.map((stage) => [stage.stage, stage]));
  return STAGE_CODES.map((code) => {
    const stage = byCode.get(code);
    const label = STAGE_LABELS[code];
    const gate = (GATE_STAGE_CODES as readonly string[]).includes(code);
    if (stage === undefined) {
      // The contract says `stages` covers all eleven codes; a missing row is
      // rendered as `not run` rather than invented as running or done.
      return {
        code,
        label,
        state: 'not_run' as StageState,
        stale: false,
        staleCause: null,
        pin: null,
        progress: null,
        progressPercent: null,
        gate,
        current: detail.current_stage === code,
        href: workspaceHref(detail.id, tabKeyForStage(code)),
        tooltip: code + ' · not run · no pin',
        blockedReason: null,
      };
    }
    const progress = stageProgress(stage);
    return {
      code,
      label,
      state: railStateFor(stage),
      stale: stage.stale,
      staleCause: stage.stale_cause,
      pin: stage.series_version,
      progress,
      progressPercent:
        progress === null || stage.progress.total === 0
          ? null
          : Math.round((stage.progress.current / stage.progress.total) * 100),
      gate,
      current: detail.current_stage === code,
      href: workspaceHref(detail.id, tabKeyForStage(code)),
      tooltip: tooltipFor(stage, stage.series_version),
      blockedReason: stage.blocked_reason,
    };
  });
}

/**
 * UC-05: staleness is a first-class visible state. UI_SPEC §5 UC-03 fixes the
 * threshold — one or two stale nodes are node-level tooltips, three or more
 * *consecutive* nodes get the merged ribbon beneath the rail. The nodes keep
 * their dashed/hatched treatment either way, so nothing is ever hidden.
 */
export function ribbonRuns(nodes: readonly RailNode[]): RailNode[][] {
  const runs: RailNode[][] = [];
  let run: RailNode[] = [];
  for (const node of nodes) {
    if (node.stale) {
      run.push(node);
      continue;
    }
    if (run.length > 0) runs.push(run);
    run = [];
  }
  if (run.length > 0) runs.push(run);
  return runs.filter((candidate) => candidate.length >= 3);
}

export function staleSummary(nodes: readonly RailNode[]): string {
  const stale = nodes.filter((node) => node.stale);
  if (stale.length === 0) return 'stale: none';
  return 'stale: ' + stale.map((node) => node.code).join(', ');
}

/** The ribbon's cause line names the edit and revision that made the stages stale. */
export function ribbonCause(nodes: readonly RailNode[], stages: readonly StageView[]): string {
  const staleStages = stages.filter((stage) => stage.stale);
  const cause = staleStages.find((stage) => stage.stale_cause !== null)?.stale_cause ?? null;
  const codes = nodes.map((node) => node.code).join(', ');
  if (cause === null) return codes + ' stale';
  const at = staleStages.find((stage) => stage.stale_at !== null)?.stale_at ?? null;
  const stamp = at === null ? '' : ', ' + at.replace('T', ' ').slice(0, 16) + ' UTC';
  return cause + ' (' + codes + stamp + ')';
}

// ─────────────────────────────────────────────────────────────────────────────
// Footer (W-04: pins, mode, calls — only what the contract carries)
// ─────────────────────────────────────────────────────────────────────────────

export function pinsText(detail: VideoDetail): string {
  const text = detail.pins.text.trim();
  return text.length === 0 ? '—' : text;
}

export function workspaceFooterItems(detail: VideoDetail): string[] {
  const items = [
    'pins: ' + pinsText(detail),
    'target ' + detail.target_duration_s + ' s',
    detail.scene_count + (detail.scene_count === 1 ? ' scene' : ' scenes'),
  ];
  if (detail.script_revision !== null) items.push('script rev ' + detail.script_revision);
  return items;
}

/**
 * The stage panel is the shell's honest summary of one stage — state, pin,
 * progress, blocked reason and last event. The stage's working surface
 * (script editor, scene grid, player…) belongs to F-05…F-09.
 */
export interface StagePanelModel {
  readonly tab: TabKey;
  readonly label: string;
  readonly stages: readonly RailNode[];
}

export function stagePanelModel(detail: VideoDetail, tab: TabKey): StagePanelModel {
  const codes = TAB_STAGES[tab];
  const nodes = railNodes(detail).filter((node) => codes.includes(node.code));
  return { tab, label: TAB_LABELS[tab], stages: nodes };
}

// ─────────────────────────────────────────────────────────────────────────────
// Overview / attention queue (S-02, W-01, IP-05)
// ─────────────────────────────────────────────────────────────────────────────

export interface OverviewRow {
  readonly videoId: string;
  readonly label: string;
  readonly position: number | null;
  readonly reason: string;
  readonly detail: string;
  readonly stage: StageCode;
  readonly state: StageState;
  readonly href: string;
  readonly updatedAt: string;
  readonly attentionKind: string;
}

export interface OverviewGroup {
  readonly key: string;
  readonly seriesName: string;
  readonly batchId: string | null;
  readonly batchLabel: string;
  readonly progress: string | null;
  readonly rows: readonly OverviewRow[];
}

export interface OverviewModel {
  readonly groups: readonly OverviewGroup[];
  readonly attentionCount: number;
  readonly nextHref: string | null;
  readonly running: number;
  readonly complete: number;
  readonly batchCount: number;
}

function overviewRow(item: AttentionItem): OverviewRow {
  return {
    videoId: item.video_id,
    label: item.video_label,
    position: item.batch_position,
    reason: attentionReasonText(item),
    detail: STAGE_LABELS[item.current_stage] + ' · ' + STATE_LABELS[item.stage_state].toLowerCase(),
    stage: item.current_stage,
    state: item.stage_state,
    href: workspaceHref(item.video_id, tabKeyForStage(item.current_stage)),
    updatedAt: item.updated_at,
    attentionKind: item.attention_kind,
  };
}

/**
 * Grouping is fixed (IP-05): attention first, grouped by batch, with the
 * batchless single-video slice from Milestone A standing on its own card.
 */
export function overviewModel(overview: Overview): OverviewModel {
  const rows = overview.attention.map(overviewRow);
  const batches = new Map(overview.batches.map((batch) => [batch.id, batch]));
  const groups: OverviewGroup[] = [];

  for (const [index, row] of rows.entries()) {
    const item = overview.attention[index];
    const batchId = item?.batch_id ?? null;
    const batch = batchId === null ? undefined : batches.get(batchId);
    const key = batchId ?? 'none';
    let group = groups.find((candidate) => candidate.key === key);
    if (group === undefined) {
      group = {
        key,
        seriesName: item?.series_name ?? '',
        batchId,
        batchLabel:
          batch === undefined
            ? 'No batch — Milestone A single video'
            : 'batch ' + batch.id.slice(0, 8),
        progress:
          batch === undefined
            ? null
            : batch.completed_count + ' of ' + batch.target_count + ' complete',
        rows: [],
      };
      groups.push(group);
    }
    (group.rows as OverviewRow[]).push(row);
  }

  return {
    groups,
    attentionCount: rows.length,
    nextHref: rows[0]?.href ?? null,
    running: overview.counts.running,
    complete: overview.counts.complete,
    batchCount: overview.batches.length,
  };
}

/** Batch cards that carry no attention rows still show their progress (IP-05). */
export function batchesWithoutAttention(overview: Overview): BatchSummary[] {
  const withAttention = new Set(
    overview.attention.map((item) => item.batch_id).filter((id): id is string => id !== null),
  );
  return overview.batches.filter((batch) => !withAttention.has(batch.id));
}
