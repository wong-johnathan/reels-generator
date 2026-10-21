/**
 * Retry scope from persisted state — TECH_DESIGN §7.3, R-022-2, IP-06.
 *
 * Before any retry (manual or resume) the worker computes the scope from
 * persisted stage state and stores it on `job.retry_scope` before the job runs.
 * The guarantee is true by construction: re-running reuses stored assets, so a
 * completed stage produces zero new billable calls.
 */
import {
  PRODUCING_STAGE_CODES,
  STAGE_CODES,
  STAGE_LABELS,
  STAGE_ORDER,
  type ErrorClass,
  type StageCode,
  type StageState,
} from '../shared/index.js';
import type { CallCounts } from './invalidation.js';

/**
 * Per-stage call cost — TECH_DESIGN §4.7 (which stages write `generation_run`
 * rows). `IM`'s image count is one per scene and is filled from `sceneCount` at
 * compute time; `RS` is modelled as a single text operation for scope display
 * (the search/fetch fan-out is variable and reported by the adapter, not here).
 */
export const STAGE_CALL_COSTS: Readonly<Record<StageCode, CallCounts>> = {
  T: { image: 0, tts: 0, text: 1, render_passes: 0 },
  RS: { image: 0, tts: 0, text: 1, render_passes: 0 },
  SC: { image: 0, tts: 0, text: 1, render_passes: 0 },
  SB: { image: 0, tts: 0, text: 1, render_passes: 0 },
  IM: { image: 0, tts: 0, text: 0, render_passes: 0 },
  NA: { image: 0, tts: 1, text: 0, render_passes: 0 },
  TC: { image: 0, tts: 0, text: 0, render_passes: 0 },
  RE: { image: 0, tts: 0, text: 0, render_passes: 1 },
  QC: { image: 0, tts: 0, text: 0, render_passes: 0 },
  FA: { image: 0, tts: 0, text: 0, render_passes: 0 },
  EX: { image: 0, tts: 0, text: 0, render_passes: 0 },
};

/** A persisted stage's state plus its stale flag (`video_stage`). */
export interface RetryStage {
  readonly state: StageState;
  readonly stale: boolean;
}

export interface RetryScopeInput {
  /** The failed/stale stage being retried. */
  readonly stage: StageCode;
  readonly stages: Readonly<Partial<Record<StageCode, RetryStage>>>;
  readonly sceneCount: number;
  readonly errorClass?: ErrorClass | null;
  /** A pending/running attempt was found: it may have been billed (R-012-4). */
  readonly unknownCharge?: boolean;
}

export interface RetryScopeWillRun {
  readonly stage: StageCode;
  readonly calls: CallCounts;
  readonly detail: string;
}

export interface RetryScopeWillNotRun {
  readonly stage: StageCode;
  readonly label: string;
  readonly detail: string;
}

export interface RetryScope {
  readonly stage: StageCode;
  readonly will_run: readonly RetryScopeWillRun[];
  readonly will_not_run: readonly RetryScopeWillNotRun[];
  readonly unknown_charge: boolean;
  readonly idempotency_protected: boolean;
  readonly blockers: readonly string[];
}

/** IM regenerates one image per scene; every other stage's cost is fixed. */
function callCountsFor(stage: StageCode, sceneCount: number): CallCounts {
  const base = STAGE_CALL_COSTS[stage];
  return stage === 'IM' ? { ...base, image: sceneCount } : base;
}

function describeCalls(calls: CallCounts): string {
  const parts: string[] = [];
  if (calls.image) parts.push(`${calls.image} image`);
  if (calls.tts) parts.push(`${calls.tts} TTS`);
  if (calls.text) parts.push(`${calls.text} text`);
  if (calls.render_passes) parts.push(`${calls.render_passes} render`);
  return parts.length ? parts.join(' · ') : 'local — no provider call';
}

/**
 * Compute the retry scope from persisted stage state.
 *
 * `will_run` = the failed stage + every downstream producing stage whose state
 * is `stale`, `not_run` or `failed`, each with its call cost (§7.3). Gates
 * (FA/EX) are operator approvals, not re-runnable work, and are never listed.
 * `will_not_run` = every stage that is `done` and not `stale`, listed with its
 * stored assets. A `done` stage is never re-run (R-022-2).
 */
export function computeRetryScope(input: RetryScopeInput): RetryScope {
  const failed = input.stage;

  const willRunStages: StageCode[] = [failed];
  for (const code of PRODUCING_STAGE_CODES) {
    if (STAGE_ORDER[code] <= STAGE_ORDER[failed]) continue;
    const s = input.stages[code]?.state;
    if (s === 'stale' || s === 'not_run' || s === 'failed') willRunStages.push(code);
  }

  const willRun = willRunStages.map((code) => ({
    stage: code,
    calls: callCountsFor(code, input.sceneCount),
    detail: describeCalls(callCountsFor(code, input.sceneCount)),
  }));

  const willNotRun = STAGE_CODES.filter((code) => {
    const s = input.stages[code];
    return s !== undefined && s.state === 'done' && !s.stale;
  }).map((code) => ({
    stage: code,
    label: STAGE_LABELS[code],
    detail: 'done — stored assets survive',
  }));

  const blockers: string[] = [];
  if (input.errorClass === 'non_retryable') {
    blockers.push('non-retryable error — retry will fail the same way; fix the provider first');
  }

  return {
    stage: failed,
    will_run: willRun,
    will_not_run: willNotRun,
    unknown_charge: input.unknownCharge ?? false,
    idempotency_protected: false, // all three providers are idempotency_protected=false (X-6)
    blockers,
  };
}
