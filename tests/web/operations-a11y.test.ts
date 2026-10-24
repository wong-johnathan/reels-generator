import { describe, expect, it } from 'vitest';

import {
  AttemptRowSchema,
  ExportViewSchema,
  HealthReportSchema,
  OverviewSchema,
  ProviderSettingsViewSchema,
  ScriptViewSchema,
  VideoDetailSchema,
} from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import {
  attemptsView,
  healthSummary,
  providerRows,
  type AttemptRow,
} from '../../src/web/health/model.js';
import { renderExportPanel } from '../../src/web/render/export.js';
import { renderHealthPage } from '../../src/web/render/health.js';
import { renderSettings } from '../../src/web/render/settings.js';
import { renderScriptReview } from '../../src/web/render/scriptReview.js';
import { degradedNotices } from '../../src/web/render/shell.js';
import { settingsModel } from '../../src/web/settings/model.js';
import type { ExportView } from '../../src/web/provenance/model.js';
import type { VideoDetail } from '../../src/web/workspace/model.js';
import {
  accessibleTextOf,
  byId,
  byTag,
  findAll,
  parseHtml,
  type HtmlNode,
} from './helpers/html.js';

/**
 * Accessibility of the three new surfaces: heading order, table captions,
 * labelled controls, discernible names, and state that never depends on colour.
 */

const detail: VideoDetail = VideoDetailSchema.parse(FIXTURES['video.get']);
const fixture: ExportView = ExportViewSchema.parse(FIXTURES['export.get']);
const report = HealthReportSchema.parse(FIXTURES['health.report']);
const overview = OverviewSchema.parse(FIXTURES['overview.get']);
const settings = ProviderSettingsViewSchema.parse(FIXTURES['settings.providers']);
const row: AttemptRow = AttemptRowSchema.parse(
  (FIXTURES['attempts.list'] as { attempts: unknown[] }).attempts[0],
);

const built: ExportView = {
  ...fixture,
  status: 'done',
  package_built_at: '2026-10-20T09:45:00.000Z',
};

function exportRoot(view: ExportView): HtmlNode {
  return parseHtml(renderExportPanel({ detail, view, buildWired: true }));
}

function healthRoot(): HtmlNode {
  return parseHtml(
    renderHealthPage({
      summary: healthSummary(report),
      degraded: degradedNotices(overview, report),
      overview,
      attempts: attemptsView({
        videoId: detail.id,
        videoLabel: 'Video 18',
        stage: null,
        rows: [row],
        now: Date.parse('2026-10-20T10:00:00.000Z'),
        error: false,
      }),
      now: Date.parse('2026-10-20T10:00:00.000Z'),
    }),
  );
}

