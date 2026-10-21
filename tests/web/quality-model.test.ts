import { describe, expect, it } from 'vitest';

import { RenderViewSchema, VideoDetailSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import {
  APPROVAL_GATE_LINE,
  APPROVAL_UNWIRED_REASON,
  EMPTY_LINE,
  QC_CATALOGUE,
  QC_REQUIREMENTS,
  RETURN_LINE,
  SAFE_AREA_LINE,
  qcView,
  renderPanelModel,
  type RenderView,
} from '../../src/web/quality/model.js';
import { qualityNotice } from '../../src/web/quality/notice.js';
import type { VideoDetail } from '../../src/web/workspace/model.js';

/**
 * S-15 view model — US-024, US-025, US-028 (final-approve gate), R-010-2…7,
 * R-005-3/4, UX_SPEC A-21…A-23 and the S-15 states table, UI_SPEC §9.2/§9.6.
 *
 * No provider, no socket: the fixture and hand-built contract shapes only.
 */

const detail: VideoDetail = VideoDetailSchema.parse(FIXTURES['video.get']);
const fixture: RenderView = RenderViewSchema.parse(FIXTURES['render.get']);

function render(overrides: Partial<RenderView> = {}): RenderView {
  return { ...fixture, ...overrides };
}

function panel(
  view: RenderView | null,
  overrides: { revision?: number | null; approveWired?: boolean; detail?: VideoDetail } = {},
) {
  return renderPanelModel({
    detail: overrides.detail ?? detail,
    render: view,
    revision: overrides.revision === undefined ? 7 : overrides.revision,
    approveWired: overrides.approveWired ?? true,
  });
}

describe('the six QC checks of R-010-2…7', () => {
  it('has one catalogue row per requirement, in requirement order', () => {
    expect(QC_REQUIREMENTS).toEqual([
      'R-010-2',
      'R-010-3',
      'R-010-4',
      'R-010-5',
      'R-010-6',
      'R-010-7',
    ]);
    expect(QC_CATALOGUE.map((entry) => entry.requirement)).toEqual([...QC_REQUIREMENTS]);
    expect(QC_CATALOGUE.map((entry) => entry.checkId)).toEqual([
      'QC-2',
      'QC-3',
      'QC-4',
      'QC-5',
      'QC-6',
      'QC-7',
    ]);
    for (const entry of QC_CATALOGUE) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.expected.length).toBeGreaterThan(0);
    }
  });

  it('reports every check in the mock fixture with a measured number', () => {
    const checks = fixture.qc.checks;
    expect(checks.map((check) => check.requirement).sort()).toEqual([...QC_REQUIREMENTS].sort());
    for (const check of checks) {
      expect(check.measured.trim().length).toBeGreaterThan(0);
      expect(check.expected.trim().length).toBeGreaterThan(0);
      expect(check.pass).toBe(true);
    }
    // R-010-3 is the audio-vs-video ±0.5 s check, not the duration band.
    const audio = checks.find((check) => check.requirement === 'R-010-3');
    expect(audio?.label).toMatch(/audio/i);
    expect(audio?.measured).toMatch(/0\.0 s|75\.1/);
    const duration = checks.find((check) => check.requirement === 'R-010-7');
    expect(duration?.measured).toBe('75.1 s');
  });

  it('orders the rows by requirement and shows each number with its id', () => {
    const view = qcView(fixture.qc.checks, fixture.qc.checked_at);
    expect(view.rows).toHaveLength(6);
    expect(view.rows.map((row) => row.requirement)).toEqual([...QC_REQUIREMENTS]);
    expect(view.rows.map((row) => row.id)).toEqual([
      'QC-2',
      'QC-3',
      'QC-4',
      'QC-5',
      'QC-6',
      'QC-7',
    ]);
    expect(view.rows.every((row) => row.status === 'pass')).toBe(true);
    expect(view.total).toBe(6);
    expect(view.passed).toBe(6);
    expect(view.failed).toBe(0);
    expect(view.missing).toBe(0);
    expect(view.complete).toBe(true);
    expect(view.allPass).toBe(true);
    expect(view.summaryLine).toBe('6 of 6 checks passing');
    expect(view.missingLine).toBeNull();
    expect(view.failingLine).toBeNull();
  });

  it('marks a requirement the response omits as not reported, never as a pass', () => {
    const checks = fixture.qc.checks.filter(
      (check) => check.requirement !== 'R-010-4' && check.requirement !== 'R-010-5',
    );
    const view = qcView(checks, fixture.qc.checked_at);
    const missing = view.rows.filter((row) => row.status === 'missing');
    expect(missing.map((row) => row.id)).toEqual(['QC-4', 'QC-5']);
    expect(missing.every((row) => row.measured === '—')).toBe(true);
    expect(view.missing).toBe(2);
    expect(view.complete).toBe(false);
    expect(view.allPass).toBe(false);
    expect(view.summaryLine).toBe('4 of 6 checks passing · 2 not reported');
    expect(view.missingLine).toContain('R-010-4, R-010-5');
    expect(view.missingLine).toContain('QC-4, QC-5');
  });

  it('names the exact failing check with its measured and expected numbers', () => {
    const checks = fixture.qc.checks.map((check) =>
      check.requirement === 'R-010-6' ? { ...check, pass: false, measured: '94.2 %' } : check,
    );
    const view = qcView(checks, fixture.qc.checked_at);
    expect(view.failed).toBe(1);
    expect(view.allPass).toBe(false);
    expect(view.summaryLine).toBe('5 of 6 checks passing · 1 failing');
    expect(view.failingLine).toBe(
      'QC-6 · R-010-6 · Captions inside the 5 % safe area — measured 94.2 %, expected 100.0 %.',
    );
  });

  it('keeps a check the contract adds outside R-010-2…7 visible after the six', () => {
    const view = qcView(
      [
        ...fixture.qc.checks,
        {
          id: 'QC-9',
          label: 'Loudness',
          pass: true,
          measured: '-16 LUFS',
          expected: '-16 ±1 LUFS',
          requirement: 'R-099-1',
        },
      ],
      fixture.qc.checked_at,
    );
    expect(view.rows).toHaveLength(7);
    expect(view.total).toBe(6);
    const extra = view.rows[6];
    expect(extra?.requirement).toBe('R-099-1');
    expect(extra?.extra).toBe(true);
    expect(extra?.status).toBe('pass');
    expect(view.passed).toBe(6);
  });
});

