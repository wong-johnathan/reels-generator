/**
 * The SSE progress feed — UX_SPEC IP-05/AX-27, contract `SseEventSchema`.
 *
 * This module is deliberately browser-safe: it imports only the plain string
 * vocabularies from `src/shared` (no zod, no node built-ins), because the same
 * file is served as an ES module to the page. Validation is hand-written
 * against the contract's five event variants and **fails closed**: a frame
 * that does not match is dropped rather than applied half-way.
 *
 * `tests/web/workspace-events.test.ts` pins the accepted variants to
 * `SseEventSchema.options`, so a contract change breaks the build here.
 */
import {
  STAGE_CODES,
  STAGE_LABELS,
  isStageCode,
  isStageState,
  type StageCode,
  type StageState,
} from '../../shared/stages.js';
import {
  ATTENTION_KINDS,
  BATCH_STATES,
  VIDEO_STATES,
  type AttentionKind,
  type BatchState,
  type VideoState,
} from '../../shared/states.js';

export type { StageCode, StageState, VideoState, AttentionKind, BatchState };

/** The eight state words of UI_SPEC §3.1 (the enhancer re-renders them live). */
export const FEED_STATE_WORDS: Readonly<Record<StageState, string>> = {
  not_run: 'NOT RUN',
  running: 'RUNNING',
  done: 'DONE',
  awaiting_approval: 'AWAITING APPROVAL',
  stale: 'STALE',
  failed: 'FAILED',
  blocked: 'BLOCKED',
  cancelled: 'CANCELLED',
};

/** Rail nodes abbreviate one word: UI_SPEC §3.1 says `AWAITING` on the rail. */
export const FEED_RAIL_WORDS: Readonly<Record<StageState, string>> = {
  ...FEED_STATE_WORDS,
  awaiting_approval: 'AWAITING',
};

export interface StageUpdated {
  readonly type: 'stage.updated';
  readonly video_id: string;
  readonly stage: StageCode;
  readonly state: StageState;
  readonly stale: boolean;
  readonly occurred_at: string;
}

export interface VideoUpdated {
  readonly type: 'video.updated';
  readonly video_id: string;
  readonly status: VideoState;
  readonly current_stage: StageCode;
  readonly attention_kind: AttentionKind;
  readonly attention_reason: string | null;
  readonly occurred_at: string;
}

export interface BatchProgress {
  readonly type: 'batch.progress';
  readonly batch_id: string;
  readonly completed_count: number;
  readonly target_count: number;
  readonly status: BatchState;
  readonly occurred_at: string;
}

export interface HealthChanged {
  readonly type: 'health.changed';
  readonly ready: boolean;
  readonly degraded_reasons: readonly string[];
  readonly occurred_at: string;
}

export interface Ping {
  readonly type: 'ping';
  readonly occurred_at: string;
}

export type FeedEvent = StageUpdated | VideoUpdated | BatchProgress | HealthChanged | Ping;

