/**
 * S-16 — Export & provenance view model (US-026, R-014-1, R-002-4, R-013-1,
 * UX_SPEC A-24/A-25, J-8, D-6, UI_SPEC §6.5/§9.2/§9.3/§9.6).
 *
 * Everything here is a pure derivation of the frozen contract's
 * `ExportViewSchema` plus the video's own stage rows. Two honesty rules:
 *
 *  - contents are only claimed when they exist: a package is "built" only when
 *    the export stage says `done`, it carries a build time and at least one
 *    file. A blocked or unbuilt export lists the five kinds R-014-1 promises,
 *    without filenames or sizes it does not have.
 *  - pins come from the export when the export recorded them. R-002-4 is about
 *    the project's per-stage pins, so every one of the eleven stages is shown;
 *    a stage the export did not record falls back to the video's own stage row
 *    and is labelled as such rather than silently merged.
 *
 * This module is free of Node-only imports so the client could reuse it.
 */
import type { z } from 'zod';

import { STAGE_CODES, STAGE_LABELS, type StageCode, type StageState } from '../../shared/stages.js';
import type { ExportFileSchema, ExportViewSchema } from '../../../contract/api.js';
import { countPair, formatBytes, isoSeconds } from '../format.js';
import type { VideoDetail } from '../workspace/model.js';

export type ExportView = z.infer<typeof ExportViewSchema>;
export type ExportFile = z.infer<typeof ExportFileSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// R-014-1's five files
// ─────────────────────────────────────────────────────────────────────────────

export interface PackageKind {
  readonly kind: ExportFile['kind'];
  readonly label: string;
  readonly detail: string;
}

/** The package R-014-1 defines, in the order the operator reads it. */
export const PACKAGE_KINDS: readonly PackageKind[] = [
  { kind: 'video', label: 'MP4', detail: '1080×1920, 30 fps, H.264 + AAC' },
  { kind: 'srt', label: 'Captions (.srt)', detail: 'word timings as SRT cues' },
  { kind: 'vtt', label: 'Captions (.vtt)', detail: 'the same cues as WebVTT' },
  { kind: 'sidecar', label: 'Metadata sidecar', detail: 'title, description, hashtags' },
  { kind: 'manifest', label: 'Source manifest', detail: 'sources and the claim → source mapping' },
];

const KIND_LABEL: Readonly<Record<ExportFile['kind'], string>> = {
  video: 'MP4',
  srt: 'Captions (.srt)',
  vtt: 'Captions (.vtt)',
  sidecar: 'Metadata sidecar',
  manifest: 'Source manifest',
  poster: 'Poster',
};

const KIND_DETAIL: Readonly<Record<ExportFile['kind'], string>> = {
  video: '1080×1920, 30 fps, H.264 + AAC',
  srt: 'word timings as SRT cues',
  vtt: 'the same cues as WebVTT',
  sidecar: 'title, description, hashtags',
  manifest: 'sources and the claim → source mapping',
  poster: 'poster frame — not one of R-014-1’s five files',
};

export function kindLabel(kind: ExportFile['kind']): string {
  return KIND_LABEL[kind];
}

// ─────────────────────────────────────────────────────────────────────────────
// State derivation
// ─────────────────────────────────────────────────────────────────────────────

export type ExportPanelState =
  | 'not_eligible'
  | 'not_built'
  | 'building'
  | 'built'
  | 'stale'
  | 'failed'
  | 'missing_files'
  | 'blocked';

export interface ExportFileRow {
  readonly name: string;
  readonly kind: ExportFile['kind'];
  readonly kindLabel: string;
  readonly detail: string;
  readonly size: string;
  readonly sha256: string;
  readonly href: string | null;
}

export interface PinRow {
  readonly stage: StageCode;
  readonly label: string;
  /** `v13`, or `—` when the stage has no pin. */
  readonly pin: string;
  readonly version: number | null;
  readonly versionId: string | null;
  /** Where this row's pin came from: the package, or the video's stage row. */
  readonly source: 'export' | 'video';
  /** The stage's current state on the video (never invented). */
  readonly state: StageState | null;
}

