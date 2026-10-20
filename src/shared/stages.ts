/**
 * Canonical stage vocabulary — TECH_DESIGN §4.1 / X-5, UX_SPEC §0.2.
 *
 * This module is the single source of truth for the 11 stage codes and the 8
 * stage states. Backend handlers, the web layer and `contract/` all import from
 * here; changing a code or a state is a plan change, not a local decision.
 */

/** 11 stage codes, in pipeline order. FA and EX are gates, not producing stages. */
export const STAGE_CODES = [
  'T',
  'RS',
  'SC',
  'SB',
  'IM',
  'NA',
  'TC',
  'RE',
  'QC',
  'FA',
  'EX',
] as const;
export type StageCode = (typeof STAGE_CODES)[number];

/** Stages that produce work; `FA`/`EX` are operator gates (TECH_DESIGN §4.1). */
export const PRODUCING_STAGE_CODES = [
  'T',
  'RS',
  'SC',
  'SB',
  'IM',
  'NA',
  'TC',
  'RE',
  'QC',
] as const satisfies readonly StageCode[];

/** Gate stages — an operator `review_decision` moves them (R-005-2/3). */
export const GATE_STAGE_CODES = ['FA', 'EX'] as const satisfies readonly StageCode[];

/** Human labels used by the stage rail (UX_SPEC §0.2). */
export const STAGE_LABELS: Readonly<Record<StageCode, string>> = {
  T: 'Topic',
  RS: 'Research',
  SC: 'Script',
  SB: 'Storyboard',
  IM: 'Images',
  NA: 'Narration',
  TC: 'Timing & captions',
  RE: 'Render',
  QC: 'QC',
  FA: 'Final approval',
  EX: 'Export',
};

/** Pipeline order, used to sort the stage rail and to topologically enqueue regeneration. */
export const STAGE_ORDER: Readonly<Record<StageCode, number>> = {
  T: 0,
  RS: 1,
  SC: 2,
  SB: 3,
  IM: 4,
  NA: 5,
  TC: 6,
  RE: 7,
  QC: 8,
  FA: 9,
  EX: 10,
};

/** 8 stage states — UX §6 / UI §3.1 / TECH_DESIGN §4.1. */
export const STAGE_STATES = [
  'not_run',
  'running',
  'done',
  'awaiting_approval',
  'stale',
  'failed',
  'blocked',
  'cancelled',
] as const;
export type StageState = (typeof STAGE_STATES)[number];

/** States a stage can never leave (`done` is re-openable only through the explicit stale path). */
export const TERMINAL_STAGE_STATES = ['cancelled'] as const satisfies readonly StageState[];

/** States that make a stage the project's `current_stage` (TECH_DESIGN §4.5). */
export const ACTIVE_STAGE_STATES = [
  'running',
  'awaiting_approval',
  'failed',
  'blocked',
] as const satisfies readonly StageState[];

export function isStageCode(value: string): value is StageCode {
  return (STAGE_CODES as readonly string[]).includes(value);
}

export function isStageState(value: string): value is StageState {
  return (STAGE_STATES as readonly string[]).includes(value);
}

/** The next code in pipeline order, or `null` after `EX`. */
export function nextStage(stage: StageCode): StageCode | null {
  const next = STAGE_CODES[STAGE_ORDER[stage] + 1];
  return next ?? null;
}