export const FEED_EVENT_TYPES = [
  'stage.updated',
  'video.updated',
  'batch.progress',
  'health.changed',
  'ping',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Parsing — fail closed
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isCount(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/** Parse one SSE `data:` payload; `null` when it is not a contract event. */
export function parseSseEvent(data: string): FeedEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const occurred = value['occurred_at'];
  if (!isTimestamp(occurred)) return null;

  switch (value['type']) {
    case 'stage.updated': {
      const stage = value['stage'];
      const state = value['state'];
      if (typeof value['video_id'] !== 'string') return null;
      if (!isStageCode(stage as string) || !isStageState(state as string)) return null;
      if (typeof value['stale'] !== 'boolean') return null;
      return {
        type: 'stage.updated',
        video_id: value['video_id'],
        stage: stage as StageCode,
        state: state as StageState,
        stale: value['stale'],
        occurred_at: occurred,
      };
    }
    case 'video.updated': {
      const status = value['status'];
      const current = value['current_stage'];
      const kind = value['attention_kind'];
      const reason = value['attention_reason'];
      if (typeof value['video_id'] !== 'string') return null;
      if (!isOneOf(status, VIDEO_STATES)) return null;
      if (!isStageCode(current as string)) return null;
      if (!isOneOf(kind, ATTENTION_KINDS)) return null;
      if (reason !== null && typeof reason !== 'string') return null;
      return {
        type: 'video.updated',
        video_id: value['video_id'],
        status,
        current_stage: current as StageCode,
        attention_kind: kind,
        attention_reason: reason,
        occurred_at: occurred,
      };
    }
    case 'batch.progress': {
      const status = value['status'];
      if (typeof value['batch_id'] !== 'string') return null;
      if (!isCount(value['completed_count'], 0)) return null;
      if (!isCount(value['target_count'], 1)) return null;
      if (!isOneOf(status, BATCH_STATES)) return null;
      return {
        type: 'batch.progress',
        batch_id: value['batch_id'],
        completed_count: value['completed_count'],
        target_count: value['target_count'],
        status,
        occurred_at: occurred,
      };
    }
    case 'health.changed': {
      const reasons = value['degraded_reasons'];
      if (typeof value['ready'] !== 'boolean') return null;
      if (!Array.isArray(reasons) || !reasons.every((entry) => typeof entry === 'string')) {
        return null;
      }
      return {
        type: 'health.changed',
        ready: value['ready'],
        degraded_reasons: reasons as string[],
        occurred_at: occurred,
      };
    }
    case 'ping':
      return { type: 'ping', occurred_at: occurred };
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reducer
// ─────────────────────────────────────────────────────────────────────────────

export interface StageSnapshot {
  readonly state: StageState;
  readonly stale: boolean;
}

export interface VideoSnapshot {
  readonly status: VideoState;
  readonly currentStage: StageCode;
  readonly attentionKind: AttentionKind;
  readonly attentionReason: string | null;
}

export interface BatchSnapshot {
  readonly completed: number;
  readonly total: number;
  readonly status: BatchState;
}

export interface FeedState {
  readonly stages: Readonly<Record<string, StageSnapshot>>;
  readonly video: VideoSnapshot | null;
  readonly batches: Readonly<Record<string, BatchSnapshot>>;
  readonly ready: boolean | null;
  readonly lastEventAt: string | null;
}

export function emptyFeedState(): FeedState {
  return { stages: {}, video: null, batches: {}, ready: null, lastEventAt: null };
}

/** Seed the feed from the server-rendered `VideoDetail` (SSR stays the truth). */
export function initialFeedState(detail: {
  readonly status: string;
  readonly current_stage: string;
  readonly attention_kind: string;
  readonly attention_reason: string | null;
  readonly stages: readonly {
    readonly stage: string;
    readonly state: string;
    readonly stale: boolean;
  }[];
}): FeedState {
  const stages: Record<string, StageSnapshot> = {};
  for (const stage of detail.stages) {
    if (!isStageCode(stage.stage) || !isStageState(stage.state)) continue;
    stages[stage.stage] = { state: stage.state, stale: stage.stale };
  }
  return {
    stages,
    video:
      isOneOf(detail.status, VIDEO_STATES) &&
      isStageCode(detail.current_stage) &&
      isOneOf(detail.attention_kind, ATTENTION_KINDS)
        ? {
            status: detail.status,
            currentStage: detail.current_stage,
            attentionKind: detail.attention_kind,
            attentionReason: detail.attention_reason,
          }
        : null,
    batches: {},
    ready: null,
    lastEventAt: null,
  };
}

export function applyFeedEvent(state: FeedState, event: FeedEvent): FeedState {
  const base = { ...state, lastEventAt: event.occurred_at };
  switch (event.type) {
    case 'stage.updated':
      return {
        ...base,
        stages: { ...state.stages, [event.stage]: { state: event.state, stale: event.stale } },
      };
    case 'video.updated':
      return {
        ...base,
        video: {
          status: event.status,
          currentStage: event.current_stage,
          attentionKind: event.attention_kind,
          attentionReason: event.attention_reason,
        },
      };
    case 'batch.progress':
      return {
        ...base,
        batches: {
          ...state.batches,
          [event.batch_id]: {
            completed: event.completed_count,
            total: event.target_count,
            status: event.status,
          },
        },
      };
    case 'health.changed':
      return { ...base, ready: event.ready };
    case 'ping':
      return base;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Announcements (AX-07/AX-10: one polite sentence, never per row)
// ─────────────────────────────────────────────────────────────────────────────

/** `Images: running.` — one template, one word per state (AX-20). */
export function eventAnnouncement(event: FeedEvent): string | null {
  switch (event.type) {
    case 'stage.updated':
      return STAGE_LABELS[event.stage] + ': ' + FEED_STATE_WORDS[event.state].toLowerCase() + '.';
    case 'video.updated':
      return event.attention_kind === 'none'
        ? null
        : 'Needs attention: ' + (event.attention_reason ?? event.attention_kind) + '.';
    case 'health.changed':
      return event.ready ? 'Service ready.' : 'Service degraded.';
    case 'ping':
    case 'batch.progress':
      return null;
  }
}

/** The pipeline order, re-exported so the enhancer never hard-codes it. */
export const FEED_STAGE_ORDER: readonly StageCode[] = STAGE_CODES;

/** `NA, TC, RE` for the ribbon summary. */
export function staleCodes(stages: Readonly<Record<string, StageSnapshot>>): StageCode[] {
  return STAGE_CODES.filter((code) => stages[code]?.stale === true);
}

/**
 * UC-05's threshold, restated on the feed state: three or more consecutive
 * stale stages are shown as one ribbon; shorter runs stay node-level.
 */
export function ribbonCodes(stages: Readonly<Record<string, StageSnapshot>>): StageCode[] {
  const runs: StageCode[][] = [];
  let run: StageCode[] = [];
  for (const code of STAGE_CODES) {
    if (stages[code]?.stale === true) {
      run.push(code);
      continue;
    }
    if (run.length > 0) runs.push(run);
    run = [];
  }
  if (run.length > 0) runs.push(run);
  return runs.filter((candidate) => candidate.length >= 3).flat();
}

// ─────────────────────────────────────────────────────────────────────────────
// Chip wording shared by the server renderer and the enhancer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The header chip's state for a video (UC-04): COMPLETE/RUNNING/CANCELLED/
 * NOT_STARTED map directly; NEEDS_ATTENTION borrows its stage's state so the
 * chip says `FAILED`/`BLOCKED`/`AWAITING` rather than a ninth state name.
 */
export function chipStateFor(status: string, stageState: StageState): StageState {
  switch (status) {
    case 'COMPLETE':
      return 'done';
    case 'RUNNING':
      return 'running';
    case 'CANCELLED':
      return 'cancelled';
    case 'NOT_STARTED':
      return 'not_run';
    default:
      return stageState;
  }
}

/**
 * `video.updated` carries the attention *kind*, not the stage state, so the
 * chip resolves from the kind — which is also what the operator is told.
 */
export function chipStateForEvent(
  status: string,
  kind: AttentionKind,
  stageState: StageState | null,
): StageState {
  if (status === 'NEEDS_ATTENTION') {
    switch (kind) {
      case 'approval':
        return 'awaiting_approval';
      case 'failed':
        return 'failed';
      case 'blocked':
        return 'blocked';
      case 'waiting':
        return 'blocked';
      case 'resumed':
        return 'running';
      default:
        return stageState ?? 'awaiting_approval';
    }
  }
  return chipStateFor(status, stageState ?? 'not_run');
}

/** `sm` chips are uppercase; `md`/`lg` are sentence case (UI_SPEC §3.1). */
export function sentenceState(state: StageState): string {
  const word = FEED_STATE_WORDS[state].toLowerCase();
  return word.charAt(0).toUpperCase() + word.slice(1);
}