export interface ExportPanelModel {
  readonly videoId: string;
  readonly state: ExportPanelState;
  /** The chip's state — a mapping of the panel state, never a ninth state. */
  readonly chip: StageState;
  readonly heading: string;
  readonly summaryLine: string;
  readonly detailLine: string | null;
  readonly builtLine: string | null;
  readonly eligibilityLine: string | null;
  readonly staleLine: string | null;
  readonly failureLine: string | null;
  readonly missingLine: string | null;
  readonly blockedLine: string | null;
  /** The real files when the package exists; empty otherwise. */
  readonly files: readonly ExportFileRow[];
  readonly filesAreBuilt: boolean;
  readonly expectedKinds: readonly PackageKind[];
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly totalLine: string;
  /** True when the package can be downloaded today. */
  readonly downloadable: boolean;
  /** True when the gateway exposes `export.build`. */
  readonly canBuild: boolean;
  readonly buildLabel: string;
  readonly buildsEnabled: boolean;
  readonly buildBlockedReason: string | null;
  readonly downloadReason: string | null;
  readonly pins: readonly PinRow[];
  readonly pinSummary: string;
  readonly pinLine: string;
  readonly manifest: ExportView['manifest'];
  readonly renderHref: string;
  readonly monitoringNote: string;
}

/** A package exists when the export stage says done, carries a time and ≥1 file. */
export function packageExists(view: ExportView): boolean {
  return view.status === 'done' && view.package_built_at !== null && view.files.length > 0;
}

function finalApproved(detail: VideoDetail): boolean {
  return detail.stages.find((stage) => stage.stage === 'FA')?.state === 'done';
}

export function panelState(view: ExportView, detail: VideoDetail): ExportPanelState {
  if (view.status === 'running') return 'building';
  if (view.status === 'failed') return 'failed';
  if (view.status === 'done') return packageExists(view) ? 'built' : 'missing_files';
  if (view.status === 'stale') return 'stale';
  if (view.status === 'blocked') return finalApproved(detail) ? 'blocked' : 'not_eligible';
  if (!finalApproved(detail)) return 'not_eligible';
  return 'not_built';
}

const CHIP_FOR_STATE: Readonly<Record<ExportPanelState, StageState>> = {
  not_eligible: 'blocked',
  not_built: 'not_run',
  building: 'running',
  built: 'done',
  stale: 'stale',
  failed: 'failed',
  missing_files: 'failed',
  blocked: 'blocked',
};

const HEADINGS: Readonly<Record<ExportPanelState, string>> = {
  not_eligible: 'Export and provenance',
  not_built: 'Export and provenance',
  building: 'Building the package',
  built: 'Package ready',
  stale: 'Package ready — stale',
  failed: 'Package build failed',
  missing_files: 'Package contents missing',
  blocked: 'Export blocked',
};

export const NOT_ELIGIBLE_LINE = 'Not eligible for export. Final approval is required first.';

