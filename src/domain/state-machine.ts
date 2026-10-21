/**
 * Workflow state machine — TECH_DESIGN §4.2 (stages), §4.5 (video), §4.6 (batch).
 *
 * This module is the single source of truth for every legal transition. Every
 * write to `video_stage.state` must route through `transitionStage`
 * (LEAD_PLAN §3: "the only module allowed to write video_stage.state"); no
 * other module may mutate a stage state directly. Each transition is a guarded,
 * table-driven function: a legal transition returns its target state and an
 * illegal one throws `IllegalTransitionError`.
 *
 * The three transition tables are the spec, not code: they are checked
 * verbatim against TECH_DESIGN §4.2/§4.5/§4.6 in the test suite.
 */
import type { BatchState, StageState, VideoState } from '../shared/index.js';

/** Events that drive a stage transition (the §4.2 "trigger" column). */
export const STAGE_EVENTS = [
  'claim',
  'block',
  'unblock',
  'succeed',
  'fail',
  'gate',
  'approve',
  'reject_no_edit',
  'invalidate',
  'regenerate',
  'accept_staleness',
  'retry',
  'cancel',
] as const;
export type StageEvent = (typeof STAGE_EVENTS)[number];

/** Events that drive a video-level transition (§4.5 "driver" column). */
export const VIDEO_EVENTS = [
  'first_claim',
  'needs_attention',
  'final_approve',
  'resume',
  'reopen',
  'cancel',
] as const;
export type VideoEvent = (typeof VIDEO_EVENTS)[number];

/** Events that drive a batch transition (§4.6). */
export const BATCH_EVENTS = ['all_complete', 'cancel', 'reopen'] as const;
export type BatchEvent = (typeof BATCH_EVENTS)[number];

/** Thrown when a transition is not legal for the given (state, event). */
export class IllegalTransitionError extends Error {
  readonly kind: 'stage' | 'video' | 'batch';
  readonly from: string;
  readonly event: string;

  constructor(kind: 'stage' | 'video' | 'batch', from: string, event: string) {
    super(`illegal ${kind} transition: ${from} --${event}--> rejected`);
    this.name = 'IllegalTransitionError';
    this.kind = kind;
    this.from = from;
    this.event = event;
  }
}

type StageTransitionTable = Readonly<
  Record<StageState, Readonly<Partial<Record<StageEvent, StageState>>>>
>;
type VideoTransitionTable = Readonly<
  Record<VideoState, Readonly<Partial<Record<VideoEvent, VideoState>>>>
>;
type BatchTransitionTable = Readonly<
  Record<BatchState, Readonly<Partial<Record<BatchEvent, BatchState>>>>
>;

/** §4.2 legal stage transitions (from → event → to). */
export const STAGE_TRANSITIONS: StageTransitionTable = {
  not_run: { claim: 'running', block: 'blocked', cancel: 'cancelled' },
  running: { succeed: 'done', fail: 'failed', gate: 'awaiting_approval', cancel: 'cancelled' },
  done: { invalidate: 'stale', cancel: 'cancelled' },
  awaiting_approval: {
    approve: 'done',
    reject_no_edit: 'awaiting_approval',
    invalidate: 'stale',
    cancel: 'cancelled',
  },
  stale: { regenerate: 'running', accept_staleness: 'done', cancel: 'cancelled' },
  failed: { retry: 'running', cancel: 'cancelled' },
  blocked: { unblock: 'not_run', cancel: 'cancelled' },
  cancelled: {},
};

/** §4.5 video-level transitions (from → event → to). */
export const VIDEO_TRANSITIONS: VideoTransitionTable = {
  NOT_STARTED: { first_claim: 'RUNNING', cancel: 'CANCELLED' },
  RUNNING: { needs_attention: 'NEEDS_ATTENTION', final_approve: 'COMPLETE', cancel: 'CANCELLED' },
  NEEDS_ATTENTION: { resume: 'RUNNING', final_approve: 'COMPLETE', cancel: 'CANCELLED' },
  COMPLETE: { reopen: 'NEEDS_ATTENTION', cancel: 'CANCELLED' },
  CANCELLED: {},
};

/**
 * §4.6 batch transitions. `COMPLETE → CANCELLED` is deliberately absent: the
 * only way out of a completed batch is an edit/reopen (a completed batch is not
 * cancellable per the §4.6 table).
 */
export const BATCH_TRANSITIONS: BatchTransitionTable = {
  ACTIVE: { all_complete: 'COMPLETE', cancel: 'CANCELLED' },
  COMPLETE: { reopen: 'ACTIVE' },
  CANCELLED: {},
};

/** Apply a stage transition; throws `IllegalTransitionError` when not legal. */
export function transitionStage(from: StageState, event: StageEvent): StageState {
  const to = STAGE_TRANSITIONS[from][event];
  if (to === undefined) throw new IllegalTransitionError('stage', from, event);
  return to;
}

/** Apply a video-level transition; throws `IllegalTransitionError` when not legal. */
export function transitionVideo(from: VideoState, event: VideoEvent): VideoState {
  const to = VIDEO_TRANSITIONS[from][event];
  if (to === undefined) throw new IllegalTransitionError('video', from, event);
  return to;
}

/** Apply a batch transition; throws `IllegalTransitionError` when not legal. */
export function transitionBatch(from: BatchState, event: BatchEvent): BatchState {
  const to = BATCH_TRANSITIONS[from][event];
  if (to === undefined) throw new IllegalTransitionError('batch', from, event);
  return to;
}

/** Whether some event legally drives `from → to`. */
export function isLegalStageTransition(from: StageState, to: StageState): boolean {
  return (Object.values(STAGE_TRANSITIONS[from]) as readonly StageState[]).includes(to);
}

/** Whether some event legally drives `from → to`. */
export function isLegalVideoTransition(from: VideoState, to: VideoState): boolean {
  return (Object.values(VIDEO_TRANSITIONS[from]) as readonly VideoState[]).includes(to);
}

/** Whether some event legally drives `from → to`. */
export function isLegalBatchTransition(from: BatchState, to: BatchState): boolean {
  return (Object.values(BATCH_TRANSITIONS[from]) as readonly BatchState[]).includes(to);
}
