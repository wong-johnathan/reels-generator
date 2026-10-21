/**
 * Invalidation-as-data + staleness propagation — TECH_DESIGN §4.3/§4.4, R-006.
 *
 * The invalidation matrix is *data*: `INVALIDATION_RULE_SEED` carries the eight
 * `edit_kind` rows verbatim from §4.3, versioned for the migration that loads
 * them into the `invalidation_rule` table (M-005). Changing the matrix is a
 * data change, not a code change.
 *
 * This module computes the IP-01 preview (the exact stale set + call counts,
 * with the aspect-ratio reframe conditional resolved) and propagates staleness
 * onto persisted stage states — through the state machine, so a stage can only
 * become `stale` via the legal `done → stale` / `awaiting_approval → stale`
 * transitions. Staleness is never auto-cleared (IP-01/UC-05).
 */
import type { EditKind, StageCode, StageState } from '../shared/index.js';
import { transitionStage } from './state-machine.js';

/** Provider-call counts shown in IP-01 and the "what a regeneration would run" panel. */
export interface CallCounts {
  readonly image: number;
  readonly tts: number;
  readonly text: number;
  readonly render_passes: number;
}

/** Resolution of the only conditional matrix row (`aspect_ratio`). */
export type ReframeStatus = 'pending' | 'reframable' | 'not_reframable';

export interface ReframeConditional {
  readonly check: 'reframe';
  readonly status: ReframeStatus;
  readonly image_calls_if_not_reframable: number;
}

/** One `invalidation_rule` row (TECH_DESIGN §3.2 / §4.3). */
export interface InvalidationRule {
  readonly edit_kind: EditKind;
  readonly invalidated_stages: readonly StageCode[];
  readonly survives: readonly StageCode[];
  readonly image_calls: number;
  readonly tts_calls: number;
  readonly render_passes: number;
  readonly text_action: string | null;
  readonly conditional_check: 'reframe' | null;
  readonly description: string;
}

/** Bumped whenever a matrix row changes; the migration loads exactly this version. */
export const INVALIDATION_RULE_SEED_VERSION = 1;

/**
 * The invalidation matrix as data — TECH_DESIGN §4.3, R-006-2/3.
 *
 * `invalidated_stages` is listed in pipeline order (topological enqueue order).
 * `survives` lists the producing stages left untouched at the stage level; the
 * image_replace "other IM scenes survive" nuance is carried in the preview's
 * asset counts, not here (only the named scene is invalidated).
 */
export const INVALIDATION_RULE_SEED: readonly InvalidationRule[] = [
  {
    edit_kind: 'script_wording',
    invalidated_stages: ['SB', 'NA', 'TC', 'RE'],
    survives: ['IM'],
    image_calls: 0,
    tts_calls: 1,
    render_passes: 1,
    text_action: 're-derive 17 scene prompts',
    conditional_check: null,
    description:
      'Script wording edit invalidates storyboard, narration, timing and render; images survive.',
  },
  {
    edit_kind: 'duration',
    invalidated_stages: ['SC', 'SB', 'NA', 'TC', 'RE'],
    survives: ['IM'],
    image_calls: 0,
    tts_calls: 1,
    render_passes: 1,
    text_action: 're-derive script + storyboard',
    conditional_check: null,
    description:
      'Duration edit invalidates script, storyboard, narration, timing and render; images survive.',
  },
  {
    edit_kind: 'aspect_ratio',
    invalidated_stages: ['RE'],
    survives: ['IM'],
    image_calls: 0,
    tts_calls: 0,
    render_passes: 1,
    text_action: null,
    conditional_check: 'reframe',
    description:
      'Aspect-ratio edit invalidates composition and render; images are regenerated only if the local reframe check fails.',
  },
  {
    edit_kind: 'image_replace',
    invalidated_stages: ['IM', 'RE'],
    survives: ['NA'],
    image_calls: 1,
    tts_calls: 0,
    render_passes: 1,
    text_action: null,
    conditional_check: null,
    description:
      'Replacing one scene image invalidates that scene and the render; the other images and narration survive.',
  },
  {
    edit_kind: 'captions_music',
    invalidated_stages: ['RE'],
    survives: ['IM', 'NA'],
    image_calls: 0,
    tts_calls: 0,
    render_passes: 1,
    text_action: null,
    conditional_check: null,
    description:
      'Captions or music edit invalidates the render only; images and narration survive.',
  },
  {
    edit_kind: 'voice_speed',
    invalidated_stages: ['NA', 'TC', 'RE'],
    survives: ['IM'],
    image_calls: 0,
    tts_calls: 1,
    render_passes: 1,
    text_action: null,
    conditional_check: null,
    description: 'Voice/speed change invalidates narration, timing and render; images survive.',
  },
  {
    edit_kind: 'topic_after_research',
    invalidated_stages: ['RS', 'SC', 'SB', 'IM', 'NA', 'TC', 'RE'],
    survives: [],
    image_calls: 0,
    tts_calls: 1,
    render_passes: 1,
    text_action: 're-derive script + storyboard',
    conditional_check: null,
    description:
      'A topic edit after research invalidates script and everything downstream (images and narration included); ' +
      'the immediate regeneration re-derives script + storyboard + narration and defers image calls behind re-approval.',
  },
  {
    edit_kind: 'reorder',
    invalidated_stages: ['TC', 'RE'],
    survives: ['IM', 'NA'],
    image_calls: 0,
    tts_calls: 0,
    render_passes: 1,
    text_action: 'captions remap to new order',
    conditional_check: null,
    description:
      'Reordering scenes invalidates timing/captions and render only; images and narration survive.',
  },
];