describe('S-15 panel states (UX_SPEC §6.1 states table)', () => {
  it('waits for approval when the render is done and all six checks pass', () => {
    const model = panel(render());
    expect(model.state).toBe('awaiting_approval');
    expect(model.chip).toBe('awaiting_approval');
    expect(model.heading).toMatch(/quality/i);
    expect(model.summaryLine).toContain('1080×1920');
    expect(model.summaryLine).toContain('30 fps');
    expect(model.summaryLine).toContain('75.1 s');
    expect(model.summaryLine).toContain('6 of 6 checks passing');
  });

  it('is approved only when the contract says approved', () => {
    const model = panel(render({ approved: true, approved_at: fixture.qc.checked_at }));
    expect(model.state).toBe('approved');
    expect(model.chip).toBe('done');
    expect(model.approval.approvedLine).toContain('Final approval recorded');
    expect(model.approval.approvedLine).toContain('2026-10-20T09:41:12Z');
    expect(model.approval.approvedLine).toContain('Export is enabled; nothing else changed.');
    expect(model.approval.enabled).toBe(false);
  });

  it('names a failing QC check and blocks approval', () => {
    const model = panel(
      render({
        qc: {
          ...fixture.qc,
          status: 'fail',
          checks: fixture.qc.checks.map((check) =>
            check.requirement === 'R-010-5'
              ? { ...check, pass: false, measured: '16 of 17 scenes' }
              : check,
          ),
        },
      }),
    );
    expect(model.state).toBe('qc_failed');
    expect(model.chip).toBe('failed');
    expect(model.qc.failingLine).toContain('QC-5');
    expect(model.qc.failingLine).toContain('16 of 17 scenes');
    expect(model.approval.enabled).toBe(false);
    expect(model.approval.reason).toContain('QC-5');
    expect(model.approval.reason).toContain('R-010-5');
  });

  it('reports QC running between the render and the checks', () => {
    const model = panel(
      render({ qc: { status: 'not_run', checks: [], checked_at: null }, status: 'done' }),
    );
    expect(model.state).toBe('qc_running');
    expect(model.chip).toBe('running');
    expect(model.qc.rows).toHaveLength(6);
    expect(model.qc.missing).toBe(6);
    expect(model.approval.reason).toContain('has not reported');
  });

  it('shows the render slot while running, and never a progress percentage', () => {
    const model = panel(render({ status: 'running', qc: { ...fixture.qc, status: 'not_run' } }));
    expect(model.state).toBe('running');
    expect(model.summaryLine).toBe('Render 1 of 1 running (single concurrent render).');
    expect(model.approval.enabled).toBe(false);
    expect(model.leaveNote).toBe('Leaving this page does not stop the job.');
  });

  it('uses the RE stage row when the render endpoint has no output yet', () => {
    const empty = VideoDetailSchema.parse({
      ...detail,
      stages: detail.stages.map((stage) =>
        stage.stage === 'RE'
          ? { ...stage, state: 'not_run', progress: { current: 0, total: 0 } }
          : stage,
      ),
    });
    const model = panel(null, { detail: empty });
    expect(model.state).toBe('empty');
    expect(model.heading).toBe('No render yet');
    expect(model.emptyLine).toBe(EMPTY_LINE);
    expect(model.approval.enabled).toBe(false);

    const running = VideoDetailSchema.parse({
      ...detail,
      stages: detail.stages.map((stage) =>
        stage.stage === 'RE'
          ? { ...stage, state: 'running', progress: { current: 1, total: 1 } }
          : stage,
      ),
    });
    expect(panel(null, { detail: running }).state).toBe('running');
  });

  it('separates a failed render from a failed check, with the attempts used', () => {
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
    const model = panel(render({ status: 'failed' }), { detail: failedDetail });
    expect(model.state).toBe('failed');
    expect(model.chip).toBe('failed');
    expect(model.summaryLine).toContain('transient');
    expect(model.summaryLine).toContain('3 of 3 attempts used');
    expect(model.failureNote).toContain('render');
    expect(model.failureNote).toContain('1 pass');
    expect(model.failureNote).toMatch(/no provider call/i);
    expect(model.approval.reason).toMatch(/nothing to approve/i);
  });

  it('treats a stale render as stale even though its stored state is done', () => {
    const staleDetail = VideoDetailSchema.parse({
      ...detail,
      stages: detail.stages.map((stage) =>
        stage.stage === 'RE'
          ? { ...stage, stale: true, stale_cause: 'script rev 4 changed at 14:12 UTC' }
          : stage,
      ),
    });
    const model = panel(render(), { detail: staleDetail });
    expect(model.state).toBe('stale');
    expect(model.chip).toBe('stale');
    expect(model.staleLine).toContain('script rev 4 changed at 14:12 UTC');
    expect(model.approval.reason).toMatch(/stale/i);
  });

  it('keeps a blocked render blocked with the stage reason', () => {
    const blockedDetail = VideoDetailSchema.parse({
      ...detail,
      stages: detail.stages.map((stage) =>
        stage.stage === 'RE'
          ? { ...stage, state: 'blocked', blocked_reason: 'waiting: render slot 1 of 1' }
          : stage,
      ),
    });
    const model = panel(render({ status: 'blocked' }), { detail: blockedDetail });
    expect(model.state).toBe('blocked');
    expect(model.chip).toBe('blocked');
    expect(model.summaryLine).toBe('waiting: render slot 1 of 1');
  });
});