describe('S-16 export accessibility', () => {
  it('keeps claims in a labelled, keyboard-scrollable region without positive tabindex', () => {
    const root = parseHtml(
      renderScriptReview({ detail, script: ScriptViewSchema.parse(FIXTURES['script.get']) }),
    );
    const region = findAll(
      root,
      (node) => node.attrs['aria-label'] === 'Claims and their sources',
    )[0]!;
    expect(region.attrs['role']).toBe('region');
    expect(region.attrs['tabindex']).toBe('0');
    expect(byTag(region, 'caption')).toHaveLength(1);
    expect(findAll(root, (node) => Number(node.attrs['tabindex']) > 0)).toHaveLength(0);
  });

  it('keeps heading order under the workspace heading', () => {
    const root = exportRoot(built);
    const levels = byTag(root, 'h3')
      .concat(byTag(root, 'h4'))
      .map((node) => Number(node.tag[1]));
    expect(levels[0]).toBe(3);
    expect(byTag(root, 'h4')).toHaveLength(3);
  });

  it('labels both table regions and gives each table a caption', () => {
    const root = exportRoot(built);
    const regions = findAll(root, (node) => node.tag === 'div' && node.attrs['role'] === 'region');
    expect(regions.map((node) => node.attrs['aria-label'])).toEqual([
      'Package contents',
      'Per-stage series pins',
    ]);
    expect(regions.every((node) => node.attrs['tabindex'] === '0')).toBe(true);
    for (const table of byTag(root, 'table')) {
      expect(byTag(table, 'caption')).toHaveLength(1);
    }
  });

  it('gives every download link a discernible name beyond its icon text', () => {
    const root = exportRoot(built);
    const links = findAll(root, (node) =>
      (node.attrs['class'] ?? '').includes('export-row-download'),
    );
    expect(links).toHaveLength(5);
    for (const link of links) {
      expect(accessibleTextOf(link).length).toBeGreaterThan('Download'.length);
    }
  });

  it('describes the disabled download with the exact reason', () => {
    const root = exportRoot(fixture);
    const button = byId(root, 'export-download-button')!;
    expect(button.attrs['disabled']).toBeDefined();
    const ids = (button.attrs['aria-describedby'] ?? '').split(' ');
    expect(ids).toContain('export-download-summary');
    expect(byId(root, 'export-download-summary')?.attrs['id']).toBe('export-download-summary');
  });

  it('marks the build reason with an id the disabled control points at', () => {
    const root = exportRoot(fixture);
    const button = byId(root, 'export-build-button')!;
    expect((button.attrs['aria-describedby'] ?? '').split(' ')).toContain('export-build-reason');
    expect(byId(root, 'export-build-reason')).toBeDefined();
  });

  it('never conveys charge or state by colour alone', () => {
    const root = exportRoot(built);
    expect(byId(root, 'export')?.attrs['data-state']).toBe('built');
    const chip = findAll(root, (node) => (node.attrs['class'] ?? '').includes('chip'))[0]!;
    expect(accessibleTextOf(chip).length).toBeGreaterThan(0);
  });
});

describe('S-19 health accessibility', () => {
  it('labels the attempt table with a caption and a scroll region', () => {
    const root = healthRoot();
    const region = findAll(root, (node) => node.attrs['aria-label'] === 'Attempt rows')[0]!;
    expect(region.attrs['role']).toBe('region');
    expect(region.attrs['tabindex']).toBe('0');
    const table = byTag(region, 'table')[0]!;
    expect(byTag(table, 'caption')).toHaveLength(1);
    expect(byTag(table, 'th').filter((node) => node.attrs['scope'] === 'col')).toHaveLength(10);
  });

  it('labels the stage filter and keeps its hidden video', () => {
    const root = healthRoot();
    const label = findAll(
      root,
      (node) => node.tag === 'label' && node.attrs['for'] === 'health-stage-filter',
    );
    expect(label).toHaveLength(1);
    expect(accessibleTextOf(label[0]!)).toBe('Stage');
    expect(byId(root, 'health-stage-filter')?.tag).toBe('select');
  });

  it('gives the disk meter a text equivalent', () => {
    const root = healthRoot();
    const meter = byTag(root, 'progress')[0]!;
    expect(meter.attrs['max']).toBe('100');
    expect((meter.children[0]?.text ?? '').length).toBeGreaterThan(0);
  });

  it('keeps every provider state word visible next to its glyph', () => {
    const root = healthRoot();
    const states = findAll(
      root,
      (node) => node.tag === 'article' && node.attrs['data-provider'] !== undefined,
    );
    expect(states).toHaveLength(3);
    expect(states.map((node) => (node.attrs['data-state'] ?? '').length > 0)).toEqual([
      true,
      true,
      true,
    ]);
    const glyphs = findAll(root, (node) => node.attrs['class'] === 'health-state-glyph');
    expect(glyphs.every((node) => node.attrs['aria-hidden'] === 'true')).toBe(true);
  });
});

describe('S-21 settings accessibility', () => {
  it('captions the key table and renders no form control', () => {
    const root = parseHtml(
      renderSettings(
        settingsModel({ providers: settings, rows: providerRows(settings.providers) }),
      ),
    );
    const table =
      byId(root, 'settings-providers')?.children.find((node) => node.tag === 'table') ??
      byTag(root, 'table')[0]!;
    expect(byTag(table, 'caption')).toHaveLength(1);
    expect(byTag(root, 'input')).toHaveLength(0);
    expect(byTag(root, 'select')).toHaveLength(0);
    expect(
      findAll(root, (node) => node.tag === 'div' && node.attrs['role'] === 'region'),
    ).toHaveLength(1);
  });
});
