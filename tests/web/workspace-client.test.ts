import { describe, expect, it } from 'vitest';

import {
  HealthReportSchema,
  OverviewSchema,
  SessionInfoSchema,
  VideoDetailSchema,
} from '../../contract/api.js';
import { FIXTURES, SSE_FIXTURE } from '../../contract/mock/fixtures.js';
import {
  initWorkspace,
  type EventSourceLike,
  type WorkspaceEnvironment,
} from '../../src/web/client/workspace.js';
import { renderOverview } from '../../src/web/render/overview.js';
import { renderShell, buildShellModel } from '../../src/web/render/shell.js';
import { renderWorkspace } from '../../src/web/render/workspace.js';
import type { VideoDetail } from '../../src/web/workspace/model.js';
import { FakeDocument } from './helpers/fake-dom.js';

/**
 * F-04 signal — "stage rail reflects live state from SSE within 5 s".
 *
 * The enhancer is driven against the *real* server-rendered page (parsed into
 * the small fake DOM, since no DOM package is installable here) and a fake
 * EventSource. One delivered frame must change the rail in the same tick — no
 * reload, no refetch — which is what "within 5 s" means once the transport has
 * delivered (AX-27).
 */

const NOW = Date.parse('2026-10-20T09:41:30.000Z');
const overview = OverviewSchema.parse(FIXTURES['overview.get']);
const health = HealthReportSchema.parse(FIXTURES['health.report']);
const session = SessionInfoSchema.parse(FIXTURES['auth.session']);
const BASE = VideoDetailSchema.parse(FIXTURES['video.get']);

class FakeSource implements EventSourceLike {
  readonly listeners = new Map<string, Array<(event: { data?: string }) => void>>();
  closed = false;

