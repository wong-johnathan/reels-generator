import { describe, expect, it } from 'vitest';

import {
  AttemptRowSchema,
  HealthReportSchema,
  OverviewSchema,
  VideoDetailSchema,
} from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import {
  attemptsView,
  healthSummary,
  type AttemptRow,
  type HealthReport,
} from '../../src/web/health/model.js';
import { renderHealthPage } from '../../src/web/render/health.js';
import { degradedNotices } from '../../src/web/render/shell.js';
import { byId, byTag, findAll, parseHtml, textOf } from './helpers/html.js';

/**
 * S-19 rendered surface — US-011/012/013, R-008-3, R-011-2, R-012-4, R-018-1/2/3.
 * The page must name every degraded state's five parts (IP-07 e) and show
 * attempt charge honestly, with no cost totals.
 */

const report: HealthReport = HealthReportSchema.parse(FIXTURES['health.report']);
const overview = OverviewSchema.parse(FIXTURES['overview.get']);
const detail = VideoDetailSchema.parse(FIXTURES['video.get']);

function render(
  options: {
    readonly health?: HealthReport;
    readonly overview?: typeof overview;
    readonly rows?: readonly AttemptRow[] | null;
    readonly videoId?: string | null;
    readonly stage?: 'NA' | 'IM' | null;
    readonly error?: boolean;
  } = {},
) {
  const health = options.health ?? report;
  const seen = options.overview ?? overview;
  const attempts = attemptsView({
    videoId: options.videoId ?? null,
    videoLabel: options.videoId === undefined ? null : 'Video 18',
    stage: options.stage ?? null,
    rows: options.rows ?? null,
    now: Date.parse('2026-10-20T10:00:00.000Z'),
    error: options.error ?? false,
  });
  const html = renderHealthPage({
    summary: healthSummary(health),
    degraded: degradedNotices(seen, health),
    overview: seen,
    attempts,
    now: Date.parse('2026-10-20T10:00:00.000Z'),
  });
  return { html, root: parseHtml(html), attempts };
}

const rows: AttemptRow[] = [
  {
    ...AttemptRowSchema.parse((FIXTURES['attempts.list'] as { attempts: unknown[] }).attempts[0]),
    id: 'dddddddd-0000-4000-8000-000000000001',
    stage: 'NA',
    charge_status: 'pending',
    status: 'timed_out',
    created_at: '2026-10-20T09:41:00.000Z',
  },
  {
    ...AttemptRowSchema.parse((FIXTURES['attempts.list'] as { attempts: unknown[] }).attempts[0]),
    id: 'dddddddd-0000-4000-8000-000000000002',
    stage: 'IM',
    provider: 'gemini',
    model: 'gemini-nano-banana-2.1',
    charge_status: 'unbilled',
    status: 'failed',
    error_class: 'transient',
    http_status: 503,
    created_at: '2026-10-20T09:31:00.000Z',
  },
];

describe('S-19 degraded service state', () => {
  it('names cause, blocked, still-works, system and next action for every condition', () => {
    const { root } = render();
    const section = byId(root, 'health-degraded')!;
    expect(section.attrs['data-state']).toBe('degraded');
    const blocks = findAll(root, (node) => node.attrs['data-degraded'] !== undefined);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    const terms = byTag(blocks[0]!, 'dt').map((node) => textOf(node));
    expect(terms).toEqual(['Cause', 'Blocked', 'Still works', 'System', 'Next action']);
    expect(textOf(byId(root, 'health-degraded')!)).toContain('disk headroom below 20 %');
    const next = byTag(blocks[0]!, 'dd')[4]!;
    expect(textOf(next)).toContain('Free space before new renders');
  });

  it('names an empty state instead of inventing a failure when nothing is degraded', () => {
    const clean: HealthReport = {
      ...report,
      ready: true,
      degraded_reasons: [],
      components: report.components.map((component) => ({ ...component, status: 'ok' })),
      disk: { free_bytes: 128_849_018_880, total_bytes: 236_223_283_200, headroom_ok: true },
    };
    const { root } = render({ health: clean, overview: { ...overview, degraded: [] } });
    expect(byId(root, 'health-degraded')!.attrs['data-state']).toBe('ready');
    expect(textOf(byId(root, 'health-ready-line')!)).toBe(
      'Service ready. No dependency is degraded; new batches are accepted.',
    );
    expect(findAll(root, (node) => node.attrs['data-degraded'] !== undefined)).toHaveLength(0);
  });
});

describe('S-19 provider block', () => {
  it('gives each provider one state word, never a key value', () => {
    const { root } = render();
    const providers = findAll(
      root,
      (node) => node.tag === 'article' && node.attrs['data-provider'] !== undefined,
    );
    expect(providers.map((node) => node.attrs['data-provider'])).toEqual([
      'deepseek',
      'gemini',
      'elevenlabs',
    ]);
    expect(providers.map((node) => node.attrs['data-state'])).toEqual([
      'ok',
      'ok',
      'not_qualified',
    ]);
    expect(textOf(providers[2]!)).toContain('not qualified');
    expect(textOf(providers[2]!)).toContain('ELEVENLABS_API_KEY');
    expect(textOf(providers[0]!)).toContain('present · DEEPSEEK_API_KEY');
    expect(textOf(providers[0]!)).toContain('Key');
  });

  it('carries the idempotency note into the visible row', () => {
    const { root } = render();
    const gemini = findAll(root, (node) => node.attrs['data-provider'] === 'gemini')[0]!;
    expect(textOf(gemini)).toContain('no honoured idempotency key (R-012-2)');
    expect(textOf(gemini)).toContain('unprotected');
  });

  it('shows qualification as PASS with its timestamp, or NOT RUN', () => {
    const { root } = render();
    const section = textOf(byId(root, 'health-qualification')!);
    expect(section.split('PASS 2026-10-20T09:00:00Z')).toHaveLength(3);
    expect(section).toContain('NOT RUN');
    expect(section).toContain('never treated as a pass');
    const chips = findAll(root, (node) => node.tag === 'li');
    expect(chips.filter((node) => textOf(node).includes('NOT RUN'))).toHaveLength(1);
  });
});

