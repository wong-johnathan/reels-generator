import { describe, expect, it } from 'vitest';

import {
  HealthReportSchema,
  InvalidationPreviewSchema,
  OverviewSchema,
  ScriptViewSchema,
  SessionInfoSchema,
  VideoDetailSchema,
} from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import {
  createHttpScriptApi,
  initScriptReview,
  type ApproveResult,
  type LoadResult,
  type PreviewResult,
  type SaveResult,
  type ScriptApi,
} from '../../src/web/client/scriptReview.js';
import { renderScriptReview } from '../../src/web/render/scriptReview.js';
import { renderShell, buildShellModel } from '../../src/web/render/shell.js';
import { renderWorkspace } from '../../src/web/render/workspace.js';
import type { VideoDetail } from '../../src/web/workspace/model.js';
import { FakeDocument } from './helpers/fake-dom.js';

/**
 * F-05 signal — "approving the script unlocks image+TTS; the impact panel
 * shows invalidated stages + call counts before any edit".
 *
 * The enhancer is driven against the real server-rendered page through the
 * small fake DOM, with a fake `ScriptApi`. No fetch, no socket, no provider.
 */

const NOW = Date.parse('2026-10-20T09:41:30.000Z');
const overview = OverviewSchema.parse(FIXTURES['overview.get']);
const health = HealthReportSchema.parse(FIXTURES['health.report']);
const session = SessionInfoSchema.parse(FIXTURES['auth.session']);
const BASE = VideoDetailSchema.parse(FIXTURES['video.get']);
const APPROVED = ScriptViewSchema.parse(FIXTURES['script.get']);
const PREVIEW = InvalidationPreviewSchema.parse({
  ...(FIXTURES['video.invalidation_preview'] as Record<string, unknown>),
  revision: 5,
});

const DRAFT = ScriptViewSchema.parse({
  ...APPROVED,
  revision: 5,
  status: 'draft',
  approved_at: null,
  claims: [APPROVED.claims[0]],
});

const T1 = '2026-10-20T09:41:12.000Z';

function withStages(
  detail: VideoDetail,
  patch: (stage: VideoDetail['stages'][number]) => VideoDetail['stages'][number],
): VideoDetail {
  return VideoDetailSchema.parse({ ...detail, stages: detail.stages.map(patch) });
}

const BLOCKED_GATE = withStages(BASE, (stage) =>
  stage.stage === 'IM' || stage.stage === 'NA'
    ? { ...stage, state: 'blocked', blocked_reason: 'script not approved (R-005-2)' }
    : stage,
);

const UNLOCKED = withStages(BLOCKED_GATE, (stage) =>
  stage.stage === 'IM' || stage.stage === 'NA'
    ? { ...stage, state: 'not_run', blocked_reason: null, progress: { current: 0, total: 0 } }
    : stage,
);

const STALE = withStages(BLOCKED_GATE, (stage) =>
  ['SB', 'NA', 'TC', 'RE'].includes(stage.stage)
    ? { ...stage, stale: true, stale_cause: 'script rev 5' }
    : stage,
);

class FakeApi implements ScriptApi {
  readonly calls: Array<{ name: string; args: readonly unknown[] }> = [];
  previewResults: PreviewResult[] = [{ kind: 'ok', preview: PREVIEW }];
  saveResults: SaveResult[] = [
    { kind: 'ok', script: ScriptViewSchema.parse({ ...APPROVED, revision: 6, status: 'draft' }) },
  ];
  approveResults: ApproveResult[] = [
    {
      kind: 'ok',
      script: ScriptViewSchema.parse({ ...DRAFT, status: 'approved', approved_at: T1 }),
    },
  ];
  loadResults: LoadResult[] = [{ kind: 'ok', script: DRAFT }];
  videoResults: Array<VideoDetail | null> = [STALE];
  rerunResults: Array<{ kind: 'ok' } | { kind: 'failed' }> = [{ kind: 'ok' }];
  reloads = 0;

