/**
 * Scene grid, scene detail and storyboard derivations — UI_SPEC §5 UC-07/UC-08/
 * UC-09, §6.7 W-06; UX_SPEC W-06, A-15/A-16/A-17; PRD §10; R-007-1/2,
 * R-013-1/2, R-006-3, US-018/US-019.
 *
 * Every count, sentence and call figure is derived here from the frozen
 * contract (`StoryboardView`, `SceneView`, `AssetView`) and from the video
 * detail's stage rows. Nothing is invented: where UI_SPEC asks for a field the
 * contract does not carry (provider request id, rights metadata, per-scene
 * attempt history) the model returns an explicit `missing` row and the evidence
 * file names the gap.
 */
import type { z } from 'zod';

import type {
  AssetViewSchema,
  SceneViewSchema,
  StageViewSchema,
  StoryboardViewSchema,
} from '../../../contract/api.js';
import type { StageState } from '../../shared/stages.js';
import type { CameraMove } from '../../shared/states.js';
import { isoSeconds } from '../format.js';
import { sentenceState } from '../workspace/model.js';

export type SceneView = z.infer<typeof SceneViewSchema>;
export type StoryboardView = z.infer<typeof StoryboardViewSchema>;
export type ImageAsset = NonNullable<z.infer<typeof AssetViewSchema>>;
export type StageView = z.infer<typeof StageViewSchema>;

/** AX-15: the tile's `<img alt>` is the prompt summary, capped at 140 characters. */
export const MAX_SCENE_PROMPT = 140;

const ELLIPSIS = '…';

// ─────────────────────────────────────────────────────────────────────────────
// Per-scene facts
// ─────────────────────────────────────────────────────────────────────────────

export interface SceneSpan {
  readonly seconds: number;
  /** `4.4 s` — the meta row (UC-08). */
  readonly compact: string;
  /** `4.4 seconds` — the accessible full form (AX-15). */
  readonly spoken: string;
}

/** The narration span as one decimal place; null while the storyboard has none. */
export function sceneSpan(scene: Pick<SceneView, 'narration'>): SceneSpan | null {
  if (scene.narration === null) return null;
  const ms = Math.max(0, scene.narration.end_ms - scene.narration.start_ms);
  const seconds = Math.round(ms / 100) / 10;
  const fixed = seconds.toFixed(1);
  return { seconds, compact: fixed + ' s', spoken: fixed + ' seconds' };
}

/** 140-character prompt summary for `alt`; the cut is marked, never silent. */
export function promptSummary(prompt: string, max: number = MAX_SCENE_PROMPT): string {
  if (prompt.length <= max) return prompt;
  return prompt.slice(0, Math.max(0, max - 1)) + ELLIPSIS;
}

/** `v13` when the asset carries a series-version pin, else null. */
export function scenePin(scene: Pick<SceneView, 'asset'>): string | null {
  const version = scene.asset?.provenance.series_version ?? null;
  return version === null ? null : 'v' + version;
}

/** UC-08: `Scene 3 of 17, S03, done, 4.4 second narration, pin v13`. */
export function sceneAccessibleName(scene: SceneView, total: number): string {
  const parts = [
    'Scene ' + scene.position + ' of ' + total,
    scene.scene_no,
    sentenceState(scene.state).toLowerCase(),
  ];
  const span = sceneSpan(scene);
  if (span !== null) parts.push(span.seconds.toFixed(1) + ' second narration');
  const pin = scenePin(scene);
  if (pin !== null) parts.push('pin ' + pin);
  return parts.join(', ');
}