describe('final approval is the gate to export (R-005-3, R-005-4)', () => {
  it('enables approval only with six passing numbers, an output, a revision and a seam', () => {
    const model = panel(render());
    expect(model.approval.visible).toBe(true);
    expect(model.approval.enabled).toBe(true);
    expect(model.approval.reason).toBeNull();
    expect(model.approval.gateLine).toBe(APPROVAL_GATE_LINE);
    expect(APPROVAL_GATE_LINE).toContain('enables export and nothing else');
    expect(model.approval.revision).toBe(7);
  });

  it('refuses to enable approval without the revision the contract requires (gap S-15-1)', () => {
    const model = panel(render(), { revision: null });
    expect(model.approval.enabled).toBe(false);
    expect(model.approval.reason).toBe(APPROVAL_UNWIRED_REASON);
    expect(model.approval.unwired).toBe(true);
    expect(model.approval.revision).toBeNull();
  });

  it('refuses to enable approval when the gateway has no approve seam (gap S-15-1)', () => {
    const model = panel(render(), { approveWired: false });
    expect(model.approval.enabled).toBe(false);
    expect(model.approval.reason).toBe(APPROVAL_UNWIRED_REASON);
  });

  it('refuses approval when any check is missing, naming the missing ids', () => {
    const checks = fixture.qc.checks.filter((check) => check.requirement !== 'R-010-4');
    const model = panel(render({ qc: { ...fixture.qc, checks } }));
    expect(model.approval.enabled).toBe(false);
    expect(model.approval.reason).toContain('QC-4');
    expect(model.approval.reason).toContain('R-010-4');
  });

  it('refuses approval when the render has no video asset', () => {
    const model = panel(render({ video: null }));
    expect(model.approval.enabled).toBe(false);
    expect(model.approval.reason).toMatch(/no video asset/i);
  });

  it('offers the named upstream stages as the return path, and admits a rejection cannot be recorded', () => {
    const model = panel(render());
    expect(model.approval.returnLinks.map((link) => link.label)).toEqual([
      'Script',
      'Storyboard',
      'Scenes',
      'Audio',
    ]);
    expect(model.approval.returnLinks[0]?.href).toBe('/videos/' + detail.id + '/script');
    expect(RETURN_LINE).toContain('named stage');
    expect(RETURN_LINE).toContain('no billable call');
    expect(model.approval.returnLine).toBe(RETURN_LINE);
    expect(model.approval.returnLine).toMatch(/cannot record a rejection/i);
  });

  it('carries the approval notice for the redirect token only', () => {
    expect(qualityNotice('approved')?.kind).toBe('success');
    expect(qualityNotice('approved')?.message).toContain('Export is enabled');
    expect(qualityNotice(null)).toBeNull();
    expect(qualityNotice('nonsense')).toBeNull();
  });
});