  private next<T>(queue: T[]): T {
    if (queue.length === 0) throw new Error('fake api queue is empty');
    return queue.length > 1 ? (queue.shift() as T) : (queue[0] as T);
  }

  async preview(...args: unknown[]): Promise<PreviewResult> {
    this.calls.push({ name: 'preview', args });
    return this.next(this.previewResults);
  }

  async save(...args: unknown[]): Promise<SaveResult> {
    this.calls.push({ name: 'save', args });
    return this.next(this.saveResults);
  }

  async approve(...args: unknown[]): Promise<ApproveResult> {
    this.calls.push({ name: 'approve', args });
    return this.next(this.approveResults);
  }

  async load(...args: unknown[]): Promise<LoadResult> {
    this.calls.push({ name: 'load', args });
    return this.next(this.loadResults);
  }

  async video(...args: unknown[]): Promise<VideoDetail | null> {
    this.calls.push({ name: 'video', args });
    return this.next(this.videoResults);
  }

  async rerun(...args: unknown[]): Promise<{ kind: 'ok' } | { kind: 'failed' }> {
    this.calls.push({ name: 'rerun', args });
    return this.next(this.rerunResults);
  }

  named(name: string): Array<{ name: string; args: readonly unknown[] }> {
    return this.calls.filter((call) => call.name === name);
  }
}

function page(detail: VideoDetail, script = DRAFT): string {
  const parts = renderWorkspace(detail, 'script', {
    panel: renderScriptReview({ detail, script }),
  });
  return renderShell(
    buildShellModel({
      title: detail.series_name,
      nav: null,
      overview,
      health,
      session,
      now: NOW,
      content: parts.content,
      titleAside: parts.titleAside,
      footer: parts.footer,
      assets: { scriptHref: '/assets/client/shell.js', extraScripts: parts.scripts },
    }),
  );
}

interface Setup {
  readonly doc: FakeDocument;
  readonly api: FakeApi;
  readonly enhancer: NonNullable<ReturnType<typeof initScriptReview>>;
  readonly scheduled: Array<() => void>;
}

function setup(detail: VideoDetail = BLOCKED_GATE, script = DRAFT): Setup {
  const doc = new FakeDocument();
  doc.addRoot(page(detail, script));
  const api = new FakeApi();
  const scheduled: Array<() => void> = [];
  const enhancer = initScriptReview(doc, {
    api,
    schedule: (run) => scheduled.push(run),
    reload: () => {
      api.reloads += 1;
    },
  });
  if (enhancer === null) throw new Error('enhancer did not initialise');
  return { doc, api, enhancer, scheduled };
}

function type(doc: FakeDocument, field: string, value: string): void {
  const element = doc.querySelector('#script-' + field);
  if (element === null) throw new Error('no field ' + field);
  element.value = value;
}

function text(doc: FakeDocument, selector: string): string {
  return doc.querySelector(selector)?.textContent ?? '';
}

function attr(doc: FakeDocument, selector: string, name: string): string | undefined {
  return doc.querySelector(selector)?.getAttribute(name) ?? undefined;
}

