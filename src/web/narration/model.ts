/**
 * S-14 — Narration & timing view model (US-021, US-022, R-009-3, R-009-4,
 * UX_SPEC §8 S-14 row and A-18/A-19, UI_SPEC §9.5/§9.6).
 *
 * Everything here is a pure derivation of the frozen contract's
 * `NarrationViewSchema` plus the `VideoDetail` stage rows. Nothing is invented:
 * the band, the tolerance and the deviation are arithmetic on `duration_s`,
 * `target_duration_s` and `band`; the timings are the contract's `words`; the
 * provider/model/request id are the contract's `alignment`.
 *
 * Three deliberate honesty rules:
 *  - a take outside the band is never labelled accepted, and the copy says the
 *    video returned to review rather than that the speech was stretched
 *    (R-009-4);
 *  - word coverage is reported against `word_count`, so a short `words` array
 *    cannot look complete;
 *  - `audio.accept` needs an `alignment_id` the response does not carry (gap
 *    S-14-1), so the control explains that instead of posting a guessed id.
 *
 * This module is imported by the server renderer and by the client enhancer
 * (`/assets/narration/model.js`), so it must stay free of Node-only imports.
 */
import type { z } from 'zod';

import type { NarrationViewSchema } from '../../../contract/api.js';
import type { StageState } from '../../shared/stages.js';
import { isoSeconds } from '../format.js';
import type { VideoDetail } from '../workspace/model.js';

export type NarrationView = z.infer<typeof NarrationViewSchema>;

/** One TTS call is the whole cost of a narration re-run (UX_SPEC A-18). */
export const TTS_CALLS_PER_RUN = 1;
/** UX_SPEC §8, S-14 loading cell: "1 TTS call running (11 s typical)". */
export const TTS_TYPICAL_LATENCY_S = 11;

/** S-14-1: `audio.accept` takes an `alignment_id` that `audio.get` never returns. */
export const ACCEPT_UNWIRED_REASON =
  'The narration endpoint does not expose the alignment id that accepting needs, ' +
  'so this control cannot be sent. The derived timings above are shown in full.';

/** R-009-4: a miss returns to review; there is nothing to accept. */
export const ACCEPT_OUT_OF_BAND_REASON =
  'The duration is outside the band, so there is nothing to accept yet. ' +
  'Tighten the script or change the voice; the video is back in review.';

// ─────────────────────────────────────────────────────────────────────────────
// Number formatting (UI_SPEC §9.6)
// ─────────────────────────────────────────────────────────────────────────────

function pad2(value: number): string {
  return value < 10 ? '0' + value : String(value);
}

function oneDecimal(value: number): string {
  return value.toFixed(1);
}

/** Durations: one decimal with `s` — `79.1 s`, `75.0 s`. */
export function formatSeconds(value: number): string {
  return oneDecimal(value) + ' s';
}

/** A target stays an integer when it is one: `75 s`, not `75.0 s`. */
export function formatTargetSeconds(value: number): string {
  return (Number.isInteger(value) ? String(value) : oneDecimal(value)) + ' s';
}

/** The audio transport's `mm:ss.s` — `05:12.0` (UI_SPEC §9.6). */
export function formatTransportTime(ms: number): string {
  const tenths = Math.max(0, Math.floor(ms / 100));
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return pad2(minutes) + ':' + pad2(seconds) + '.' + (tenths % 10);
}

function signed(value: number, unit = ''): string {
  const sign = value < 0 ? '-' : '+';
  return sign + Math.abs(value).toFixed(1) + unit;
}

/** Binary units, one decimal (UI_SPEC §9.6): `6.2 GB`, `41.2 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return (unit === 0 ? String(Math.trunc(value)) : oneDecimal(value)) + ' ' + units[unit];
}

// ─────────────────────────────────────────────────────────────────────────────
// Duration vs the ±5 % band (R-009-3)
// ─────────────────────────────────────────────────────────────────────────────

export interface BandView {
  readonly withinBand: boolean;
  readonly actualLabel: string | null;
  readonly targetLabel: string;
  readonly bandLabel: string;
  readonly toleranceLabel: string;
  /** True when the ±5 % band was clamped to ±1 s…±5 s (R-009-3). */
  readonly clamped: boolean;
  readonly deviationLabel: string | null;
  readonly verdict: string;
  /** The A-19 sentence, present only when the take is outside the band. */
  readonly sentence: string | null;
}

