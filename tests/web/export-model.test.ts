import { describe, expect, it } from 'vitest';

import { ExportViewSchema, VideoDetailSchema } from '../../contract/api.js';
import { FIXTURES, IDS } from '../../contract/mock/fixtures.js';
import {
  NOT_ELIGIBLE_LINE,
  exportPanelModel,
  fileRows,
  packageExists,
  panelState,
  pinRows,
  pinSummary,
  type ExportView,
} from '../../src/web/provenance/model.js';
import { STAGE_CODES } from '../../src/shared/stages.js';
import type { VideoDetail } from '../../src/web/workspace/model.js';

/**
 * S-16 view model — US-026, R-014-1, R-002-4, UX A-24, RULINGS C-3.
 * Pure derivation: every assertion below runs against a contract fixture or a
 * deliberate override, never against invented data.
 */

const detail: VideoDetail = VideoDetailSchema.parse(FIXTURES['video.get']);
const fixture: ExportView = ExportViewSchema.parse(FIXTURES['export.get']);

function view(overrides: Partial<ExportView> = {}): ExportView {
  return { ...fixture, ...overrides };
}

function approved(base: VideoDetail): VideoDetail {
  return {
    ...base,
    stages: base.stages.map((stage) =>
      stage.stage === 'FA' ? { ...stage, state: 'done' } : stage,
    ),
  };
}

const built = view({ status: 'done', package_built_at: '2026-10-20T09:45:00.000Z' });

describe('package state derivation', () => {
  it('claims a package only when the stage is done, built and lists files', () => {
    expect(packageExists(built)).toBe(true);
    expect(packageExists({ ...built, package_built_at: null })).toBe(false);
    expect(packageExists({ ...built, files: [] })).toBe(false);
    expect(packageExists({ ...built, status: 'blocked' })).toBe(false);
  });

  it('reports not eligible while final approval is missing', () => {
    expect(panelState(fixture, detail)).toBe('not_eligible');
    expect(exportPanelModel({ detail, view: fixture, buildWired: true }).state).toBe(
      'not_eligible',
    );
  });

  it('keeps the blocked state when final approval exists but the export is blocked', () => {
    expect(panelState(fixture, approved(detail))).toBe('blocked');
  });

  it('covers building, failed, built, missing files, stale and not built', () => {
    expect(panelState(view({ status: 'running' }), detail)).toBe('building');
    expect(panelState(view({ status: 'failed' }), detail)).toBe('failed');
    expect(panelState(built, detail)).toBe('built');
    expect(panelState(view({ status: 'done' }), detail)).toBe('missing_files');
    expect(panelState(view({ status: 'stale' }), detail)).toBe('stale');
    expect(panelState(view({ status: 'not_run' }), approved(detail))).toBe('not_built');
  });

  it('treats an absent export view as not built when the video is approved', () => {
    const model = exportPanelModel({ detail: approved(detail), view: null, buildWired: true });
    expect(model.state).toBe('not_built');
    expect(model.files).toHaveLength(0);
    expect(model.pins).toHaveLength(STAGE_CODES.length);
  });
});

describe('package contents (R-014-1)', () => {
  it('lists all five files with size, SHA-256 and their own download URL', () => {
    const rows = fileRows(built);
    expect(rows.map((row) => row.kind)).toEqual(['video', 'srt', 'vtt', 'sidecar', 'manifest']);
    expect(rows.map((row) => row.kindLabel)).toEqual([
      'MP4',
      'Captions (.srt)',
      'Captions (.vtt)',
      'Metadata sidecar',
      'Source manifest',
    ]);
    expect(rows[0]?.name).toBe('founders-quietly-2026-10-20.mp4');
    expect(rows[0]?.size).toBe('46.0 MB');
    expect(rows[0]?.sha256).toHaveLength(64);
    expect(rows[0]?.href).toBe('/asset/' + IDS.videoAsset + '/full');
  });

  it('turns an empty URL into no link instead of a broken download', () => {
    const rows = fileRows({ ...built, files: [{ ...built.files[0]!, url: '' }] });
    expect(rows[0]?.href).toBeNull();
  });

  it('summarises the package as a file count and the server total', () => {
    const model = exportPanelModel({ detail, view: built, buildWired: true });
    expect(model.totalLine).toBe('5 files · 46.0 MB');
    expect(model.summaryLine).toBe(model.totalLine);
    expect(model.downloadable).toBe(true);
    expect(model.filesAreBuilt).toBe(true);
  });

  it('says five files will exist, not that they already do', () => {
    const model = exportPanelModel({ detail, view: fixture, buildWired: true });
    expect(model.totalLine).toBe('5 files when built');
    expect(model.downloadReason).toBe(NOT_ELIGIBLE_LINE);
  });

  it('lists the five expected kinds without filenames before the package exists', () => {
    const model = exportPanelModel({ detail, view: fixture, buildWired: true });
    expect(model.expectedKinds).toHaveLength(5);
    expect(model.files).toHaveLength(0);
    expect(model.downloadable).toBe(false);
    expect(model.downloadReason).toBe(NOT_ELIGIBLE_LINE);
    expect(model.summaryLine).toBe(NOT_ELIGIBLE_LINE);
  });
});