describe('IP-01 preview — the server computes, the panel states', () => {
  it('marks the revision unsaved and disables both commits while computing', async () => {
    const { doc, enhancer, scheduled, api } = setup();
    expect(attr(doc, '[data-script-dirty]', 'hidden')).toBeDefined();

    type(doc, 'narration', DRAFT.content.narration + ' One more sentence.');
    enhancer.edit();

    expect(attr(doc, '[data-script-dirty]', 'hidden')).toBeUndefined();
    expect(text(doc, '[data-impact-chip]')).toBe('computing');
    expect(text(doc, '[data-impact-message]')).toBe('computing impact');
    expect(attr(doc, '[data-commit="edit"]', 'disabled')).toBeDefined();
    expect(attr(doc, '[data-commit="regenerate"]', 'disabled')).toBeDefined();
    expect(scheduled).toHaveLength(1);
    expect(api.named('preview')).toHaveLength(0);
  });

  it('sends the edited content and renders the invalidated stages and call counts', async () => {
    const { doc, enhancer, api } = setup();
    type(doc, 'narration', DRAFT.content.narration + ' One more sentence.');
    enhancer.edit();
    await enhancer.preview();

    const [call] = api.named('preview');
    expect(call?.args[0]).toBe(BASE.id);
    const body = call?.args[1] as {
      revision: number;
      edits: Array<{ edit_kind: string }>;
      script_content: { narration: string; hashtags: string[] };
    };
    expect(body.revision).toBe(5);
    expect(body.edits).toEqual([{ edit_kind: 'script_wording' }]);
    expect(body.script_content.narration).toContain('One more sentence.');
    expect(body.script_content.hashtags).toEqual(['#psychology', '#founders', '#focus']);

    expect(text(doc, '[data-impact-chip]')).toBe('4 stale');
    expect(text(doc, '[data-impact-changes]')).toBe('Script rev 5 → rev 6 · wording only');
    const stale = doc.querySelectorAll('[data-impact-stale-stage]');
    expect(Array.from(stale).map((row) => row.getAttribute?.('data-impact-stale-stage'))).toEqual([
      'SB',
      'NA',
      'TC',
      'RE',
    ]);
    expect(text(doc, '[data-impact-stale]')).toContain('(17)');
    expect(text(doc, '[data-impact-calls]')).toContain('image calls: 0');
    expect(text(doc, '[data-impact-calls]')).toContain('TTS calls: 1');
    expect(attr(doc, '[data-commit="edit"]', 'disabled')).toBeUndefined();
    expect(attr(doc, '[data-commit="regenerate"]', 'disabled')).toBeUndefined();
    expect(doc.querySelector('[data-impact-detail]')?.hidden).toBe(false);
  });

  it('collapses to the empty line again when the text returns to the saved revision', async () => {
    const { doc, enhancer } = setup();
    type(doc, 'narration', DRAFT.content.narration + ' Extra.');
    enhancer.edit();
    await enhancer.preview();
    type(doc, 'narration', DRAFT.content.narration);
    enhancer.edit();

    expect(attr(doc, '[data-script-dirty]', 'hidden')).toBeDefined();
    expect(text(doc, '[data-impact-message]')).toBe('No unsaved changes');
    expect(attr(doc, '[data-commit="edit"]', 'disabled')).toBeDefined();
  });

  it('states a failed preview in C-07 words, blocks both commits and offers Retry', async () => {
    const { doc, enhancer, api } = setup();
    api.previewResults = [{ kind: 'failed' }];
    type(doc, 'hook', 'A different hook.');
    enhancer.edit();
    await enhancer.preview();

    expect(text(doc, '[data-impact-message]')).toContain(
      'The impact of this change could not be computed, so regeneration is blocked.',
    );
    expect(attr(doc, '[data-commit="edit"]', 'disabled')).toBeDefined();
    expect(attr(doc, '[data-commit="regenerate"]', 'disabled')).toBeDefined();
    expect(attr(doc, '[data-impact-retry]', 'hidden')).toBeUndefined();
  });
});