export function bandView(narration: NarrationView): BandView {
  const target = narration.target_duration_s;
  const min = narration.band.min_s;
  const max = narration.band.max_s;
  const tolerance = (max - min) / 2;
  const tolerancePercent = target > 0 ? (tolerance / target) * 100 : 0;
  const clamped = Math.abs(tolerancePercent - 5) > 1e-9;
  const clampNumber = Number.isInteger(tolerance) ? String(tolerance) : oneDecimal(tolerance);
  const toleranceLabel = clamped
    ? '±' +
      oneDecimal(tolerance) +
      ' s (clamped to ' +
      (tolerance <= 1 ? 'at least' : 'at most') +
      ' ±' +
      clampNumber +
      ' s)'
    : '±' + oneDecimal(tolerance) + ' s (±' + Math.round(tolerancePercent) + '%)';

  const base: BandView = {
    withinBand: narration.band.within_band,
    actualLabel: narration.duration_s === null ? null : formatSeconds(narration.duration_s),
    targetLabel: formatTargetSeconds(target),
    bandLabel: oneDecimal(min) + '–' + oneDecimal(max) + ' s',
    toleranceLabel,
    clamped,
    deviationLabel: null,
    verdict: narration.duration_s === null ? 'No take yet' : 'Within band',
    sentence: null,
  };

  if (narration.duration_s === null) return base;

  const deltaS = narration.duration_s - target;
  const deltaPct = target > 0 ? (deltaS / target) * 100 : 0;
  const deviationLabel = signed(deltaS) + ' s (' + signed(deltaPct) + '%)';

  if (narration.band.within_band) {
    return { ...base, deviationLabel };
  }

  const outside = clamped
    ? 'outside ±' +
      oneDecimal(tolerance) +
      ' s (the ±' +
      clampNumber +
      ' s clamp for a ' +
      formatTargetSeconds(target) +
      ' target)'
    : 'outside ±' + Math.round(tolerancePercent) + '%';
  const sentence = clamped
    ? 'Actual ' +
      formatSeconds(narration.duration_s) +
      ' vs target ' +
      formatTargetSeconds(target) +
      ' = ' +
      signed(deltaPct) +
      '%, ' +
      outside +
      '. The video returned to script/voice review; the speech was not time-stretched (R-009-4).'
    : 'Actual ' +
      formatSeconds(narration.duration_s) +
      ' vs target ' +
      formatTargetSeconds(target) +
      ' = ' +
      signed(deltaPct) +
      '%, ' +
      outside +
      '. The video returned to script review; speech was not time-stretched.';

  return { ...base, deviationLabel, verdict: 'Outside band', sentence };
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived word timings (US-022)
// ─────────────────────────────────────────────────────────────────────────────

export interface WordTimingRow {
  readonly index: number;
  readonly word: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly startLabel: string;
  readonly spanLabel: string;
}

export interface WordsView {
  readonly rows: readonly WordTimingRow[];
  readonly totalWords: number;
  readonly derivedWords: number;
  readonly coverageLine: string;
  readonly monotonic: boolean;
  readonly monotonicLine: string | null;
  readonly firstLabel: string | null;
  readonly lastLabel: string | null;
}

export function wordsView(narration: NarrationView): WordsView {
  const rows: WordTimingRow[] = narration.words.map((word, index) => ({
    index,
    word: word.word,
    startMs: word.start_ms,
    endMs: word.end_ms,
    startLabel: formatTransportTime(word.start_ms),
    spanLabel: formatSeconds((word.end_ms - word.start_ms) / 1000),
  }));

  const totalWords = narration.word_count;
  const derivedWords = rows.length;
  let coverageLine: string;
  if (totalWords === 0) {
    coverageLine = 'No word timings derived.';
  } else if (derivedWords === totalWords) {
    coverageLine = totalWords + ' ' + (totalWords === 1 ? 'word' : 'words') + ' · all timed';
  } else {
    const percent = (derivedWords / totalWords) * 100;
    coverageLine =
      derivedWords + ' of ' + totalWords + ' words timed (' + oneDecimal(percent) + '%)';
  }

  let violation = -1;
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    if (previous === undefined || current === undefined) continue;
    if (current.startMs < previous.startMs || current.startMs < previous.endMs) {
      violation = index;
      break;
    }
  }
  const monotonic = violation < 0;
  const monotonicLine = monotonic
    ? null
    : 'Word timings are not monotonic at word ' +
      (violation + 1) +
      ' ("' +
      (rows[violation]?.word ?? '') +
      '"); captions built from them would be unreliable.';

  return {
    rows,
    totalWords,
    derivedWords,
    coverageLine,
    monotonic,
    monotonicLine,
    firstLabel: rows[0]?.startLabel ?? null,
    lastLabel: rows.length === 0 ? null : formatTransportTime(rows[rows.length - 1]?.endMs ?? 0),
  };
}