describe('S-19 queue, disk and migration', () => {
  it('shows all three queue counts and the migration version', () => {
    const { root } = render();
    const system = byId(root, 'health-system')!;
    expect(textOf(system)).toContain('waiting 2 · active 1 · failed 0');
    const migration = findAll(system, (node) => node.attrs['data-migration'] !== undefined)[0]!;
    expect(migration.attrs['data-migration']).toBe('up_to_date');
    expect(textOf(migration)).toBe('Migration up to date · M-005');
  });

  it('gives the disk percent a text equivalent and a warning below the margin', () => {
    const { root } = render();
    const meter = byTag(root, 'progress')[0]!;
    expect(meter.attrs['max']).toBe('100');
    expect(meter.attrs['value']).toBe('83');
    expect(textOf(meter)).toBe('83% used');
    expect(textOf(byId(root, 'health-system')!)).toContain('83% full · 38.0 GB free of 220.0 GB');
    expect(textOf(findAll(root, (node) => node.attrs['class'] === 'health-warning')[0]!)).toContain(
      'below the safety margin',
    );
  });
});

describe('S-19 attempt rows', () => {
  it('lists rows newest-first with charge as a word and a structural tone', () => {
    const { root } = render({ rows, videoId: detail.id });
    const trs = findAll(root, (node) => node.attrs['data-attempt'] !== undefined);
    expect(trs).toHaveLength(2);
    expect(trs[0]?.attrs['data-charge']).toBe('unknown');
    expect(textOf(trs[0]!)).toContain('unknown charge');
    expect(textOf(trs[1]!)).toContain('transient · HTTP 503');
  });

  it('never adds a billed-units column or a total', () => {
    const { root } = render({ rows, videoId: detail.id });
    const headers = byTag(root, 'th')
      .filter((node) => node.attrs['scope'] === 'col')
      .map((node) => textOf(node));
    expect(headers).toEqual([
      'Stage',
      'Provider',
      'Model',
      'Prompt hash',
      'Request id',
      'Attempt',
      'Idempotency',
      'Charge',
      'Status',
      'Created',
    ]);
    expect(headers).not.toContain('Units');
    const section = byId(root, 'health-attempts')!;
    expect(textOf(section)).toContain('no totals are computed');
    expect(textOf(section)).toContain('no units column is shown');
    expect(byTag(root, 'caption')[0] && textOf(byTag(root, 'caption')[0]!)).toContain('no totals');
  });

  it('states the page limit and why older rows are not paged', () => {
    const { root, attempts } = render({ rows, videoId: detail.id });
    expect(attempts.limitLine).toBe('Newest first, up to 50 rows.');
    expect(textOf(byId(root, 'health-attempt-limit')!)).toBe('last 50');
    expect(textOf(byId(root, 'health-limit-line')!)).toBe('Newest first, up to 50 rows.');
  });

  it('filters by stage through a GET form that keeps the video', () => {
    const { root } = render({ rows, videoId: detail.id, stage: 'NA' });
    const form = byId(root, 'health-filter')!;
    expect(form.tag).toBe('form');
    expect(form.attrs['method']).toBe('get');
    expect(form.attrs['action']).toBe('/health');
    const hidden = findAll(form, (node) => node.tag === 'input')[0]!;
    expect(hidden.attrs['name']).toBe('video');
    expect(hidden.attrs['value']).toBe(detail.id);
    const options = byTag(form, 'option');
    expect(options).toHaveLength(12);
    expect(options[0]?.attrs['value']).toBe('');
    expect(options.filter((node) => node.attrs['selected'] !== undefined)).toHaveLength(1);
  });

  it('points at videos that need attention when none is selected', () => {
    const { root } = render();
    const links = findAll(
      root,
      (node) => node.tag === 'a' && (node.attrs['href'] ?? '').startsWith('/health?video='),
    );
    expect(links).toHaveLength(overview.attention.length);
    expect(textOf(byId(root, 'health-video-picker')!)).toContain('Choose a video');
    expect(textOf(root)).toContain('not per service');
  });

  it('says there are no rows for the filtered stage', () => {
    const { root } = render({ rows: [rows[1]!], videoId: detail.id, stage: 'NA' });
    expect(textOf(byId(root, 'health-attempts')!)).toContain(
      'No attempt rows for this video at NA (Narration).',
    );
  });

  it('reports a load failure in the table, not as an empty list', () => {
    const { root } = render({ videoId: detail.id, error: true });
    expect(textOf(byId(root, 'health-attempts')!)).toContain(
      'The attempt rows could not be loaded. Nothing was changed.',
    );
  });
});
