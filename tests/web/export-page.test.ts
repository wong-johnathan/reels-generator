import { describe, expect, it } from 'vitest';

import { ExportViewSchema, VideoDetailSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { NOT_ELIGIBLE_LINE, type ExportView } from '../../src/web/provenance/model.js';
import { renderExportPanel } from '../../src/web/render/export.js';
import type { VideoDetail } from '../../src/web/workspace/model.js';
import {
  accessibleTextOf,
  byId,
  byTag,
  findAll,
  parseHtml,
  textOf,
  type HtmlNode,
} from './helpers/html.js';

/**
 * S-16 rendered surface — US-026, R-014-1, R-002-4, R-013-1, UX A-24/A-25.
 * The panel is asserted through accessible text and structure, not snapshot
 * strings, so a copy tweak elsewhere cannot mask a lost package fact.
 */

const detail: VideoDetail = VideoDetailSchema.parse(FIXTURES['video.get']);
const fixture: ExportView = ExportViewSchema.parse(FIXTURES['export.get']);

function approved(base: VideoDetail): VideoDetail {
  return {
    ...base,
    stages: base.stages.map((stage) =>
      stage.stage === 'FA' ? { ...stage, state: 'done' } : stage,
    ),
  };
}

const built: ExportView = {
  ...fixture,
  status: 'done',
  package_built_at: '2026-10-20T09:45:00.000Z',
};

function render(
  view: ExportView | null,
  options: { buildWired?: boolean; detail?: VideoDetail } = {},
) {
  const html = renderExportPanel({
    detail: options.detail ?? detail,
    view,
    buildWired: options.buildWired ?? true,
  });
  return { html, root: parseHtml(html) };
}

function section(root: HtmlNode): HtmlNode {
  const node = byId(root, 'export');
  if (node === undefined) throw new Error('missing #export');
  return node;
}

function attr(node: HtmlNode, name: string): string | undefined {
  return node.attrs[name];
}

describe('S-16 built package', () => {
  const { root } = render(built);

  it('marks the region built and names it as a ready package', () => {
    const node = section(root);
    expect(attr(node, 'data-state')).toBe('built');
    expect(attr(node, 'data-video-id')).toBe(detail.id);
    expect(textOf(byId(root, 'export-heading')!)).toBe('Package ready');
  });

  it('states the file count and the server total', () => {
    expect(textOf(byId(root, 'export-summary')!)).toBe('5 files · 46.0 MB');
  });

  it('lists every file with name, kind, size and full SHA-256', () => {
    const rows = findAll(
      root,
      (node) => node.tag === 'tr' && node.attrs['data-file'] !== undefined,
    );
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.attrs['data-file'])).toEqual([
      'video',
      'srt',
      'vtt',
      'sidecar',
      'manifest',
    ]);
    const first = textOf(rows[0]!);
    expect(first).toContain('founders-quietly-2026-10-20.mp4');
    expect(first).toContain('MP4');
    expect(first).toContain('46.0 MB');
  });

  it('gives each file its own download link', () => {
    const links = findAll(
      root,
      (node) => node.attrs['class']?.includes('export-row-download') === true,
    );
    expect(links).toHaveLength(5);
    expect(links.every((link) => link.tag === 'a')).toBe(true);
    expect(links[1]?.attrs['href']).toBe(fixture.files[1]?.url);
    expect(links[1]?.attrs['download']).toBe(fixture.files[1]?.name);
  });

  it('offers the same five rows as a stacked list for narrow widths', () => {
    const items = findAll(
      root,
      (node) => node.tag === 'li' && node.attrs['data-file'] !== undefined,
    );
    expect(items).toHaveLength(5);
    expect(textOf(items[0]!)).toContain('founders-quietly-2026-10-20.mp4');
    const list = findAll(
      root,
      (node) => node.tag === 'ul' && (node.attrs['class'] ?? '') === 'export-file-list',
    )[0]!;
    const links = findAll(list, (node) => node.tag === 'a');
    expect(links).toHaveLength(5);
    expect(accessibleTextOf(links[0]!)).toContain('founders-quietly-2026-10-20.mp4');
  });

  it('opens the package as a 5-file download with a size sub-label', () => {
    const summary = byId(root, 'export-download-button')!;
    expect(summary.tag).toBe('summary');
    const sub = byTag(summary, 'span').find((node) =>
      (node.attrs['class'] ?? '').includes('export-sub'),
    )!;
    expect(textOf(sub)).toBe('5 files · 46.0 MB');
  });

  it('lists all eleven per-stage pins in stage order', () => {
    const table = byId(root, 'export-pins')!;
    const rows = findAll(
      table,
      (node) => node.tag === 'tr' && node.attrs['data-stage'] !== undefined,
    );
    expect(rows).toHaveLength(11);
    expect(rows.map((row) => row.attrs['data-stage'])).toEqual([
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
    ]);
  });

  it('summarises the mixed pins and states the full set as one line', () => {
    expect(textOf(byId(root, 'export-pin-summary')!)).toBe('pins: v2 ×3 · v3 ×8');
    expect(textOf(byId(root, 'export-pin-line')!)).toBe(
      'Per stage: T v2 · RS v2 · SC v2 · SB v3 · IM v3 · NA v3 · TC v3 · RE v3 · QC v3 · FA v3 · EX v3.',
    );
  });

  it('keeps the version ids inspectable without a wall of UUIDs', () => {
    const ids = findAll(root, (node) => node.attrs['class'] === 'export-pin-ids');
    expect(ids).toHaveLength(1);
    expect(textOf(ids[0]!)).toContain('11111111-1111-4111-8111-333333333333');
  });

  it('shows the recorded source manifest in a collapsed block', () => {
    const manifest = byId(root, 'export-manifest')!;
    const summary = byTag(manifest, 'summary')[0]!;
    expect(textOf(summary)).toBe('Show the recorded manifest');
    const pre = byTag(manifest, 'pre')[0]!;
    expect(textOf(pre)).toContain('"video_id"');
    expect(textOf(pre)).toContain(detail.id);
  });

  it('does not offer a build button when the package is current', () => {
    expect(byId(root, 'export-build')).toBeUndefined();
    expect(byId(root, 'export-actions')).toBeDefined();
  });

  it('tells the operator downloads work below the 768 px band', () => {
    expect(textOf(byId(root, 'export-band-note')!)).toContain('768 px');
  });
});

