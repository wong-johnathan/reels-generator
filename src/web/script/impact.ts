/**
 * UC-06 change-impact panel (IP-01) — formatting only.
 *
 * The server computes the invalidation and the call counts
 * (`InvalidationPreviewSchema`, TECH_DESIGN invalidation-as-data, R-006-1/2).
 * This module turns that response into the exact copy UC-06 asks for and
 * decides which of the two commits may be enabled. It never derives an
 * invalidation, never counts a call and never prices anything (D2).
 */
import type { z } from 'zod';

import type { InvalidationPreviewSchema } from '../../../contract/api.js';
import type { EditKind } from '../../shared/states.js';
import { STAGE_LABELS } from '../../shared/stages.js';

export type InvalidationPreview = z.infer<typeof InvalidationPreviewSchema>;

export const NO_CHANGES = 'No unsaved changes';
export const COMPUTING = 'computing impact';
export const NO_ASSETS = 'No assets exist yet — this edit costs nothing to apply.';
/** C-07, verbatim. */
export const C07_FAILED =
  'The impact of this change could not be computed, so regeneration is blocked. Editing and regeneration are both disabled until it can be computed — this prevents a change whose cost you could not see.';

export const APPLY_LABEL = 'Apply edit (no regeneration)';
export const REGENERATE_LABEL = 'Apply and regenerate now';

export type ImpactKind = 'idle' | 'computing' | 'ready' | 'failed';

export interface ImpactStaleRow {
  readonly code: string;
  readonly label: string;
  readonly quantity: number;
  readonly note: string;
}

export interface ImpactSurvivesRow {
  readonly label: string;
  readonly detail: string;
}

export interface ImpactView {
  readonly kind: ImpactKind;
  /** Header chip: `4 stale` / `computing` / `no assets`. */
  readonly chip: string;
  /** `Script rev 4 → rev 5 · wording only`, or null when there is nothing to describe. */
  readonly changes: string | null;
  readonly stale: readonly ImpactStaleRow[];
  readonly survives: readonly ImpactSurvivesRow[];
  /** Two mono lines; the four call types are never summed or priced. */
  readonly calls: readonly string[];
  readonly conditional: string | null;
  readonly blockers: readonly string[];
  /** A single visible sentence for the panel's empty / computing / failed states. */
  readonly message: string | null;
  readonly applyLabel: string;
  readonly regenerateLabel: string;
  readonly canApply: boolean;
  readonly canRegenerate: boolean;
  readonly regenerateHidden: boolean;
  readonly staleCount: number;
}

const EDIT_DESCRIPTIONS: Readonly<Record<EditKind, string>> = {
  script_wording: 'wording only',
  duration: 'duration',
  aspect_ratio: 'aspect ratio',
  image_replace: 'one image replaced',
  captions_music: 'captions or music',
  voice_speed: 'voice or speed',
  topic_after_research: 'topic after research',
  reorder: 'scene order',
};

function changesSentence(preview: InvalidationPreview): string {
  const fields = preview.edits.map((edit) => EDIT_DESCRIPTIONS[edit]).join(' + ');
  return 'Script rev ' + preview.revision + ' → rev ' + (preview.revision + 1) + ' · ' + fields;
}

function conditionalLine(preview: InvalidationPreview): string | null {
  const conditional = preview.conditional;
  if (conditional === null) return null;
  switch (conditional.status) {
    case 'pending':
      return (
        'Images: pending reframe check — ' +
        conditional.image_calls_if_not_reframable +
        ' calls only if the current images cannot be reframed.'
      );
    case 'reframable':
      return 'Images: reframable — 0 image calls; the stored images are reframed locally.';
    case 'not_reframable':
      return (
        'Images: not reframable — ' +
        conditional.image_calls_if_not_reframable +
        ' image calls; the reframe check completed.'
      );
  }
}

function hasNothingToInvalidate(preview: InvalidationPreview): boolean {
  const calls = preview.calls;
  return (
    preview.invalidated.length === 0 &&
    preview.survives.length === 0 &&
    calls.image === 0 &&
    calls.tts === 0 &&
    calls.text === 0 &&
    calls.render_passes === 0
  );
}

export function idleImpact(): ImpactView {
  return {
    kind: 'idle',
    chip: 'no changes',
    changes: null,
    stale: [],
    survives: [],
    calls: [],
    conditional: null,
    blockers: [],
    message: NO_CHANGES,
    applyLabel: APPLY_LABEL,
    regenerateLabel: REGENERATE_LABEL,
    canApply: false,
    canRegenerate: false,
    regenerateHidden: true,
    staleCount: 0,
  };
}

export function computingImpact(): ImpactView {
  return {
    ...idleImpact(),
    kind: 'computing',
    chip: 'computing',
    message: COMPUTING,
  };
}

export function failedImpact(): ImpactView {
  return {
    ...idleImpact(),
    kind: 'failed',
    chip: 'failed',
    message: C07_FAILED,
  };
}

export function readyImpact(preview: InvalidationPreview): ImpactView {
  const blockers = [...preview.blockers];
  const nothing = hasNothingToInvalidate(preview);
  const conditional = conditionalLine(preview);
  const pending = preview.conditional !== null && preview.conditional.status === 'pending';
  const calls = [
    'image calls: ' + preview.calls.image + ' · TTS calls: ' + preview.calls.tts,
    'render passes: ' + preview.calls.render_passes + ' · text calls: ' + preview.calls.text,
  ];
  const computable = preview.ok && !nothing ? blockers.length === 0 : blockers.length === 0;
  const canApply = computable;
  const canRegenerate = computable && !nothing && !pending;

  return {
    kind: 'ready',
    chip: nothing
      ? 'no assets'
      : preview.invalidated.length === 0
        ? 'no stale stages'
        : preview.invalidated.length + ' stale',
    changes: preview.edits.length === 0 ? null : changesSentence(preview),
    stale: preview.invalidated.map((row) => ({
      code: row.stage,
      label: STAGE_LABELS[row.stage],
      quantity: row.quantity,
      note: row.note,
    })),
    survives: preview.survives.map((row) => ({ label: row.label, detail: row.detail })),
    calls,
    conditional,
    blockers,
    message: nothing ? NO_ASSETS : null,
    applyLabel: APPLY_LABEL,
    regenerateLabel: REGENERATE_LABEL,
    canApply,
    canRegenerate,
    regenerateHidden: nothing,
    staleCount: preview.invalidated.length,
  };
}