describe('per-stage pins (R-002-4, RULINGS C-3)', () => {
  it('covers all eleven stages, preferring the pin the package recorded', () => {
    const rows = pinRows(built, detail);
    expect(rows.map((row) => row.stage)).toEqual([...STAGE_CODES]);
    const topic = rows.find((row) => row.stage === 'T');
    expect(topic?.pin).toBe('v2');
    expect(topic?.source).toBe('export');
    const storyboard = rows.find((row) => row.stage === 'SB');
    expect(storyboard?.pin).toBe('v3');
    expect(storyboard?.source).toBe('video');
    expect(rows.find((row) => row.stage === 'EX')?.versionId).toBe(
      '11111111-1111-4111-8111-333333333333',
    );
  });

  it('summarises a mixed set oldest-first, with counts', () => {
    expect(pinSummary(pinRows(built, detail))).toBe('v2 ×3 · v3 ×8');
  });

  it('renders the bare version when every stage agrees', () => {
    const uniform = {
      ...built,
      pins: STAGE_CODES.map((stage) => ({
        stage,
        series_version: 3,
        series_version_id: '11111111-1111-4111-8111-333333333333',
      })),
    };
    expect(pinSummary(pinRows(uniform, detail))).toBe('v3');
  });

  it('says no pins yet when nothing has a version', () => {
    const empty = {
      ...detail,
      stages: detail.stages.map((stage) => ({
        ...stage,
        series_version: null,
        series_version_id: null,
      })),
    };
    expect(pinSummary(pinRows({ ...built, pins: [] }, empty))).toBe('no pins yet');
    expect(pinRows({ ...built, pins: [] }, empty)[0]?.pin).toBe('—');
  });

  it('states the full per-stage set as one line', () => {
    const model = exportPanelModel({ detail, view: built, buildWired: true });
    expect(model.pinLine).toBe(
      'Per stage: T v2 · RS v2 · SC v2 · SB v3 · IM v3 · NA v3 · TC v3 · RE v3 · QC v3 · FA v3 · EX v3.',
    );
  });
});

describe('build control and honest reasons', () => {
  it('offers a build only where it is mounted and the state allows it', () => {
    const unbuilt = exportPanelModel({
      detail: approved(detail),
      view: view({ status: 'not_run' }),
      buildWired: true,
    });
    expect(unbuilt.buildsEnabled).toBe(true);
    expect(unbuilt.buildLabel).toBe('Build package');

    const stale = exportPanelModel({
      detail,
      view: { ...built, status: 'stale' },
      buildWired: true,
    });
    expect(stale.buildsEnabled).toBe(true);
    expect(stale.buildLabel).toBe('Rebuild package');

    const failed = exportPanelModel({ detail, view: view({ status: 'failed' }), buildWired: true });
    expect(failed.buildLabel).toBe('Rebuild package');
    expect(failed.failureLine).toContain('no error detail');
  });

  it('states why nothing can be built when the seam is absent', () => {
    const model = exportPanelModel({
      detail: approved(detail),
      view: view({ status: 'not_run' }),
      buildWired: false,
    });
    expect(model.buildsEnabled).toBe(false);
    expect(model.buildBlockedReason).toContain('not mounted');
  });

  it('never enables a build while the export is not eligible', () => {
    const model = exportPanelModel({ detail, view: fixture, buildWired: true });
    expect(model.buildsEnabled).toBe(false);
    expect(model.buildBlockedReason).toBe(NOT_ELIGIBLE_LINE);
    expect(model.eligibilityLine).toContain('Final approval (FA)');
  });

  it('keeps a stale package downloadable and says what rebuilding does', () => {
    const model = exportPanelModel({
      detail,
      view: { ...built, status: 'stale' },
      buildWired: true,
    });
    expect(model.downloadable).toBe(true);
    expect(model.staleLine).toContain('complete and downloadable');
  });

  it('does not claim files when the stage reports done with none', () => {
    const model = exportPanelModel({ detail, view: view({ status: 'done' }), buildWired: true });
    expect(model.state).toBe('missing_files');
    expect(model.downloadable).toBe(false);
    expect(model.missingLine).toContain('R-014-1');
  });
});