/** UC-07 keyboard announcement: `Scene 3 of 17, S03, done, 4.4 seconds, pin v13`. */
export function selectionAnnouncement(scene: SceneView, total: number): string {
  const parts = [
    'Scene ' + scene.position + ' of ' + total,
    scene.scene_no,
    sentenceState(scene.state).toLowerCase(),
  ];
  const span = sceneSpan(scene);
  if (span !== null) parts.push(span.spoken);
  const pin = scenePin(scene);
  if (pin !== null) parts.push('pin ' + pin);
  return parts.join(', ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Grid counts and the first-three checkpoint
// ─────────────────────────────────────────────────────────────────────────────

export interface GridCounts {
  readonly total: number;
  readonly generated: number;
  readonly generating: number;
  readonly failed: number;
  readonly stale: number;
  readonly notStarted: number;
  readonly remaining: number;
}

/**
 * Counts come from the scenes themselves. A target larger than the rows the
 * storyboard has produced is counted as not started, so the header and the
 * grid never disagree about how many scenes exist (W-06 "the count is never a
 * surprise").
 */
export function gridCounts(scenes: readonly SceneView[], total: number): GridCounts {
  const target = Math.max(total, scenes.length);
  const generated = scenes.filter((scene) => scene.asset !== null).length;
  const generating = scenes.filter(
    (scene) => scene.asset === null && scene.state === 'running',
  ).length;
  const failed = scenes.filter((scene) => scene.state === 'failed').length;
  const stale = scenes.filter((scene) => scene.state === 'stale').length;
  const notRun = scenes.filter((scene) => scene.asset === null && scene.state === 'not_run').length;
  const missing = Math.max(0, target - scenes.length);
  return {
    total: target,
    generated,
    generating,
    failed,
    stale,
    notStarted: notRun + missing,
    remaining: Math.max(0, target - generated),
  };
}

/** `3 of 17 generated · 14 not started` (UC-07 header). */
export function gridCountText(counts: GridCounts): string {
  return (
    counts.generated +
    ' of ' +
    counts.total +
    ' generated' +
    (counts.notStarted === 0 ? '' : ' · ' + counts.notStarted + ' not started')
  );
}

export type Checkpoint =
  | {
      readonly kind: 'open';
      readonly generated: number;
      readonly total: number;
      readonly remaining: number;
      readonly copy: string;
    }
  | { readonly kind: 'cleared'; readonly generated: number; readonly total: number }
  | { readonly kind: 'not_applicable'; readonly copy: string }
  | { readonly kind: 'blocked'; readonly reason: string; readonly copy: string };

export interface CheckpointInput {
  readonly storyboard: StoryboardView | null;
  /** The image stage's named precondition, when it is blocked. */
  readonly blockedReason: string | null;
  /** The video's target scene count, used before a storyboard exists. */
  readonly total?: number;
}

/**
 * PRD §10 / UX_SPEC W-06: the image stage generates scenes 1–3, then stops
 * until the operator has checked the protagonist. A series with no recurring
 * character reference states the exception and generates in one pass.
 */
export function checkpointState(input: CheckpointInput): Checkpoint {
  const { storyboard, blockedReason } = input;
  const total = Math.max(input.total ?? 0, storyboard?.scene_count ?? 0);
  if (storyboard === null || storyboard.scenes.length === 0) {
    const reason = blockedReason ?? 'the storyboard has not run';
    return {
      kind: 'blocked',
      reason,
      copy: '0 of ' + total + ' generated. Images are blocked until the script is approved.',
    };
  }
  const counts = gridCounts(storyboard.scenes, total);
  if (!storyboard.scenes.some((scene) => scene.uses_protagonist)) {
    return {
      kind: 'not_applicable',
      copy: 'Protagonist checkpoint not applicable — this series has no recurring character.',
    };
  }
  if (storyboard.first_three_reviewed || counts.remaining === 0) {
    return { kind: 'cleared', generated: counts.generated, total: counts.total };
  }
  return {
    kind: 'open',
    generated: counts.generated,
    total: counts.total,
    remaining: counts.remaining,
    copy:
      counts.generated +
      ' of ' +
      counts.total +
      ' generated. Check the protagonist before releasing the remaining ' +
      counts.remaining +
      ' (' +
      counts.remaining +
      ' image calls).',
  };
}

export function releaseLabel(remaining: number): string {
  return 'Release remaining ' + remaining;
}

export function releaseSubLabel(remaining: number): string {
  return remaining + ' image calls';
}

/** UI_SPEC §6.7: the reason the release control is disabled when unwired. */
export const RELEASE_UNWIRED_REASON =
  'Release is not wired to the backend yet: the API contract has no checkpoint-release route (gap F-06-1). The checkpoint still holds scenes 4 onwards.';

/** Fixed copy for the free reorder that ships in Milestone B. */
export const REORDER_NOTE =
  'Reorder ships in Milestone B; it costs 0 image calls and 0 TTS calls (R-006-3).';

// ─────────────────────────────────────────────────────────────────────────────
// Tiles
// ─────────────────────────────────────────────────────────────────────────────

export interface SceneTile {
  readonly scene: SceneView;
  readonly no: string;
  readonly position: number;
  readonly href: string;
  readonly alt: string;
  readonly accessibleName: string;
  readonly announce: string;
  readonly span: SceneSpan | null;
  readonly pin: string | null;
  readonly state: StageState;
  readonly imageUrl: string | null;
  /** True when the open first-three checkpoint holds this scene back. */
  readonly blockedByCheckpoint: boolean;
}

export function sceneHref(videoId: string, sceneId: string): string {
  return '/videos/' + encodeURIComponent(videoId) + '/scenes/' + encodeURIComponent(sceneId);
}

export function sceneTiles(input: {
  readonly videoId: string;
  readonly scenes: readonly SceneView[];
  readonly total: number;
  readonly checkpoint: Checkpoint;
}): SceneTile[] {
  const rows = [...input.scenes].sort((left, right) => left.position - right.position);
  return rows.map((scene) => ({
    scene,
    no: scene.scene_no,
    position: scene.position,
    href: sceneHref(input.videoId, scene.id),
    alt: promptSummary(scene.image_prompt),
    accessibleName: sceneAccessibleName(scene, input.total),
    announce: selectionAnnouncement(scene, input.total),
    span: sceneSpan(scene),
    pin: scenePin(scene),
    state: scene.state,
    imageUrl: scene.asset?.urls.thumb ?? null,
    blockedByCheckpoint:
      input.checkpoint.kind === 'open' && scene.position > 3 && scene.asset === null,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Replace (UC-09, C-02)
// ─────────────────────────────────────────────────────────────────────────────

/** UC-09's spend label; the count is always 1 (RULINGS L-2). */
export function replaceButtonLabel(): string {
  return 'Replace image · 1 image call';
}

/** C-02 verbatim: one call, the render goes stale, the other images survive. */
export function replaceConsequence(scene: Pick<SceneView, 'position'>, total: number): string {
  const n = scene.position;
  const survivors =
    total <= 1
      ? 'The narration survives.'
      : 'Images ' +
        [n > 1 ? '1–' + (n - 1) : null, n < total ? n + 1 + '–' + total : null]
          .filter((part): part is string => part !== null)
          .join(' and ') +
        ' and the narration survive.';
  return (
    'Replacing scene ' +
    n +
    "'s image costs 1 image call. Scene " +
    n +
    "'s visual and the render become stale. " +
    survivors
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Provenance (R-013-1/2)
// ─────────────────────────────────────────────────────────────────────────────

/** What the panel prints where the contract carries no value. */
export const PROVENANCE_NOT_RECORDED = 'not recorded by the scenes endpoint';

/** Named gaps, shown once under the provenance table. */
export const PROVENANCE_GAPS =
  'The provider request id and rights/licence metadata are ' +
  PROVENANCE_NOT_RECORDED +
  ' (contract gap F-06-2), and previous attempts are not exposed for a scene (gap F-06-3); the current asset and the image stage attempt count are shown instead.';

export interface ProvenanceRow {
  readonly label: string;
  readonly value: string;
  readonly missing: boolean;
}

function orMissing(value: string | null): { value: string; missing: boolean } {
  return value === null || value.length === 0
    ? { value: PROVENANCE_NOT_RECORDED, missing: true }
    : { value, missing: false };
}

export function provenanceRows(asset: ImageAsset): ProvenanceRow[] {
  const provenance = asset.provenance;
  const pin = provenance.series_version === null ? null : 'v' + provenance.series_version;
  return [
    { label: 'Provider', ...orMissing(provenance.provider) },
    { label: 'Model', ...orMissing(provenance.model) },
    { label: 'Prompt hash', ...orMissing(provenance.prompt_hash) },
    { label: 'Seed', ...orMissing(provenance.seed) },
    { label: 'Series pin', ...orMissing(pin) },
    { label: 'Created', value: isoSeconds(provenance.created_at), missing: false },
    { label: 'Provider request id', ...orMissing(null) },
    { label: 'Rights / licence', ...orMissing(null) },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Storyboard (S-11)
// ─────────────────────────────────────────────────────────────────────────────

export const CAMERA_MOVE_LABELS: Readonly<Record<CameraMove, string>> = {
  zoom_in: 'zoom in',
  zoom_out: 'zoom out',
  pan_l: 'pan left',
  pan_r: 'pan right',
  static: 'static',
};

export interface StoryboardRow {
  readonly no: string;
  readonly id: string;
  readonly href: string;
  readonly span: string | null;
  readonly prompt: string;
  readonly protagonist: 'yes' | 'no';
  readonly camera: string;
  readonly state: StageState;
}

export function storyboardRows(storyboard: StoryboardView, videoId?: string): StoryboardRow[] {
  const targetId = videoId ?? storyboard.project_id;
  return [...storyboard.scenes]
    .sort((left, right) => left.position - right.position)
    .map((scene) => ({
      no: scene.scene_no,
      id: scene.id,
      href: sceneHref(targetId, scene.id),
      span: sceneSpan(scene)?.compact ?? null,
      prompt: scene.image_prompt,
      protagonist: scene.uses_protagonist ? 'yes' : 'no',
      camera: CAMERA_MOVE_LABELS[scene.camera_move],
      state: scene.state,
    }));
}

export type StoryboardState = 'empty' | 'splitting' | 'failed' | 'ready';

export interface StoryboardStageInput {
  readonly state: StageState;
  readonly attempts: {
    readonly count: number;
    readonly max_attempts: number;
    readonly error_class?: string | null;
    readonly last_error_class?: string | null;
  };
  readonly blocked_reason: string | null;
}

/** UX_SPEC S-11 states row, in the order the panel distinguishes them. */
export function storyboardState(input: {
  readonly storyboard: StoryboardView | null;
  readonly stage: StoryboardStageInput;
}): StoryboardState {
  if (input.storyboard !== null && input.storyboard.scenes.length > 0) return 'ready';
  if (input.stage.state === 'running') return 'splitting';
  if (input.stage.state === 'failed') return 'failed';
  return 'empty';
}