/**
 * The word being spoken at `ms`: the last word that has started. A gap between
 * words keeps the previous word highlighted rather than flickering to none.
 */
export function wordIndexAt(rows: readonly WordTimingRow[], ms: number): number {
  let found = -1;
  for (const row of rows) {
    if (row.startMs <= ms) found = row.index;
    else break;
  }
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// The surface model
// ─────────────────────────────────────────────────────────────────────────────

export type NarrationState =
  'empty' | 'blocked' | 'running' | 'failed' | 'stale' | 'out_of_band' | 'ready';

export interface AcceptView {
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly reason: string | null;
  readonly acceptedLine: string | null;
}

export interface RerunView {
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly reason: string | null;
  readonly label: string;
  readonly callLine: string;
  /** C-17 / R-022-2: exactly what re-runs and what survives, stated first. */
  readonly scopeLine: string;
}

export interface NarrationModel {
  readonly videoId: string;
  readonly alignmentId: string | null;
  readonly state: NarrationState;
  readonly heading: string;
  readonly chip: StageState;
  readonly chipLabel: string | null;
  readonly summaryLine: string | null;
  readonly detailLine: string | null;
  readonly emptyLine: string | null;
  readonly staleLine: string | null;
  readonly assetHref: string | null;
  readonly band: BandView | null;
  readonly words: WordsView | null;
  readonly alignmentLines: readonly (readonly [string, string])[];
  readonly accept: AcceptView;
  readonly rerun: RerunView;
  readonly scriptHref: string;
  readonly returnHref: string | null;
}

const CHIP_LABELS: Readonly<Record<NarrationState, string | null>> = {
  ready: 'Within band',
  out_of_band: 'Outside band',
  running: null,
  failed: null,
  blocked: null,
  empty: 'Not run',
  stale: null,
};

const HEADINGS: Readonly<Record<NarrationState, string>> = {
  ready: 'Narration and timing',
  out_of_band: 'Timing outside the band',
  running: 'Narration running',
  failed: 'Narration failed',
  blocked: 'Narration is blocked',
  empty: 'No narration yet',
  stale: 'Narration is stale',
};

const CHIPS: Readonly<Record<NarrationState, StageState>> = {
  ready: 'done',
  out_of_band: 'failed',
  running: 'running',
  failed: 'failed',
  blocked: 'blocked',
  empty: 'not_run',
  stale: 'stale',
};

export const EMPTY_LINE = 'No narration yet. It runs after script approval.';

export function narrationModel(input: {
  readonly detail: VideoDetail;
  readonly narration: NarrationView | null;
  /** S-14-1: null in every build today — the contract exposes no alignment id. */
  readonly alignmentId: string | null;
  /** False when the gateway has no accept seam (same gap). */
  readonly acceptWired: boolean;
}): NarrationModel {
  const { detail, narration, alignmentId, acceptWired } = input;
  const na = detail.stages.find((stage) => stage.stage === 'NA');
  const state = narrationState(narration, na);

  const band = narration === null ? null : bandView(narration);
  const words = narration === null ? null : wordsView(narration);
  const duration = narration?.duration_s ?? null;
  const acceptedLine =
    narration?.accepted_at === undefined || narration.accepted_at === null
      ? null
      : 'Timing accepted ' + isoSeconds(narration.accepted_at) + '.';

  const attempts = na?.attempts;
  const maxAttempts = attempts?.max_attempts ?? 3;
  const attemptsUsed = attempts?.count ?? 0;

  let summaryLine: string | null;
  let detailLine: string | null = null;
  if (state === 'running') {
    summaryLine = '1 TTS call running (' + TTS_TYPICAL_LATENCY_S + ' s typical)';
    detailLine = 'Attempt ' + Math.max(1, attemptsUsed) + ' of ' + maxAttempts + '.';
  } else if (state === 'failed') {
    summaryLine =
      'TTS failed: ' +
      (attempts?.last_error_class ?? 'unknown error') +
      ' · ' +
      attemptsUsed +
      ' of ' +
      maxAttempts +
      ' attempts used.';
  } else if (state === 'blocked') {
    summaryLine = na?.blocked_reason ?? 'Narration is blocked.';
  } else if (state === 'empty') {
    summaryLine = null;
  } else if (narration !== null && duration !== null) {
    const prefix = narration.word_count > 0 ? narration.word_count + ' words · ' : '';
    summaryLine =
      prefix +
      formatSeconds(duration) +
      ' · ' +
      oneDecimal(narration.band.min_s) +
      '–' +
      oneDecimal(narration.band.max_s) +
      ' s';
    if (state === 'stale') summaryLine = summaryLine + ' · stale';
    if (narration.alignment !== null) {
      detailLine = narration.alignment.provider + ' · ' + narration.alignment.model;
    }
  } else {
    summaryLine = null;
  }

  const staleLine =
    state === 'stale'
      ? (na?.stale_cause ?? 'The script changed after this take was recorded.') +
        (na?.stale_at === null || na?.stale_at === undefined ? '' : ' · ' + isoSeconds(na.stale_at))
      : null;

  const visible =
    acceptedLine === null &&
    narration !== null &&
    duration !== null &&
    (state === 'ready' || state === 'out_of_band' || state === 'stale');
  const acceptEnabled =
    visible &&
    narration !== null &&
    narration.band.within_band &&
    alignmentId !== null &&
    acceptWired;
  let acceptReason: string | null = null;
  if (visible && narration !== null && !narration.band.within_band) {
    acceptReason = ACCEPT_OUT_OF_BAND_REASON;
  } else if (visible && (alignmentId === null || !acceptWired)) {
    acceptReason = ACCEPT_UNWIRED_REASON;
  }

  const rerunVisible =
    state === 'ready' ||
    state === 'out_of_band' ||
    state === 'stale' ||
    state === 'failed' ||
    state === 'running';
  const rerunEnabled = rerunVisible && state !== 'running';

  const sceneCount = detail.scene_count;
  const scopeLine =
    'Retry will re-run narration (1 TTS call), timing and the render (1 pass). ' +
    'It will not re-run the ' +
    sceneCount +
    ' images, the approved script, the storyboard or the research. ' +
    'Retrying reuses every stored asset: no new provider call is made for a completed stage.';

  const alignmentLines: (readonly [string, string])[] = [];
  if (narration !== null && narration.alignment !== null) {
    alignmentLines.push(
      ['Provider', narration.alignment.provider],
      ['Model', narration.alignment.model],
      ['Request id', narration.alignment.request_id ?? 'not recorded'],
    );
  }
  if (narration !== null && narration.asset !== null) {
    const asset = narration.asset;
    alignmentLines.push(
      ['Audio asset', asset.id],
      ['sha256', asset.content_sha256],
      ['Size', formatBytes(asset.size_bytes)],
      [
        'Pin',
        asset.provenance.series_version === null ? '—' : 'v' + asset.provenance.series_version,
      ],
      ['Created', isoSeconds(asset.provenance.created_at)],
    );
  }

  return {
    videoId: detail.id,
    alignmentId,
    state,
    heading: HEADINGS[state],
    chip: CHIPS[state],
    chipLabel: CHIP_LABELS[state],
    summaryLine,
    detailLine,
    emptyLine: state === 'empty' ? EMPTY_LINE : null,
    staleLine,
    assetHref: narration?.asset?.urls.full ?? null,
    band,
    words,
    alignmentLines,
    accept: {
      visible,
      enabled: acceptEnabled,
      reason: acceptReason,
      acceptedLine,
    },
    rerun: {
      visible: rerunVisible,
      enabled: rerunEnabled,
      reason: state === 'running' ? 'Narration is already running.' : null,
      label: 'Re-run narration (' + TTS_CALLS_PER_RUN + ' TTS call)',
      callLine: TTS_CALLS_PER_RUN + ' TTS call',
      scopeLine,
    },
    scriptHref: '/videos/' + encodeURIComponent(detail.id) + '/script',
    returnHref:
      state === 'out_of_band' ? '/videos/' + encodeURIComponent(detail.id) + '/script' : null,
  };
}

function narrationState(
  narration: NarrationView | null,
  na: VideoDetail['stages'][number] | undefined,
): NarrationState {
  const stageState = na?.state;
  if (narration !== null) {
    const status = narration.status;
    const stale = na?.stale === true || status === 'stale';
    if (status === 'running') return 'running';
    if (status === 'failed') return 'failed';
    if (status === 'blocked') return 'blocked';
    if (stale) return 'stale';
    if (narration.duration_s !== null && !narration.band.within_band) return 'out_of_band';
    return 'ready';
  }
  if (stageState === 'running') return 'running';
  if (stageState === 'failed') return 'failed';
  if (stageState === 'blocked') return 'blocked';
  if (stageState === 'stale' || na?.stale === true) return 'stale';
  return 'empty';
}