describe('render facts and the accessible alternative (AX-15, §9.6)', () => {
  it('states the passes, numbers and caption files', () => {
    const model = panel(render());
    expect(model.stats.passLine).toBe('1 pass');
    const labels = model.stats.rows.map(([label]) => label);
    expect(labels).toEqual([
      'Resolution',
      'Frame rate',
      'Duration',
      'Wall time',
      'Peak RAM',
      'Captions',
    ]);
    const values = Object.fromEntries(model.stats.rows);
    expect(values['Resolution']).toBe('1080×1920');
    expect(values['Frame rate']).toBe('30 fps');
    expect(values['Duration']).toBe('75.1 s');
    expect(values['Wall time']).toBe('214.6 s');
    expect(values['Peak RAM']).toBe('1412 MB');
    expect(values['Captions']).toBe('.srt + .vtt');
  });

  it('writes the video text alternative from the contract values only', () => {
    const model = panel(render());
    expect(model.stats.videoAlt).toBe(
      'Rendered video: 1080×1920, 30 fps, 75.1 s, captions available.',
    );
    const noCaptions = panel(render({ captions: { srt: null, vtt: null } }));
    expect(noCaptions.stats.videoAlt).toBe('Rendered video: 1080×1920, 30 fps, 75.1 s.');
  });

  it('draws exactly one safe-area rectangle and says what it is (D13)', () => {
    const model = panel(render());
    expect(model.safeArea).toBe(SAFE_AREA_LINE);
    expect(SAFE_AREA_LINE).toContain('5 %');
    expect(SAFE_AREA_LINE).toContain('54 px');
    expect(SAFE_AREA_LINE).toContain('96 px');
  });
});