  addEventListener(type: string, handler: (event: { data?: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const handler of this.listeners.get(type) ?? []) handler({ data });
  }

  emitRaw(type: string, data: string): void {
    for (const handler of this.listeners.get(type) ?? []) handler({ data });
  }
}

function workspacePage(detail: VideoDetail): string {
  const parts = renderWorkspace(detail, 'script');
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

function setup(detail: VideoDetail = BASE): {
  doc: FakeDocument;
  source: FakeSource;
  enhancer: NonNullable<ReturnType<typeof initWorkspace>>;
} {
  const doc = new FakeDocument();
  doc.addRoot(workspacePage(detail));
  const source = new FakeSource();
  const env: WorkspaceEnvironment = {
    now: () => NOW,
    openEvents: () => source,
    setInterval: () => 0,
    navigate: () => undefined,
  };
  const enhancer = initWorkspace(doc, env);
  if (enhancer === null) throw new Error('enhancer did not initialise');
  return { doc, source, enhancer };
}

const stageNode = (doc: FakeDocument, code: string) =>
  doc.querySelector('[data-stage="' + code + '"]');

const stageWord = (doc: FakeDocument, code: string) =>
  stageNode(doc, code)?.querySelector('[data-state-word]')?.textContent ?? '';

describe('the rail is wired to the contract SSE feed', () => {
  it('subscribes to every event type in the contract, plus the default message', () => {
    const { source } = setup();
    for (const type of [
      'stage.updated',
      'video.updated',
      'batch.progress',
      'health.changed',
      'ping',
      'message',
      'open',
    ]) {
      expect(source.listeners.has(type), type).toBe(true);
    }
  });

  it('reflects a stage change in place, without a reload (the F-04 signal)', () => {
    const { doc, source } = setup();
    const before = stageNode(doc, 'NA');
    expect(before?.getAttribute('data-state')).toBe('done');

    source.emit('stage.updated', {
      type: 'stage.updated',
      video_id: BASE.id,
      stage: 'NA',
      state: 'running',
      stale: false,
      occurred_at: '2026-10-20T09:41:29.000Z',
    });

    const after = stageNode(doc, 'NA');
    expect(after?.getAttribute('data-state')).toBe('running');
    expect(stageWord(doc, 'NA')).toBe('RUNNING');
    expect(after?.querySelector('[data-glyph]')?.innerHTML).toContain('svg');
    expect(after?.querySelector('[data-progress]')?.hidden).toBe(false);

    source.emit('stage.updated', {
      type: 'stage.updated',
      video_id: BASE.id,
      stage: 'NA',
      state: 'done',
      stale: false,
      occurred_at: '2026-10-20T09:41:30.000Z',
    });
    expect(stageNode(doc, 'NA')?.getAttribute('data-state')).toBe('done');
    expect(stageNode(doc, 'NA')?.querySelector('[data-progress]')?.hidden).toBe(true);
  });

  it('shows a stale stage as STALE even when its stored state is done (DI-05)', () => {
    const { doc, source } = setup();
    source.emit('stage.updated', {
      type: 'stage.updated',
      video_id: BASE.id,
      stage: 'TC',
      state: 'done',
      stale: true,
      occurred_at: '2026-10-20T09:41:30.000Z',
    });
    expect(stageNode(doc, 'TC')?.getAttribute('data-state')).toBe('stale');
    expect(stageWord(doc, 'TC')).toBe('STALE');
  });

  it('reveals the ribbon when three consecutive stages go stale', () => {
    const { doc, source } = setup();
    const ribbon = doc.querySelector('[data-stale-ribbon]');
    expect(ribbon?.hidden).toBe(true);
    for (const stage of ['NA', 'TC', 'RE']) {
      source.emit('stage.updated', {
        type: 'stage.updated',
        video_id: BASE.id,
        stage,
        state: 'done',
        stale: true,
        occurred_at: '2026-10-20T09:41:30.000Z',
      });
    }
    expect(ribbon?.hidden).toBe(false);
    const list = doc.querySelector('[data-ribbon-list]');
    expect(list?.innerHTML).toContain('NA');
    expect(list?.innerHTML).toContain('TC');
    expect(list?.innerHTML).toContain('RE');
    expect(doc.querySelector('[data-stale-summary]')?.textContent).toBe('stale: NA, TC, RE');
  });

  it('moves the header chip and the current-stage pointer on video.updated', () => {
    const { doc, source } = setup();
    source.emit('video.updated', {
      type: 'video.updated',
      video_id: BASE.id,
      status: 'NEEDS_ATTENTION',
      current_stage: 'NA',
      attention_kind: 'failed',
      attention_reason: 'failed: NA',
      occurred_at: '2026-10-20T09:41:31.000Z',
    });
    expect(doc.querySelector('#video-chip')?.getAttribute('data-state')).toBe('failed');
    expect(doc.querySelector('#video-chip .vchip-label')?.textContent).toBe('Failed');
    expect(doc.querySelector('[data-video-reason]')?.textContent).toBe('failed: NA');
    expect(stageNode(doc, 'NA')?.getAttribute('data-current')).toBe('true');
    expect(stageNode(doc, 'FA')?.getAttribute('data-current')).toBe('false');
    expect(doc.querySelector('[data-stage="NA"] a')?.getAttribute('aria-current')).toBe('step');
    expect(doc.querySelector('[data-stage="FA"] a')?.getAttribute('aria-current')).toBeNull();
  });

  it('stamps the freshness label on every frame so the ticker stays honest (AX-27)', () => {
    const { doc, source } = setup();
    const freshness = doc.querySelector('[data-updated-at]');
    expect(freshness?.getAttribute('data-updated-at')).not.toBe(String(NOW));
    source.emit('ping', { type: 'ping', occurred_at: '2026-10-20T09:41:30.000Z' });
    expect(freshness?.getAttribute('data-updated-at')).toBe(String(NOW));
    expect(freshness?.getAttribute('data-stale')).toBe('false');
  });

  it('drops a malformed frame without touching the page (fail closed)', () => {
    const { doc, source, enhancer } = setup();
    const before = JSON.stringify(enhancer.state());
    source.emitRaw('stage.updated', '{"type":"stage.updated","stage":"IM"}');
    source.emitRaw('stage.updated', 'not json');
    source.emitRaw('stage.updated', JSON.stringify({ type: 'stage.exploded' }));
    expect(JSON.stringify(enhancer.state())).toBe(before);
    expect(stageNode(doc, 'IM')?.getAttribute('data-state')).toBe('done');
  });

  it('ignores another video’s stage event but still proves the feed alive', () => {
    const { doc, source } = setup();
    source.emit('stage.updated', {
      type: 'stage.updated',
      video_id: '22222222-2222-4222-8222-222222222222',
      stage: 'IM',
      state: 'failed',
      stale: false,
      occurred_at: '2026-10-20T09:41:30.000Z',
    });
    expect(stageNode(doc, 'IM')?.getAttribute('data-state')).toBe('done');
    expect(doc.querySelector('[data-updated-at]')?.getAttribute('data-updated-at')).toBe(
      String(NOW),
    );
  });

  it('accepts every fixture frame the contract mock replays', () => {
    const { doc, source } = setup();
    for (const event of SSE_FIXTURE) {
      source.emit(event.type, event);
    }
    // The fixture replay ends with RE done and the video at the FA gate.
    expect(stageNode(doc, 'RE')?.getAttribute('data-state')).toBe('done');
    expect(doc.querySelector('#video-chip')?.getAttribute('data-state')).toBe('awaiting_approval');
  });

  it('announces one polite sentence per change (AX-07)', () => {
    const { doc, source } = setup();
    source.emit('stage.updated', {
      type: 'stage.updated',
      video_id: BASE.id,
      stage: 'IM',
      state: 'done',
      stale: false,
      occurred_at: '2026-10-20T09:41:30.000Z',
    });
    expect(doc.querySelector('#live-status')?.textContent).toBe('Images: done.');
  });
});

describe('overview queue keeps up with the feed', () => {
  function overviewDoc(): FakeDocument {
    const doc = new FakeDocument();
    doc.addRoot(
      renderShell(
        buildShellModel({
          title: 'Overview',
          nav: 'overview',
          overview,
          health,
          session,
          now: NOW,
          content: renderOverview({ state: 'ready', overview, now: NOW }),
          assets: {
            scriptHref: '/assets/client/shell.js',
            extraScripts: ['/assets/client/workspace.js'],
          },
        }),
      ),
    );
    return doc;
  }

  it('removes a row that stops needing attention and decrements the badge', () => {
    const doc = overviewDoc();
    const source = new FakeSource();
    const enhancer = initWorkspace(doc, { now: () => NOW, openEvents: () => source });
    expect(enhancer).not.toBeNull();
    const row = doc.querySelector('[data-attention-row="' + BASE.id + '"]');
    expect(row).not.toBeNull();
    const before = Number(
      doc.querySelector('[data-attention-count] [data-count-value]')?.textContent,
    );
    source.emit('video.updated', {
      type: 'video.updated',
      video_id: BASE.id,
      status: 'RUNNING',
      current_stage: 'EX',
      attention_kind: 'none',
      attention_reason: null,
      occurred_at: '2026-10-20T09:41:30.000Z',
    });
    expect(doc.querySelector('[data-attention-row="' + BASE.id + '"]')).toBeNull();
    expect(
      Number(doc.querySelector('[data-attention-count] [data-count-value]')?.textContent),
    ).toBe(before - 1);
  });

  it('updates a row that is still waiting, in place', () => {
    const doc = overviewDoc();
    const source = new FakeSource();
    initWorkspace(doc, { now: () => NOW, openEvents: () => source });
    source.emit('video.updated', {
      type: 'video.updated',
      video_id: BASE.id,
      status: 'NEEDS_ATTENTION',
      current_stage: 'SC',
      attention_kind: 'approval',
      attention_reason: 'script approval',
      occurred_at: '2026-10-20T09:41:30.000Z',
    });
    const row = doc.querySelector('[data-attention-row="' + BASE.id + '"]');
    expect(row?.getAttribute('data-stage')).toBe('SC');
    expect(row?.querySelector('[data-attention-reason]')?.textContent).toBe('script approval');
  });

  it('updates a batch counter from batch.progress', () => {
    const doc = overviewDoc();
    const source = new FakeSource();
    initWorkspace(doc, { now: () => NOW, openEvents: () => source });
    const batch = overview.batches[0];
    if (batch === undefined) throw new Error('fixture has no batch');
    source.emit('batch.progress', {
      type: 'batch.progress',
      batch_id: batch.id,
      completed_count: 5,
      target_count: batch.target_count,
      status: 'ACTIVE',
      occurred_at: '2026-10-20T09:41:30.000Z',
    });
    expect(doc.querySelector('[data-batch-progress="' + batch.id + '"]')?.textContent).toBe(
      '5 of ' + batch.target_count + ' complete',
    );
  });

  it('names a new attention item as a refresh hint rather than inventing a row', () => {
    const doc = overviewDoc();
    const source = new FakeSource();
    initWorkspace(doc, { now: () => NOW, openEvents: () => source });
    source.emit('video.updated', {
      type: 'video.updated',
      video_id: '22222222-2222-4222-8222-999999999999',
      status: 'NEEDS_ATTENTION',
      current_stage: 'SC',
      attention_kind: 'approval',
      attention_reason: 'script approval',
      occurred_at: '2026-10-20T09:41:30.000Z',
    });
    const note = doc.querySelector('[data-overview-new]');
    expect(note?.hidden).toBe(false);
    expect(note?.textContent).toContain('refresh');
  });
});

describe('keyboard model (UC-03, UC-02, IP-03)', () => {
  it('moves focus along the rail with the arrow keys and keeps one tab stop', () => {
    const { doc } = setup();
    const first = doc.querySelector('[data-stage="T"] a');
    if (first === null) throw new Error('no rail link');
    first.focus();
    doc.press('ArrowRight', first);
    expect(doc.activeElement?.getAttribute('aria-label')).toContain('Research');
    expect(doc.querySelector('[data-stage="RS"] a')?.getAttribute('tabindex')).toBe('0');
    expect(doc.querySelector('[data-stage="T"] a')?.getAttribute('tabindex')).toBe('-1');
    doc.press('End', doc.activeElement);
    expect(doc.activeElement?.getAttribute('aria-label')).toContain('Export');
  });

  it('jumps to the script, image and final stages with g + s/i/f', () => {
    const doc = new FakeDocument();
    doc.addRoot(workspacePage(BASE));
    const source = new FakeSource();
    const navigated: string[] = [];
    initWorkspace(doc, {
      now: () => NOW,
      openEvents: () => source,
      navigate: (href) => navigated.push(href),
    });
    doc.press('g');
    doc.press('s');
    doc.press('g');
    doc.press('i');
    doc.press('g');
    doc.press('f');
    expect(navigated).toEqual([
      '/videos/' + BASE.id + '/script',
      '/videos/' + BASE.id + '/scenes',
      '/videos/' + BASE.id + '/render',
    ]);
  });

  it('stays inert while a text field has focus (AX-03)', () => {
    const doc = new FakeDocument();
    doc.addRoot(workspacePage(BASE));
    const source = new FakeSource();
    const navigated: string[] = [];
    initWorkspace(doc, {
      now: () => NOW,
      openEvents: () => source,
      navigate: (href) => navigated.push(href),
    });
    const input = doc.querySelector('[data-stage="T"] a');
    if (input === null) throw new Error('no link');
    doc.activeElement = { ...input, tagName: 'INPUT' } as unknown as typeof input;
    doc.press('g');
    doc.press('s');
    expect(navigated).toHaveLength(0);
  });
});
