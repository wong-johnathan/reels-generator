/**
 * S-15 — Render & QC view model (US-024, US-025, US-028 final-approve gate,
 * R-005-3/4, R-010-2…7, UX_SPEC A-21…A-23 and the S-15 states table,
 * UI_SPEC §9.2/§9.6).
 *
 * Everything here is a pure derivation of the frozen contract's
 * `RenderViewSchema` plus the video's stage rows. Three honesty rules drive it:
 *
 *  - **every check shows its number.** The six assertions of R-010-2…7 are a
 *    fixed catalogue. A check the response omits is rendered `not reported`
 *    and blocks approval; it is never silently treated as a pass.
 *  - **a gap is named, not guessed.** `render.approve` takes a `revision` that
 *    `render.get` does not return (gap S-15-1), so approval is enabled only
 *    when the caller can supply one; otherwise the control is disabled with
 *    the reason and nothing is posted.
 *  - **approval is the only path to export.** The gate copy says exactly what
 *    approving does (enables export, nothing else) and what rejecting does
 *    (returns to a named stage, no billable call), and no other control on this
 *    tab can mark the video approved.
 *
 * This module is free of Node-only imports so the client could import it later;
 * today the panel is complete without JavaScript.
 */
import type { z } from 'zod';

import type { QCCheckSchema, RenderViewSchema } from '../../../contract/api.js';
import type { StageState } from '../../shared/stages.js';
import { isoSeconds } from '../format.js';
import type { VideoDetail } from '../workspace/model.js';

export type RenderView = z.infer<typeof RenderViewSchema>;
export type QCCheck = z.infer<typeof QCCheckSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// The six checks of R-010-2…7
// ─────────────────────────────────────────────────────────────────────────────

export const QC_REQUIREMENTS = [
  'R-010-2',
  'R-010-3',
  'R-010-4',
  'R-010-5',
  'R-010-6',
  'R-010-7',
] as const;

export type QCRequirement = (typeof QC_REQUIREMENTS)[number];

export interface QCCatalogueEntry {
  readonly requirement: QCRequirement;
  /** The stable check id used by the pipeline (QC-2 → R-010-2). */
  readonly checkId: string;
  readonly label: string;
  /** Used only when the response omits the check's own `expected`. */
  readonly expected: string;
}

/**
 * One row per numbered assertion. Labels and expected values are the PRD's
 * wording, not a re-invention: R-010-2 (±0 px, ±1 fps), R-010-3 (±0.5 s audio),
 * R-010-4 (0 frames below 16 or above 240 luminance), R-010-5 (every scene,
 * visible duration ≥ span − 0.2 s), R-010-6 (100 % of glyph boxes inside the
 * 5 % inset), R-010-7 (duration within R-009-3).
 */
export const QC_CATALOGUE: readonly QCCatalogueEntry[] = [
  {
    requirement: 'R-010-2',
    checkId: 'QC-2',
    label: 'Resolution and frame rate',
    expected: '1080×1920 @ 30 fps (±0 px, ±1 fps)',
  },
  {
    requirement: 'R-010-3',
    checkId: 'QC-3',
    label: 'Audio stream present and within ±0.5 s of the video',
    expected: 'present · within ±0.5 s',
  },
  {
    requirement: 'R-010-4',
    checkId: 'QC-4',
    label: 'Flagged frames (mean luminance <16 or >240)',
    expected: '0 flagged',
  },
  {
    requirement: 'R-010-5',
    checkId: 'QC-5',
    label: 'Every scene present, visible duration ≥ narration span − 0.2 s',
    expected: 'all scenes · margin ≥ −0.2 s',
  },
  {
    requirement: 'R-010-6',
    checkId: 'QC-6',
    label: 'Captions inside the 5 % safe area',
    expected: '100.0 %',
  },
  {
    requirement: 'R-010-7',
    checkId: 'QC-7',
    label: 'Rendered duration inside the ±5 % band',
    expected: 'target ±5 %',
  },
];

export type QCCheckStatus = 'pass' | 'fail' | 'missing';

export interface QCCheckRow {
  readonly id: string;
  readonly requirement: string;
  readonly label: string;
  /** The measured number, or `—` when the response did not report the check. */
  readonly measured: string;
  readonly expected: string;
  readonly status: QCCheckStatus;
  /** A check the contract reported outside R-010-2…7; shown, never counted. */
  readonly extra: boolean;
}

