import { describe, expect, it } from 'vitest';

import { RenderViewSchema, VideoDetailSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { renderQualityPanel } from '../../src/web/render/quality.js';
import {
  APPROVAL_GATE_LINE,
  SAFE_AREA_LINE,
  type RenderView,
} from '../../src/web/quality/model.js';
import type { VideoDetail } from '../../src/web/workspace/model.js';
import { byId, byTag, parseHtml, textOf, type HtmlNode } from './helpers/html.js';

/**
 * S-15 panel HTML — US-024, US-025, R-010-2…7, R-005-3/4, AX-15.
 *
 * The renderer is a string function, so these assertions run on the structure
 * the browser receives: six numbered rows, one safe-area rectangle, a real
 * `<video>` with a captions track and a text alternative, and the approval
 * control with its gate copy. No JS is required for any of it.
 */

const detail: VideoDetail = VideoDetailSchema.parse(FIXTURES['video.get']);
const fixture: RenderView = RenderViewSchema.parse(FIXTURES['render.get']);

function view(overrides: Partial<RenderView> = {}): RenderView {
  return { ...fixture, ...overrides };
}

function html(
  input: {
    render?: RenderView | null;
    revision?: number | null;
    approveWired?: boolean;
    detail?: VideoDetail;
  } = {},
) {
  return renderQualityPanel({
    detail: input.detail ?? detail,
    render: input.render === undefined ? view() : input.render,
    revision: input.revision === undefined ? 7 : input.revision,
    approveWired: input.approveWired ?? true,
  });
}

function rows(page: HtmlNode): HtmlNode[] {
  return byTag(page, 'tr').filter((node) => node.attrs['data-check'] !== undefined);
}

describe('S-15 awaiting approval', () => {
  it('renders the panel with its state and summary', () => {
    const page = parseHtml(html());
    const panel = byId(page, 'quality');
    expect(panel?.attrs['data-state']).toBe('awaiting_approval');
    expect(panel?.attrs['data-video-id']).toBe(detail.id);
    expect(textOf(byId(page, 'quality-heading') as HtmlNode)).toBe('Render and quality checks');
    expect(textOf(byId(page, 'quality-summary') as HtmlNode)).toBe(
      '1080×1920 · 30 fps · 75.1 s · 6 of 6 checks passing',
    );
  });

  it('shows every QC check with its requirement id its measured number and its expected value', () => {
    const page = parseHtml(html());
    const checks = rows(page);
    expect(checks).toHaveLength(6);
    expect(checks.map((row) => row.attrs['data-check'])).toEqual([
      'R-010-2',
      'R-010-3',
      'R-010-4',
      'R-010-5',
      'R-010-6',
      'R-010-7',
    ]);
    expect(checks.map((row) => row.attrs['data-status'])).toEqual([
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
    ]);
    const measured = checks.map((row) => {
      const cells = byTag(row, 'td');
      return textOf(cells[0] as HtmlNode);
    });
    expect(measured).toEqual([
      '1080×1920 @ 30 fps',
      '75.1 s audio · 75.1 s video · +0.0 s',
      '0 flagged',
      '17 of 17 scenes · min margin +0.0 s',
      '100.0 %',
      '75.1 s',
    ]);
    for (const row of checks) {
      expect(textOf(row)).toContain('QC-');
      expect(textOf(row)).toContain('PASS');
    }
    const expected = checks.map((row) => textOf(byTag(row, 'td')[1] as HtmlNode));
    expect(expected[0]).toContain('±0 px');
    expect(expected[5]).toBe('71.3–78.8 s');
  });

  it('renders the 1080×1920 output with captions and a text alternative (AX-15)', () => {
    const page = parseHtml(html());
    const video = byTag(page, 'video')[0];
    expect(video).toBeDefined();
    expect(video?.attrs['controls']).toBeDefined();
    expect(video?.attrs['src']).toBe('/asset/' + fixture.video?.id + '/full');
    expect(video?.attrs['poster']).toBe('/asset/' + fixture.poster?.id + '/full');
    expect(video?.attrs['aria-describedby']).toBe('render-video-alt');
    const track = byTag(video as HtmlNode, 'track')[0];
    expect(track?.attrs['kind']).toBe('captions');
    expect(track?.attrs['src']).toBe('/asset/' + fixture.captions.vtt?.id + '/full');
    expect(track?.attrs['srclang']).toBe('en');
    expect(textOf(byId(page, 'render-video-alt') as HtmlNode)).toBe(
      'Rendered video: 1080×1920, 30 fps, 75.1 s, captions available.',
    );
  });

  it('draws exactly one safe-area rectangle with its label (D13)', () => {
    const page = parseHtml(html());
    const rectangles = byTag(page, 'div').filter(
      (node) => node.attrs['data-safe-area'] !== undefined,
    );
    expect(rectangles).toHaveLength(1);
    expect(rectangles[0]?.attrs['aria-hidden']).toBe('true');
    expect(textOf(byId(page, 'quality-safe-note') as HtmlNode)).toBe(SAFE_AREA_LINE);
  });

  it('offers a visible download link to the final MP4', () => {
    const page = parseHtml(html());
    const link = byTag(page, 'a').find((node) => (node.attrs['href'] ?? '').endsWith('/download'));
    expect(link).toBeDefined();
    expect(link?.attrs['href']).toBe('/videos/' + detail.id + '/download');
    expect(textOf(link as HtmlNode)).toBe('Download MP4');
  });

  it('states the render facts, including the pass count', () => {
    const page = parseHtml(html());
    const stats = byId(page, 'quality-stats') as HtmlNode;
    const text = textOf(stats);
    expect(text).toContain('Passes');
    expect(text).toContain('1 pass');
    expect(text).toContain('Resolution');
    expect(text).toContain('1080×1920');
    expect(text).toContain('Wall time');
    expect(text).toContain('214.6 s');
    expect(text).toContain('Peak RAM');
    expect(text).toContain('1412 MB');
  });

  it('carries the gate: a form posting the revision with the exact button label', () => {
    const page = parseHtml(html());
    const form = byTag(page, 'form').find((node) =>
      (node.attrs['action'] ?? '').endsWith('/render/approve'),
    );
    expect(form).toBeDefined();
    expect(form?.attrs['method']).toBe('post');
    expect(form?.attrs['action']).toBe('/videos/' + detail.id + '/render/approve');
    const revision = byTag(form as HtmlNode, 'input').find(
      (node) => node.attrs['name'] === 'revision',
    );
    expect(revision?.attrs['value']).toBe('7');
    const note = byTag(form as HtmlNode, 'textarea').find((node) => node.attrs['name'] === 'note');
    expect(note?.attrs['maxlength']).toBe('2000');
    const button = byTag(form as HtmlNode, 'button')[0];
    expect(textOf(button as HtmlNode)).toBe('Approve final');
    expect(button?.attrs['aria-describedby']).toBe('quality-gate-line');
    expect(textOf(byId(page, 'quality-gate-line') as HtmlNode)).toBe(APPROVAL_GATE_LINE);
    expect(byId(page, 'quality-approval')?.attrs['data-approval']).toBe('ready');
  });

  it('offers the named stages as the return path and states that a rejection is not recordable', () => {
    const page = parseHtml(html());
    const returnBlock = byId(page, 'quality-return') as HtmlNode;
    const links = byTag(returnBlock, 'a');
    expect(links.map((link) => textOf(link))).toEqual(['Script', 'Storyboard', 'Scenes', 'Audio']);
    expect(links[0]?.attrs['href']).toBe('/videos/' + detail.id + '/script');
    expect(textOf(returnBlock)).toContain('no billable call');
    expect(textOf(returnBlock)).toContain('cannot record a rejection');
  });
});

describe('S-15 blocked states', () => {
  it('names the failing check and keeps approval disabled rather than hiding it', () => {
    const failed = view({
      qc: {
        ...fixture.qc,
        status: 'fail',
        checks: fixture.qc.checks.map((check) =>
          check.requirement === 'R-010-6' ? { ...check, pass: false, measured: '94.2 %' } : check,
        ),
      },
    });
    const page = parseHtml(html({ render: failed }));
    expect(byId(page, 'quality')?.attrs['data-state']).toBe('qc_failed');
    expect(byId(page, 'quality-approval')?.attrs['data-approval']).toBe('blocked');
    expect(byTag(page, 'form')).toHaveLength(0);
    const button = byId(page, 'quality-approve-button') as HtmlNode;
    expect(button.attrs['disabled']).toBeDefined();
    expect(button.attrs['aria-disabled']).toBe('true');
    expect(button.attrs['aria-describedby']).toContain('quality-approval-reason');
    expect(textOf(byId(page, 'quality-failing') as HtmlNode)).toContain('QC-6');
    expect(textOf(byId(page, 'quality-failing') as HtmlNode)).toContain('94.2 %');
    expect(textOf(byId(page, 'quality-approval-reason') as HtmlNode)).toContain('QC-6');
    expect(rows(page).filter((row) => row.attrs['data-status'] === 'fail')).toHaveLength(1);
  });

  it('marks a check the response omits as NOT REPORTED and blocks approval', () => {
    const partial = view({
      qc: {
        ...fixture.qc,
        checks: fixture.qc.checks.filter((check) => check.requirement !== 'R-010-4'),
      },
    });
    const page = parseHtml(html({ render: partial }));
    const missing = rows(page).filter((row) => row.attrs['data-status'] === 'missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]?.attrs['data-check']).toBe('R-010-4');
    expect(textOf(missing[0] as HtmlNode)).toContain('NOT REPORTED');
    expect(textOf(missing[0] as HtmlNode)).toContain('—');
    expect(textOf(byId(page, 'quality-approval-reason') as HtmlNode)).toContain('R-010-4');
  });

  it('shows the QC-running state while the checks have no numbers', () => {
    const running = view({
      status: 'done',
      qc: { status: 'not_run', checks: [], checked_at: null },
    });
    const page = parseHtml(html({ render: running }));
    expect(byId(page, 'quality')?.attrs['data-state']).toBe('qc_running');
    expect(textOf(byId(page, 'quality-checked') as HtmlNode)).toContain('QC has not reported yet');
    expect(textOf(byId(page, 'quality-approval-reason') as HtmlNode)).toContain('has not reported');
  });

  it('renders the render-running state with the slot, the leave note and no false progress', () => {
    const running = view({ status: 'running', qc: { ...fixture.qc, status: 'not_run' } });
    const page = parseHtml(html({ render: running }));
    expect(byId(page, 'quality')?.attrs['data-state']).toBe('running');
    expect(textOf(byId(page, 'quality-summary') as HtmlNode)).toBe(
      'Render 1 of 1 running (single concurrent render).',
    );
    expect(textOf(byId(page, 'quality-leave-note') as HtmlNode)).toBe(
      'Leaving this page does not stop the job.',
    );
    expect(textOf(byId(page, 'quality-qc-pending') as HtmlNode)).toContain('QC has not run');
    expect(rows(page)).toHaveLength(0);
  });

  it('renders a failed render with the six facts and the retry scope, and no approval', () => {
    const failed = view({
      status: 'failed',
      video: null,
      qc: { status: 'not_run', checks: [], checked_at: null },
    });
    const failedDetail = VideoDetailSchema.parse({
      ...detail,
      stages: detail.stages.map((stage) =>
        stage.stage === 'RE'
          ? {
              ...stage,
              state: 'failed',
              attempts: { count: 3, max_attempts: 3, last_error_class: 'transient' },
            }
          : stage,
      ),
    });
    const page = parseHtml(html({ render: failed, detail: failedDetail }));
    expect(byId(page, 'quality')?.attrs['data-state']).toBe('failed');
    expect(byTag(page, 'video')).toHaveLength(0);
    const note = textOf(byId(page, 'quality-failure') as HtmlNode);
    expect(note).toContain('render');
    expect(note).toContain('3 of 3 attempts used');
    expect(note).toContain('1 pass');
    expect(note).toMatch(/no provider call/i);
    expect(byTag(page, 'form')).toHaveLength(0);
    expect(byId(page, 'quality-approve-button')).toBeDefined();
  });

  it('renders the empty state with its exact line and the audio unlock', () => {
    const page = parseHtml(html({ render: null }));
    expect(byId(page, 'quality')?.attrs['data-state']).toBe('empty');
    expect(textOf(byId(page, 'quality-empty') as HtmlNode)).toBe(
      'No render yet. It runs after narration and timing.',
    );
    expect(byId(page, 'quality-empty-action')?.attrs['href']).toBe(
      '/videos/' + detail.id + '/audio',
    );
    expect(byTag(page, 'video')).toHaveLength(0);
    expect(byTag(page, 'form')).toHaveLength(0);
  });

  it('explains an approval that cannot be sent instead of posting a guessed revision', () => {
    const page = parseHtml(html({ revision: null }));
    expect(byTag(page, 'form')).toHaveLength(0);
    expect(textOf(byId(page, 'quality-approval-reason') as HtmlNode)).toContain(
      'cannot supply the revision',
    );
    expect(byId(page, 'quality-approval')?.attrs['data-approval']).toBe('blocked');
  });
});

describe('S-15 approved', () => {
  it('replaces the form with the approval record and the export link', () => {
    const approved = view({ approved: true, approved_at: fixture.qc.checked_at });
    const page = parseHtml(html({ render: approved }));
    expect(byId(page, 'quality')?.attrs['data-state']).toBe('approved');
    expect(byTag(page, 'form')).toHaveLength(0);
    const approvedLine = textOf(byId(page, 'quality-approved') as HtmlNode);
    expect(approvedLine).toContain('Final approval recorded 2026-10-20T09:41:12Z.');
    expect(approvedLine).toContain('Export is enabled; nothing else changed.');
    const link = byTag(page, 'a').find((node) => (node.attrs['href'] ?? '').endsWith('/export'));
    expect(link?.attrs['href']).toBe('/videos/' + detail.id + '/export');
    expect(textOf(link as HtmlNode)).toBe('Open Export');
    expect(byId(page, 'quality-approval')?.attrs['data-approval']).toBe('approved');
  });
});

describe('S-15 notices and the monitoring band', () => {
  it('renders the approval notice as a status, not an alert', () => {
    const page = parseHtml(
      renderQualityPanel({
        detail,
        render: view({ approved: true, approved_at: fixture.qc.checked_at }),
        revision: 7,
        approveWired: true,
        notice: {
          kind: 'success',
          message: 'Final approval recorded. Export is enabled; nothing else changed.',
        },
      }),
    );
    const notice = byTag(page, 'div').find((node) => node.attrs['data-notice'] !== undefined);
    expect(notice?.attrs['role']).toBe('status');
    expect(notice?.attrs['data-notice']).toBe('success');
    expect(textOf(notice as HtmlNode)).toContain('Export is enabled');
  });

  it('states the monitoring rule for the narrow band, outside the hidden controls', () => {
    const page = parseHtml(html());
    expect(textOf(byId(page, 'quality-band-note') as HtmlNode)).toBe(
      'Approvals need a screen 1024 px or wider. This view is monitoring only.',
    );
    // §7.1 hides .quality-approval below 768; the note must not be inside it or
    // it would disappear with the control it replaces.
    expect(textOf(byId(page, 'quality-approval') as HtmlNode)).not.toContain('monitoring only');
    expect(textOf(page)).toContain('Approvals need a screen 1024 px or wider');
  });
});
