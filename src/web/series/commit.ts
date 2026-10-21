/**
 * IP-02 — the series version commit (UX_SPEC §4 IP-02, UI_SPEC §6.1 S-04,
 * UI_SPEC C-08, R-002-1/3, R-001-3, R-001-4).
 *
 * One function produces every string the panel shows, for the server render
 * and for a live edit in the browser. The consequence is always stated in
 * profile terms: a mint, never an invalidation, and never a regeneration.
 */
import { countPair } from '../format.js';
import type { ChangedField } from './fields.js';

export interface CommitInput {
  readonly mode: 'create' | 'edit';
  /** The current version; ignored when creating (the first save is v1). */
  readonly currentVersion: number;
  readonly changed: readonly ChangedField[];
  /** Sourced in-flight video count, when the adapter can supply one. */
  readonly inFlightVideos?: number | null;
  /** `SeriesDetail.in_flight_batches` — the count the contract exposes. */
  readonly inFlightBatches?: number | null;
  /** Whether the create form has enough content to submit. */
  readonly createReady?: boolean;
  readonly archived?: boolean;
  readonly saving?: boolean;
}

export interface CommitState {
  readonly nextVersion: number;
  /** `v4` — the strong element in the panel. */
  readonly version: string;
  /** `Saving mints v4.` / `This creates the series and mints v1.` */
  readonly lead: string;
  /** Everything after the lead: the consequence in profile terms. */
  readonly body: string;
  readonly saveLabel: string;
  readonly saveDisabled: boolean;
  /** Visible reason shown beside a disabled save; empty when the save is live. */
  readonly reason: string;
  readonly summary: readonly string[];
  readonly busy: boolean;
}

export const ARCHIVED_REASON = 'Archived series cannot be edited or used for new batches.';

export const NOTHING_TO_SAVE_REASON = 'Nothing to save.';
export const NO_CHANGES_REASON = 'No changes';

function consequence(input: CommitInput, next: number): { lead: string; body: string } {
  if (input.mode === 'create') {
    return {
      lead: 'This creates the series and mints v1.',
      body: 'No project exists yet, so nothing is invalidated.',
    };
  }

  const nextVersion = 'v' + next;
  const currentVersion = 'v' + input.currentVersion;
  const videos = input.inFlightVideos ?? 0;
  const batches = input.inFlightBatches ?? 0;

  let pins: string;
  let hasProjects = true;
  if (videos > 0) {
    pins =
      countPair(videos, 'video', 'videos') +
      (videos === 1 ? ' keeps its' : ' keep their') +
      ' current pins; stages that have not started will use ' +
      nextVersion +
      ' when they start.';
  } else if (batches > 0) {
    pins =
      countPair(batches, 'open batch', 'open batches') +
      (batches === 1 ? ' keeps its' : ' keep their') +
      ' current pins; stages that have not started will use ' +
      nextVersion +
      ' when they start.';
  } else {
    hasProjects = false;
    pins = 'No project exists yet, so nothing is invalidated.';
  }

  const immutable = currentVersion + ' stays immutable.';
  const untouched = hasProjects ? ' Existing projects and their assets are untouched.' : '';

  return {
    lead: 'Saving mints ' + nextVersion + '.',
    body: 'Nothing is regenerated. ' + pins + ' ' + immutable + untouched,
  };
}

export function commitState(input: CommitInput): CommitState {
  const nextVersion = input.mode === 'create' ? 1 : input.currentVersion + 1;
  const { lead, body } = consequence(input, nextVersion);
  const summary = input.changed.map(
    (change) => change.label + ': ' + change.from + ' → ' + change.to,
  );

  let reason = '';
  if (input.archived === true) {
    reason = ARCHIVED_REASON;
  } else if (input.saving !== true) {
    if (input.mode === 'create' && input.createReady !== true) {
      reason = NOTHING_TO_SAVE_REASON;
    } else if (input.mode === 'edit' && input.changed.length === 0) {
      reason = NO_CHANGES_REASON;
    }
  }

  const busy = input.saving === true;
  const saveDisabled = reason.length > 0 || busy;

  const saveLabel = busy
    ? input.mode === 'create'
      ? 'Creating…'
      : 'Minting v' + nextVersion + '…'
    : input.mode === 'create'
      ? 'Create series'
      : 'Save as v' + nextVersion;

  return {
    nextVersion,
    version: 'v' + nextVersion,
    lead,
    body,
    saveLabel,
    saveDisabled,
    reason,
    summary,
    busy,
  };
}

/** UI_SPEC §8.5: what a polite region says after the redirect lands. */
export function savedAnnouncement(input: {
  readonly version: number;
  readonly created?: boolean;
  readonly inFlightVideos?: number | null;
  readonly inFlightBatches?: number | null;
}): string {
  const saved = 'Saved as v' + input.version + '.';
  if (input.created === true) return saved;
  const hasProjects = (input.inFlightVideos ?? 0) > 0 || (input.inFlightBatches ?? 0) > 0;
  return hasProjects ? saved + ' Existing projects and their assets are untouched.' : saved;
}