describe('the two commits (IP-01, AX-04)', () => {
  it('applies the edit without regeneration, then paints the stale rail and ribbon', async () => {
    const { doc, enhancer, api } = setup();
    type(doc, 'narration', DRAFT.content.narration + ' Extra.');
    enhancer.edit();
    await enhancer.preview();
    await enhancer.apply('edit');

    const saves = api.named('save');
    expect(saves).toHaveLength(1);
    expect((saves[0]?.args[1] as { revision: number }).revision).toBe(5);
    expect(api.named('rerun')).toHaveLength(0);
    expect(api.reloads).toBe(1);
    expect(text(doc, '#script-rev-number')).toBe('Script rev 6');
    expect(attr(doc, '[data-script-dirty]', 'hidden')).toBeDefined();
    expect(attr(doc, '[data-stage="NA"]', 'data-state')).toBe('stale');
    expect(attr(doc, '[data-stage="SB"]', 'data-state')).toBe('stale');
    expect(attr(doc, '[data-stale-ribbon]', 'hidden')).toBeUndefined();
    expect(text(doc, '#live-status')).toContain('Script rev 6 saved.');
    expect(text(doc, '#live-status')).toContain('stale');
    expect(text(doc, '[data-impact-message]')).toBe('No unsaved changes');
  });

  it('applies and regenerates at the first invalidated stage only', async () => {
    const { doc, enhancer, api } = setup();
    type(doc, 'narration', DRAFT.content.narration + ' Extra.');
    enhancer.edit();
    await enhancer.preview();
    api.reloads = 0;
    await enhancer.apply('regenerate');

    expect(api.named('save')).toHaveLength(1);
    const reruns = api.named('rerun');
    expect(reruns).toHaveLength(1);
    expect(reruns[0]?.args.slice(0, 3)).toEqual([BASE.id, 'SB', { confirm_scope: true }]);
    expect(text(doc, '#live-status')).toContain('Regeneration of SB is queued.');
    expect(api.reloads).toBe(1);
  });
});

describe('the approval gate (R-005-2, C-09)', () => {
  it('approves, swaps the control for the record line and unlocks image + narration', async () => {
    const { doc, enhancer, api } = setup();
    api.videoResults = [UNLOCKED];
    expect(attr(doc, '#script-approve', 'disabled')).toBeUndefined();

    await enhancer.approve();

    const approvals = api.named('approve');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.args[1]).toEqual({ revision: 5 });
    expect(attr(doc, '#script-approve', 'hidden')).toBeDefined();
    expect(attr(doc, '#script-approved-record', 'hidden')).toBeUndefined();
    expect(text(doc, '#script-approved-record')).toBe(
      'Approved rev 5 · operator · 2026-10-20T09:41:12Z',
    );
    expect(attr(doc, '[data-stage="IM"]', 'data-state')).toBe('not_run');
    expect(attr(doc, '[data-stage="NA"]', 'data-state')).toBe('not_run');
    expect(text(doc, '#live-status')).toContain('approved');
    expect(text(doc, '#live-status')).toContain('unlocked');
    expect(enhancer.state().approved).toBe(true);
  });

  it('never calls the server when the gate is closed', async () => {
    const blocked = ScriptViewSchema.parse({
      ...DRAFT,
      claims: [
        {
          ...DRAFT.claims[0],
          id: '22222222-2222-4222-8222-222222222222',
          status: 'unsourced',
          source: null,
        },
      ],
    });
    const { enhancer, api } = setup(BLOCKED_GATE, blocked);
    expect(api.named('approve')).toHaveLength(0);
    await enhancer.approve();
    expect(api.named('approve')).toHaveLength(0);
  });
});

describe('409 conflict (IP-09)', () => {
  it('keeps the typed text and names both revisions', async () => {
    const { doc, enhancer, api } = setup();
    api.saveResults = [{ kind: 'conflict', conflict: { current_revision: 6, your_revision: 5 } }];
    type(doc, 'hook', 'My unchanged hook.');
    enhancer.edit();
    await enhancer.preview();
    await enhancer.apply('edit');

    expect(attr(doc, '[data-conflict]', 'hidden')).toBeUndefined();
    expect(text(doc, '[data-conflict-text]')).toBe(
      'This script was saved by another tab (revision 6). Your revision 5 was not saved. Nothing was overwritten.',
    );
    expect(doc.querySelector('#script-hook')?.value).toBe('My unchanged hook.');
    expect(api.reloads).toBe(0);
  });
});

describe('the HTTP adapter', () => {
  it('posts the contract paths and maps a 409 to a conflict', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ current_revision: 6, your_revision: 5 }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const api = createHttpScriptApi(fetchImpl);
    const result = await api.save('vid 1', { revision: 5, content: DRAFT.content });
    expect(result.kind).toBe('conflict');
    expect(calls[0]?.url).toBe('/api/videos/vid%201/script');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ revision: 5 });
  });
});