export interface QCView {
  readonly rows: readonly QCCheckRow[];
  /** Always six: the R-010-2…7 assertions. Extra rows are visible but not counted. */
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly missing: number;
  readonly complete: boolean;
  readonly allPass: boolean;
  readonly summaryLine: string;
  readonly checkedLine: string;
  readonly failingLine: string | null;
  readonly missingLine: string | null;
}

function findCheck(checks: readonly QCCheck[], requirement: QCRequirement): QCCheck | undefined {
  const byRequirement = checks.find((check) => check.requirement.trim() === requirement);
  if (byRequirement !== undefined) return byRequirement;
  const entry = QC_CATALOGUE.find((candidate) => candidate.requirement === requirement);
  if (entry === undefined) return undefined;
  return checks.find((check) => check.id.trim() === entry.checkId);
}

function requirementIds(rows: readonly QCCheckRow[]): string {
  return rows.map((row) => row.requirement).join(', ');
}

function checkIds(rows: readonly QCCheckRow[]): string {
  return rows.map((row) => row.id).join(', ');
}

export function qcView(checks: readonly QCCheck[], checkedAt: string | null): QCView {
  const rows: QCCheckRow[] = [];
  const used = new Set<QCCheck>();

  for (const entry of QC_CATALOGUE) {
    const found = findCheck(checks, entry.requirement);
    if (found === undefined) {
      rows.push({
        id: entry.checkId,
        requirement: entry.requirement,
        label: entry.label,
        measured: '—',
        expected: entry.expected,
        status: 'missing',
        extra: false,
      });
      continue;
    }
    used.add(found);
    rows.push({
      id: found.id,
      requirement: entry.requirement,
      label: found.label.trim().length === 0 ? entry.label : found.label,
      measured: found.measured,
      expected: found.expected.trim().length === 0 ? entry.expected : found.expected,
      status: found.pass ? 'pass' : 'fail',
      extra: false,
    });
  }

  // Nothing the contract sends is hidden: a seventh check (or a reworded
  // requirement id) still appears after the six, and is not counted toward them.
  const extras: QCCheckRow[] = checks
    .filter((check) => !used.has(check))
    .map((check) => ({
      id: check.id,
      requirement: check.requirement,
      label: check.label,
      measured: check.measured,
      expected: check.expected,
      status: check.pass ? 'pass' : 'fail',
      extra: true,
    }));

  const six = rows;
  const passed = six.filter((row) => row.status === 'pass').length;
  const failedRows = six.filter((row) => row.status === 'fail');
  const missingRows = six.filter((row) => row.status === 'missing');
  const summaryLine =
    passed +
    ' of ' +
    QC_CATALOGUE.length +
    ' checks passing' +
    (failedRows.length === 0 ? '' : ' · ' + failedRows.length + ' failing') +
    (missingRows.length === 0 ? '' : ' · ' + missingRows.length + ' not reported');

  const failingLine =
    failedRows.length === 0
      ? null
      : failedRows
          .map(
            (row) =>
              row.id +
              ' · ' +
              row.requirement +
              ' · ' +
              row.label +
              ' — measured ' +
              row.measured +
              ', expected ' +
              row.expected +
              '.',
          )
          .join(' ');

  const missingLine =
    missingRows.length === 0
      ? null
      : missingRows.length +
        ' of ' +
        QC_CATALOGUE.length +
        ' checks have not reported (' +
        checkIds(missingRows) +
        ': ' +
        requirementIds(missingRows) +
        '). Approval stays blocked until every check reports its number.';

  return {
    rows: [...rows, ...extras],
    total: QC_CATALOGUE.length,
    passed,
    failed: failedRows.length,
    missing: missingRows.length,
    complete: missingRows.length === 0,
    allPass: missingRows.length === 0 && failedRows.length === 0,
    summaryLine,
    checkedLine:
      checkedAt === null || checkedAt.trim().length === 0
        ? 'QC has not reported yet'
        : 'QC checked ' + isoSeconds(checkedAt),
    failingLine,
    missingLine,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Copy that carries the gate (UI_SPEC §9.2, UX_SPEC A-23)
// ─────────────────────────────────────────────────────────────────────────────

export const EMPTY_LINE = 'No render yet. It runs after narration and timing.';
export const EMPTY_UNLOCK_LINE =
  'Rendering needs the narration and its timing. Rendering itself makes no provider call.';

/** R-005-3: the sentence above the button says exactly what approving does. */
export const APPROVAL_GATE_LINE =
  'Approving enables export and nothing else: no provider call is made and no stage re-runs.';

/** R-005-4: the return path, and the gap that stops it being recorded (S-15-1). */
export const RETURN_LINE =
  'A rejection returns to a named stage and fires no billable call (R-005-4). This build cannot record a rejection — the final-approval endpoint only accepts an approve decision — so these links open the stage without recording anything.';

/** S-15-1: `render.approve` needs a revision the read endpoint never returns. */
export const APPROVAL_UNWIRED_REASON =
  'This build cannot supply the revision that final approval must carry, so approval cannot be sent. Nothing was approved.';

/**
 * D13: exactly one safe-area rectangle for 9:16, never a per-platform variant.
 * The numbers are the 5 % inset at 1080×1920.
 */
export const SAFE_AREA_LINE =
  'Caption safe area — one 5 % inset rectangle (54 px left and right, 96 px top and bottom at 1080×1920).';

export const LEAVE_NOTE = 'Leaving this page does not stop the job.';

export const MONITORING_NOTE =
  'Approvals need a screen 768 px or wider. This view is monitoring only.';

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

export type RenderPanelState =
  | 'empty'
  | 'blocked'
  | 'running'
  | 'failed'
  | 'qc_running'
  | 'qc_failed'
  | 'stale'
  | 'awaiting_approval'
  | 'approved';

const HEADINGS: Readonly<Record<RenderPanelState, string>> = {
  empty: 'No render yet',
  blocked: 'Render is blocked',
  running: 'Render running',
  failed: 'Render failed',
  qc_running: 'Quality checks running',
  qc_failed: 'Quality checks failed',
  stale: 'Render is stale',
  awaiting_approval: 'Render and quality checks',
  approved: 'Final approval recorded',
};

const CHIPS: Readonly<Record<RenderPanelState, StageState>> = {
  empty: 'not_run',
  blocked: 'blocked',
  running: 'running',
  failed: 'failed',
  qc_running: 'running',
  qc_failed: 'failed',
  stale: 'stale',
  awaiting_approval: 'awaiting_approval',
  approved: 'done',
};

const CHIP_LABELS: Readonly<Record<RenderPanelState, string | null>> = {
  empty: 'Not run',
  blocked: null,
  running: null,
  failed: null,
  qc_running: null,
  qc_failed: null,
  stale: null,
  awaiting_approval: 'Awaiting approval',
  approved: 'Approved',
};

/** The states where the checks have run (or are running) and belong on the page. */
const QC_VISIBLE: ReadonlySet<RenderPanelState> = new Set([
  'qc_running',
  'qc_failed',
  'awaiting_approval',
  'approved',
  'stale',
]);

export function qcVisible(state: RenderPanelState): boolean {
  return QC_VISIBLE.has(state);
}

// ─────────────────────────────────────────────────────────────────────────────
// Numbers (§9.6)
// ─────────────────────────────────────────────────────────────────────────────

function oneDecimal(value: number): string {
  return value.toFixed(1);
}

function secondsLabel(value: number): string {
  return oneDecimal(value) + ' s';
}

function parseFps(checks: readonly QCCheck[]): string | null {
  for (const check of checks) {
    if (check.requirement !== 'R-010-2' && check.id !== 'QC-2') continue;
    const match = /(\d+(?:\.\d+)?)\s*fps/i.exec(check.measured + ' ' + check.expected);
    if (match === null || match[1] === undefined) continue;
    return match[1] + ' fps';
  }
  return null;
}

function parseDuration(checks: readonly QCCheck[]): string | null {
  for (const check of checks) {
    if (check.requirement !== 'R-010-7' && check.id !== 'QC-7') continue;
    const match = /^(\d+(?:\.\d+)?)\s*s$/.exec(check.measured.trim());
    if (match === null || match[1] === undefined) continue;
    return secondsLabel(Number(match[1]));
  }
  return null;
}

export interface RenderStatsView {
  readonly passLine: string;
  readonly rows: readonly (readonly [string, string])[];
  readonly resolution: string | null;
  readonly fps: string | null;
  readonly duration: string | null;
  readonly videoAlt: string;
}

function statsView(render: RenderView): RenderStatsView {
  const passes = render.render_passes;
  const passLine = passes + (passes === 1 ? ' pass' : ' passes');
  const resolution = render.video === null ? null : render.video.width + '×' + render.video.height;
  const fps = parseFps(render.qc.checks);
  const duration = parseDuration(render.qc.checks);
  const hasSrt = render.captions.srt !== null;
  const hasVtt = render.captions.vtt !== null;
  const captionLine = hasSrt && hasVtt ? '.srt + .vtt' : hasVtt ? '.vtt' : hasSrt ? '.srt' : 'none';

  const rows: (readonly [string, string])[] = [];
  if (resolution !== null) rows.push(['Resolution', resolution]);
  if (fps !== null) rows.push(['Frame rate', fps]);
  if (duration !== null) rows.push(['Duration', duration]);
  if (render.wall_time_s !== null) rows.push(['Wall time', secondsLabel(render.wall_time_s)]);
  if (render.peak_ram_mb !== null) rows.push(['Peak RAM', render.peak_ram_mb + ' MB']);
  if (render.video !== null) rows.push(['Captions', captionLine]);

  const altParts: string[] = [];
  if (resolution !== null) altParts.push(resolution);
  if (fps !== null) altParts.push(fps);
  if (duration !== null) altParts.push(duration);
  const videoAlt =
    altParts.length === 0
      ? 'Rendered video.'
      : 'Rendered video: ' +
        altParts.join(', ') +
        (hasSrt || hasVtt ? ', captions available.' : '.');

  return { passLine, rows, resolution, fps, duration, videoAlt };
}

// ─────────────────────────────────────────────────────────────────────────────
// Approval
// ─────────────────────────────────────────────────────────────────────────────

export interface ReturnLink {
  readonly label: string;
  readonly href: string;
}

export interface ApprovalView {
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly reason: string | null;
  /** True when the seam or the revision is missing (gap S-15-1). */
  readonly unwired: boolean;
  readonly gateLine: string;
  readonly approvedLine: string | null;
  readonly revision: number | null;
  readonly noteMaxLength: number;
  readonly returnLinks: readonly ReturnLink[];
  readonly returnLine: string;
}

function approvalView(input: {
  readonly state: RenderPanelState;
  readonly render: RenderView | null;
  readonly qc: QCView;
  readonly revision: number | null;
  readonly approveWired: boolean;
  readonly links: VideoDetail['links'];
}): ApprovalView {
  const { state, render, qc, revision, approveWired, links } = input;
  const returnLinks: ReturnLink[] = [
    { label: 'Script', href: links.script },
    { label: 'Storyboard', href: links.storyboard },
    { label: 'Scenes', href: links.scenes },
    { label: 'Audio', href: links.audio },
  ];
  const base = {
    visible: true,
    gateLine: APPROVAL_GATE_LINE,
    revision,
    noteMaxLength: 2000,
    returnLinks,
    returnLine: RETURN_LINE,
  };

  if (state === 'approved' && render !== null) {
    const at = render.approved_at === null ? null : isoSeconds(render.approved_at);
    return {
      ...base,
      enabled: false,
      unwired: false,
      reason: null,
      approvedLine:
        'Final approval recorded' +
        (at === null ? '' : ' ' + at) +
        '. Export is enabled; nothing else changed.',
    };
  }

  const unwired = !approveWired || revision === null;
  let reason: string;
  if (unwired) {
    reason = APPROVAL_UNWIRED_REASON;
  } else if (state === 'qc_failed') {
    const first = qc.rows.find((row) => row.status === 'fail');
    reason =
      'Approval stays blocked: QC check ' +
      (first?.id ?? 'QC') +
      ' (' +
      (first?.requirement ?? 'R-010') +
      ') failed — measured ' +
      (first?.measured ?? '—') +
      ', expected ' +
      (first?.expected ?? '—') +
      '.';
  } else if (state === 'qc_running' || state === 'awaiting_approval') {
    const missing = qc.rows.filter((row) => !row.extra && row.status === 'missing');
    reason =
      missing.length === 0
        ? 'Approval stays blocked until QC reports: no check has a number yet.'
        : 'Approval stays blocked: QC has not reported ' +
          missing.length +
          ' of ' +
          qc.total +
          ' checks (' +
          missing.map((row) => row.id + ' ' + row.requirement).join(', ') +
          ').';
  } else if (state === 'stale') {
    reason =
      'The render is stale, so approval stays blocked. Re-render before approving: approval would sign output the pipeline no longer matches.';
  } else if (state === 'failed') {
    reason = 'The render failed, so there is nothing to approve.';
  } else if (state === 'running' || state === 'blocked' || state === 'empty') {
    reason = 'No render output exists yet, so there is nothing to approve.';
  } else {
    reason = 'Approval stays blocked.';
  }

  if (render === null || render.video === null) {
    if (state === 'awaiting_approval' || state === 'qc_failed' || state === 'stale') {
      reason = 'The render has no video asset, so there is nothing to approve.';
    }
  }

  const enabled =
    state === 'awaiting_approval' &&
    qc.allPass &&
    qc.complete &&
    render !== null &&
    render.video !== null &&
    !unwired;
  return {
    ...base,
    enabled,
    unwired,
    reason: enabled ? null : reason,
    approvedLine: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The surface model
// ─────────────────────────────────────────────────────────────────────────────

export interface RenderPanelModel {
  readonly videoId: string;
  readonly state: RenderPanelState;
  readonly heading: string;
  readonly chip: StageState;
  readonly chipLabel: string | null;
  readonly summaryLine: string | null;
  readonly detailLine: string | null;
  readonly staleLine: string | null;
  readonly emptyLine: string | null;
  readonly emptyUnlockLine: string | null;
  readonly failureNote: string | null;
  readonly leaveNote: string | null;
  readonly qc: QCView;
  readonly stats: RenderStatsView;
  readonly approval: ApprovalView;
  readonly videoHref: string | null;
  readonly posterHref: string | null;
  readonly vttHref: string | null;
  readonly srtHref: string | null;
  readonly safeArea: string;
  readonly monitoringNote: string;
}

function stateFor(input: {
  render: RenderView | null;
  detail: VideoDetail;
  qc: QCView;
}): RenderPanelState {
  const { render, detail } = input;
  const re = detail.stages.find((stage) => stage.stage === 'RE');
  const qc = detail.stages.find((stage) => stage.stage === 'QC');

  if (render === null) {
    if (re?.state === 'running') return 'running';
    if (re?.state === 'failed') return 'failed';
    if (re?.state === 'blocked') return 'blocked';
    if (re?.stale === true || re?.state === 'stale') return 'stale';
    if (qc?.state === 'running') return 'qc_running';
    return 'empty';
  }

  const stale =
    render.status === 'stale' || re?.stale === true || re?.state === 'stale' || qc?.stale === true;
  if (stale) return 'stale';
  if (render.approved) return 'approved';
  if (render.status === 'running') return 'running';
  if (render.status === 'failed') return 'failed';
  if (render.status === 'blocked') return 'blocked';
  if (render.status === 'not_run') return 'empty';
  if (render.qc.status === 'not_run') return 'qc_running';
  if (render.qc.status === 'fail') return 'qc_failed';
  if (!qcComplete(render)) return 'qc_running';
  return 'awaiting_approval';
}

function qcComplete(render: RenderView): boolean {
  return QC_CATALOGUE.every(
    (entry) => findCheck(render.qc.checks, entry.requirement) !== undefined,
  );
}

export function renderPanelModel(input: {
  readonly detail: VideoDetail;
  readonly render: RenderView | null;
  /** Gap S-15-1: null when the caller cannot supply the approve revision. */
  readonly revision: number | null;
  /** False when the gateway has no approve seam (same gap). */
  readonly approveWired: boolean;
}): RenderPanelModel {
  const { detail, render, revision, approveWired } = input;
  const qc = qcView(render?.qc.checks ?? [], render?.qc.checked_at ?? null);
  const state = stateFor({ render, detail, qc });
  const stats = render === null ? null : statsView(render);
  const re = detail.stages.find((stage) => stage.stage === 'RE');
  const reAttempts = re?.attempts;

  let summaryLine: string | null = null;
  let detailLine: string | null = null;

  if (state === 'running') {
    const total = re?.progress.total ?? 1;
    const current = total > 0 ? Math.max(1, re?.progress.current ?? 1) : 1;
    summaryLine =
      'Render ' +
      current +
      ' of ' +
      (total > 0 ? total : 1) +
      ' running (single concurrent render).';
    detailLine = 'One render slot. Queued renders wait for this one to finish.';
  } else if (state === 'blocked') {
    summaryLine = re?.blocked_reason ?? 'Render is blocked.';
    detailLine = 'One render slot. Nothing was started.';
  } else if (state === 'failed') {
    summaryLine =
      'RE failed · ' +
      (reAttempts?.last_error_class ?? 'unknown error') +
      ' · ' +
      (reAttempts?.count ?? 0) +
      ' of ' +
      (reAttempts?.max_attempts ?? 3) +
      ' attempts used.';
    detailLine = re?.blocked_reason ?? 'No provider call was made: the render is local FFmpeg.';
  } else if (state === 'qc_running') {
    summaryLine =
      'Render done (' +
      (render === null
        ? '1 pass'
        : render.render_passes + (render.render_passes === 1 ? ' pass' : ' passes')) +
      ') · QC running';
    detailLine = 'Approval stays blocked until every check reports its number.';
  } else if (state === 'awaiting_approval' || state === 'approved') {
    const facts: string[] = [];
    if (stats?.resolution != null) facts.push(stats.resolution);
    if (stats?.fps != null) facts.push(stats.fps);
    if (stats?.duration != null) facts.push(stats.duration);
    facts.push(qc.summaryLine);
    summaryLine = facts.join(' · ');
    detailLine =
      render === null
        ? null
        : render.render_passes +
          (render.render_passes === 1 ? ' render pass' : ' render passes') +
          (render.wall_time_s === null ? '' : ' · ' + secondsLabel(render.wall_time_s)) +
          (render.peak_ram_mb === null ? '' : ' · peak ' + render.peak_ram_mb + ' MB');
  } else if (state === 'qc_failed') {
    const passes = render === null ? 1 : render.render_passes;
    summaryLine =
      'Render done (' + passes + (passes === 1 ? ' pass' : ' passes') + ') · ' + qc.summaryLine;
    detailLine = qc.failingLine;
  } else if (state === 'stale') {
    summaryLine = stats === null ? null : stats.rows.map(([, value]) => value).join(' · ');
    detailLine = null;
  }

  const staleLine =
    state === 'stale'
      ? (re?.stale_cause ?? 'An edit made this render out of date.') +
        (re?.stale_at === null || re?.stale_at === undefined ? '' : ' · ' + isoSeconds(re.stale_at))
      : null;

  const failureNote =
    state === 'failed'
      ? 'The render failed before any output was written (' +
        (reAttempts?.count ?? 0) +
        ' of ' +
        (reAttempts?.max_attempts ?? 3) +
        ' attempts used' +
        (reAttempts?.last_error_class === null || reAttempts?.last_error_class === undefined
          ? ''
          : ', ' + reAttempts.last_error_class) +
        '). QC has not run and final approval is unavailable. ' +
        'A retry re-runs the render (1 pass) only: it reuses the ' +
        detail.scene_count +
        ' stored images, the approved script, the storyboard, the narration and the timing, and makes no provider call. ' +
        'Attempt rows and the retry scope are on Health (S-19).'
      : null;

  if (state === 'empty' && staleLine !== null) {
    // An empty state never claims a stale render; the rail carries the stage.
  }

  return {
    videoId: detail.id,
    state,
    heading: HEADINGS[state],
    chip: CHIPS[state],
    chipLabel: CHIP_LABELS[state],
    summaryLine,
    detailLine,
    staleLine,
    emptyLine: state === 'empty' ? EMPTY_LINE : null,
    emptyUnlockLine: state === 'empty' ? EMPTY_UNLOCK_LINE : null,
    failureNote,
    leaveNote: state === 'running' || state === 'blocked' ? LEAVE_NOTE : null,
    qc,
    stats: stats ?? {
      passLine: '0 passes',
      rows: [],
      resolution: null,
      fps: null,
      duration: null,
      videoAlt: 'No rendered video yet.',
    },
    approval: approvalView({
      state,
      render,
      qc,
      revision,
      approveWired,
      links: detail.links,
    }),
    videoHref: render?.video?.urls.full ?? null,
    posterHref: render?.poster?.urls.full ?? null,
    vttHref: render?.captions.vtt?.urls.full ?? null,
    srtHref: render?.captions.srt?.urls.full ?? null,
    safeArea: SAFE_AREA_LINE,
    monitoringNote: MONITORING_NOTE,
  };
}