/** Look up the single rule for an edit kind. */
export function ruleFor(editKind: EditKind): InvalidationRule {
  const rule = INVALIDATION_RULE_SEED.find((r) => r.edit_kind === editKind);
  if (!rule) throw new Error(`no invalidation_rule for edit_kind ${editKind}`);
  return rule;
}

/**
 * The text-provider stages re-derived by a project edit. Per §4.7 only SC
 * (script) and SB (storyboard) are re-derived; T (topic) and RS (research) are
 * never re-run by a project edit — re-research is a separate operator action.
 */
const TEXT_RE_DERIVE_STAGE_CODES: readonly StageCode[] = ['SC', 'SB'];

/** Inputs needed to compute the preview (no provider call — §4.4 step 6). */
export interface InvalidationContext {
  /** Scene count drives the IM call count and the reframe "17 calls if not reframable". */
  readonly sceneCount: number;
  /** Only meaningful for `aspect_ratio`; defaults to `pending` until the local check resolves. */
  readonly reframeOutcome?: ReframeStatus;
}

export interface InvalidationResult {
  readonly edit_kind: EditKind;
  /** The exact stale set (pipeline order). */
  readonly invalidated: readonly StageCode[];
  /** Producing stages left untouched. */
  readonly survives: readonly StageCode[];
  readonly calls: CallCounts;
  readonly text_action: string | null;
  readonly conditional: ReframeConditional | null;
}

/**
 * Compute the IP-01 preview for one edit: the exact stale set and the call
 * counts a regeneration would run, resolving the aspect-ratio reframe
 * conditional. Pure — never calls a provider.
 */
export function computeInvalidation(
  rule: InvalidationRule,
  context: InvalidationContext,
): InvalidationResult {
  let invalidated: StageCode[] = [...rule.invalidated_stages];
  let survives: StageCode[] = [...rule.survives];
  let imageCalls = rule.image_calls;
  let conditional: ReframeConditional | null = null;

  if (rule.conditional_check === 'reframe') {
    const status = context.reframeOutcome ?? 'pending';
    conditional = {
      check: 'reframe',
      status,
      image_calls_if_not_reframable: context.sceneCount,
    };
    if (status === 'not_reframable') {
      // §4.3: aspect-ratio requires new images only if the originals cannot be reframed.
      invalidated = ['IM', ...invalidated];
      survives = survives.filter((s) => s !== 'IM');
      imageCalls = context.sceneCount;
    }
  }

  const text = invalidated.filter((s) => TEXT_RE_DERIVE_STAGE_CODES.includes(s)).length;

  return {
    edit_kind: rule.edit_kind,
    invalidated,
    survives,
    calls: {
      image: imageCalls,
      tts: rule.tts_calls,
      text,
      render_passes: rule.render_passes,
    },
    text_action: rule.text_action,
    conditional,
  };
}

/** A single persisted stage's state (subset of `video_stage`). */
export interface StageSnapshot {
  readonly state: StageState;
  readonly stale_cause?: string | null;
}

export type StageMap = Readonly<Record<StageCode, StageSnapshot>>;

export interface StaleApplication {
  /** The resulting stage map, with invalidated `done`/`awaiting_approval` stages set to `stale`. */
  readonly stages: StageMap;
  /** Stages that actually transitioned to `stale` (pipeline order). */
  readonly marked_stale: readonly StageCode[];
}

/**
 * Propagate staleness onto persisted stage states (§4.4 step 4).
 *
 * Each stage in `invalidated` that is currently `done` or `awaiting_approval`
 * transitions to `stale` through the state machine. `not_run`, `running`,
 * `blocked`, `failed` and `cancelled` stages are left untouched (there is no
 * legal transition from them to `stale`), and an already-`stale` stage is never
 * auto-cleared (IP-01/UC-05).
 */
export function propagateStale(
  stages: StageMap,
  invalidated: readonly StageCode[],
  staleCause: string,
): StaleApplication {
  const next: Record<StageCode, StageSnapshot> = { ...stages };
  const marked: StageCode[] = [];

  for (const code of invalidated) {
    const snapshot = stages[code];
    if (!snapshot) continue;
    if (snapshot.state === 'done' || snapshot.state === 'awaiting_approval') {
      const to = transitionStage(snapshot.state, 'invalidate');
      next[code] = { state: to, stale_cause: staleCause };
      marked.push(code);
    }
  }

  return { stages: next, marked_stale: marked };
}