export function fileRows(view: ExportView): ExportFileRow[] {
  return view.files.map((file) => ({
    name: file.name,
    kind: file.kind,
    kindLabel: KIND_LABEL[file.kind],
    detail: KIND_DETAIL[file.kind],
    size: formatBytes(file.size_bytes),
    sha256: file.sha256,
    href: file.url.length > 0 ? file.url : null,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Pins (R-002-4, RULINGS C-3)
// ─────────────────────────────────────────────────────────────────────────────

/** A shape with only the fields the pin reader touches. */
export function emptyView(): ExportView {
  return {
    status: 'not_run',
    package_built_at: null,
    files: [],
    total_bytes: 0,
    pins: [],
    manifest: null,
  };
}

/**
 * Every stage, with the pin the export recorded when it recorded one, and the
 * video's own pin otherwise. Pins render `v` + integer (UI_SPEC §9.6).
 */
export function pinRows(view: ExportView, detail: VideoDetail): PinRow[] {
  return STAGE_CODES.map((stage) => {
    const exported = view.pins.find((row) => row.stage === stage);
    const videoStage = detail.stages.find((row) => row.stage === stage);
    const version =
      exported === undefined ? (videoStage?.series_version ?? null) : exported.series_version;
    const versionId =
      exported === undefined ? (videoStage?.series_version_id ?? null) : exported.series_version_id;
    return {
      stage,
      label: STAGE_LABELS[stage],
      pin: version === null ? '—' : 'v' + version,
      version,
      versionId,
      source: exported === undefined ? 'video' : 'export',
      state: videoStage?.state ?? null,
    };
  });
}

/**
 * RULINGS C-3: bare `v13` when every pinned stage agrees, `v13 ×5 · v14 ×3`
 * (count per version, oldest first) when they do not.
 */
export function pinSummary(rows: readonly PinRow[]): string {
  const counts = new Map<number, number>();
  for (const row of rows) {
    if (row.version === null) continue;
    counts.set(row.version, (counts.get(row.version) ?? 0) + 1);
  }
  if (counts.size === 0) return 'no pins yet';
  const versions = [...counts.keys()].sort((left, right) => left - right);
  if (versions.length === 1) return 'v' + versions[0];
  return versions.map((version) => 'v' + version + ' ×' + counts.get(version)).join(' · ');
}

function pinLine(rows: readonly PinRow[]): string {
  return 'Per stage: ' + rows.map((row) => row.stage + ' ' + row.pin).join(' · ') + '.';
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel model
// ─────────────────────────────────────────────────────────────────────────────

export interface ExportPanelInput {
  readonly detail: VideoDetail;
  readonly view: ExportView | null;
  /** Whether the gateway exposes `export.build`. */
  readonly buildWired: boolean;
}

export function exportPanelModel(input: ExportPanelInput): ExportPanelModel {
  const { detail, view } = input;
  const state: ExportPanelState =
    view === null
      ? finalApproved(detail)
        ? 'not_built'
        : 'not_eligible'
      : panelState(view, detail);
  const built = state === 'built' || state === 'stale';
  const files = built && view !== null ? fileRows(view) : [];
  const pins = pinRows(view ?? emptyView(), detail);
  const fileCount = files.length;
  const totalBytes = view?.total_bytes ?? 0;
  const totalLine =
    fileCount > 0
      ? countPair(fileCount, 'file', 'files') + ' · ' + formatBytes(totalBytes)
      : countPair(PACKAGE_KINDS.length, 'file', 'files') + ' when built';

  const downloadReason =
    state === 'not_eligible'
      ? NOT_ELIGIBLE_LINE
      : state === 'building'
        ? 'The package is being built. Nothing can be downloaded until it finishes.'
        : state === 'missing_files'
          ? 'The export stage reports the package as built, but it lists no files, so there is nothing to download.'
          : state === 'failed'
            ? 'The package build failed, so there is nothing to download from it.'
            : state === 'blocked'
              ? 'Export is blocked. The export view names no reason, so the blocking stage is not named here.'
              : state === 'not_built'
                ? 'The package has not been built yet. Build it before downloading.'
                : null;

  const buildBlockedReason = input.buildWired
    ? state === 'building'
      ? 'The package is already building.'
      : state === 'not_eligible'
        ? NOT_ELIGIBLE_LINE
        : state === 'blocked'
          ? 'Export is blocked; a build would refuse for the same reason.'
          : null
    : 'The package build is not mounted in this deployment, so this page cannot build it.';

  return {
    videoId: detail.id,
    state,
    chip: CHIP_FOR_STATE[state],
    heading: HEADINGS[state],
    summaryLine: built
      ? totalLine
      : state === 'not_eligible'
        ? NOT_ELIGIBLE_LINE
        : state === 'building'
          ? 'Building the package. Nothing can be downloaded until it finishes.'
          : state === 'failed'
            ? 'The package build failed. Retry it before downloading.'
            : state === 'missing_files'
              ? 'The export stage reports a built package with no files.'
              : 'The package has not been built yet.',
    detailLine: built
      ? 'Every file carries its size and SHA-256, so a download can be checked.'
      : null,
    builtLine:
      built && view?.package_built_at != null
        ? 'Package built ' + isoSeconds(view.package_built_at) + '.'
        : null,
    eligibilityLine:
      state === 'not_eligible'
        ? 'Final approval (FA) is the only path to export (R-005-3). Approve the render, then return here.'
        : null,
    staleLine:
      state === 'stale'
        ? 'This package was built before a later change. It is complete and downloadable; rebuilding it replaces it.'
        : null,
    failureLine:
      state === 'failed'
        ? 'Nothing was downloaded. The export view carries no error detail.'
        : null,
    missingLine:
      state === 'missing_files'
        ? 'The five files R-014-1 requires are not listed, so this page will not claim they exist.'
        : null,
    blockedLine: state === 'blocked' ? 'The export stage is blocked.' : null,
    files,
    filesAreBuilt: built,
    expectedKinds: PACKAGE_KINDS,
    fileCount,
    totalBytes,
    totalLine,
    downloadable: built && fileCount > 0,
    buildLabel: state === 'failed' || state === 'stale' ? 'Rebuild package' : 'Build package',
    buildsEnabled:
      input.buildWired && (state === 'not_built' || state === 'failed' || state === 'stale'),
    canBuild: input.buildWired,
    buildBlockedReason,
    downloadReason,
    pins,
    pinSummary: pinSummary(pins),
    pinLine: pinLine(pins),
    manifest: view?.manifest ?? null,
    renderHref: '/videos/' + encodeURIComponent(detail.id) + '/render',
    monitoringNote:
      'Downloads work at every width. Building or rebuilding a package needs a screen 768 px or wider.',
  };
}