describe('S-16 not eligible', () => {
  const { root } = render(fixture);

  it('states the exact eligibility line, without a filename or size', () => {
    expect(attr(section(root), 'data-state')).toBe('not_eligible');
    const text = textOf(section(root));
    expect(text).toContain(NOT_ELIGIBLE_LINE);
    expect(text).not.toContain('founders-quietly-2026-10-20.mp4');
    expect(text).not.toContain('46.0 MB');
  });

  it('renders a disabled download control that names the same reason', () => {
    const button = byId(root, 'export-download-button')!;
    expect(button.tag).toBe('button');
    expect(attr(button, 'aria-disabled')).toBe('true');
    expect(attr(button, 'disabled')).toBeDefined();
    expect(attr(button, 'aria-describedby')).toBe('export-download-reason export-download-summary');
    expect(textOf(byId(root, 'export-download-summary')!)).toBe(NOT_ELIGIBLE_LINE);
  });

  it('names the five kinds the package will contain', () => {
    const kinds = findAll(root, (node) => node.attrs['data-kind'] !== undefined);
    expect(kinds.map((node) => node.attrs['data-kind'])).toEqual([
      'video',
      'srt',
      'vtt',
      'sidecar',
      'manifest',
    ]);
    expect(textOf(byId(root, 'export-expected')!)).toContain('appear once the package is built');
  });

  it('routes the operator to final approval on Render', () => {
    const link = byId(root, 'export-render-link')!;
    expect(link.tag).toBe('a');
    expect(link.attrs['href']).toBe('/videos/' + detail.id + '/render');
  });

  it('disables the build control with the eligibility reason', () => {
    const button = byId(root, 'export-build-button')!;
    expect(attr(button, 'aria-disabled')).toBe('true');
    expect(textOf(byId(root, 'export-build-reason')!)).toBe(NOT_ELIGIBLE_LINE);
  });
});

describe('S-16 build and failure states', () => {
  it('offers Build package once the video is approved and the package is missing', () => {
    const { root } = render({ ...fixture, status: 'not_run' }, { detail: approved(detail) });
    expect(attr(section(root), 'data-state')).toBe('not_built');
    const form = byId(root, 'export-build')!;
    expect(form.tag).toBe('form');
    expect(attr(form, 'method')).toBe('post');
    expect(attr(form, 'action')).toBe('/videos/' + detail.id + '/export');
    expect(textOf(byId(root, 'export-build-button')!)).toBe('Build package');
  });

  it('says the build seam is not mounted rather than offering a dead button', () => {
    const { root } = render(
      { ...fixture, status: 'not_run' },
      { detail: approved(detail), buildWired: false },
    );
    const button = byId(root, 'export-build-button')!;
    expect(button.tag).toBe('button');
    expect(attr(button, 'aria-disabled')).toBe('true');
    expect(textOf(byId(root, 'export-build-reason')!)).toContain('not mounted');
    expect(byTag(root, 'form')).toHaveLength(0);
  });

  it('reports a failed build with a retry, and never a download', () => {
    const { root } = render({ ...fixture, status: 'failed' });
    expect(textOf(byId(root, 'export-heading')!)).toBe('Package build failed');
    expect(textOf(section(root))).toContain('no error detail');
    expect(textOf(byId(root, 'export-build-button')!)).toBe('Rebuild package');
    expect(
      findAll(root, (node) => node.attrs['class']?.includes('export-row-download') === true),
    ).toHaveLength(0);
  });

  it('keeps a stale package downloadable and says what it is', () => {
    const { root } = render({ ...built, status: 'stale' });
    expect(attr(section(root), 'data-state')).toBe('stale');
    expect(textOf(section(root))).toContain('complete and downloadable');
    expect(textOf(byId(root, 'export-build-button')!)).toBe('Rebuild package');
    expect(
      findAll(root, (node) => node.attrs['class']?.includes('export-row-download') === true),
    ).toHaveLength(5);
  });

  it('does not fake a download when the stage is done but lists no files', () => {
    const { root } = render({ ...fixture, status: 'done', files: [] });
    expect(attr(section(root), 'data-state')).toBe('missing_files');
    expect(textOf(section(root))).toContain('R-014-1');
    expect(byId(root, 'export-download-button')!.attrs['aria-disabled']).toBe('true');
  });

  it('renders a refusal notice as a status message, not a colour', () => {
    const html = renderExportPanel({
      detail,
      view: fixture,
      buildWired: true,
      notice: { kind: 'error', message: 'Nothing to build while export is blocked.' },
    });
    const root = parseHtml(html);
    const notice = byId(root, 'export-notice')!;
    expect(notice.attrs['role']).toBe('status');
    expect(notice.attrs['data-notice']).toBe('error');
    expect(textOf(notice)).toContain('Nothing to build while export is blocked.');
  });
});
