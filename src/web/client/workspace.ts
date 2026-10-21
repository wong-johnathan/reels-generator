/**
 * Progressive enhancement for the video workspace and the overview queue
 * (UX_SPEC IP-03/IP-05, AX-27; TECH_DESIGN X-2 — server-rendered HTML plus
 * enhancement, no SPA framework).
 *
 * Responsibilities, and nothing else:
 *   - subscribe to the contract's SSE feed (`/api/events`) and rewrite the
 *     stage rail, the header chip, the stale ribbon, the batch counters and
 *     the attention rows in place — the page never reloads to show a stage
 *     change (AX-27: within 5 s);
 *   - keep the freshness label honest by stamping `data-updated-at` on every
 *     frame, so the shell's 1 s ticker can say "last update 2 s ago" or
 *     "progress feed delayed";
 *   - announce one polite sentence per change through the shell's live region
 *     (AX-07/AX-10, never per row);
 *   - provide the keyboard model of UC-03/UC-02: one tab stop for the rail,
 *     arrow keys inside the rail and the tablist, and `g` + `s`/`i`/`f`.
 *
 * It never re-renders content, never moves focus, and never invents data: the
 * server renderer stays the source of truth for everything it does not touch.
 */
import { isTextField, LiveRegion, shouldAnnounce, type ActiveElementShape } from './behaviours.js';
import {
  applyFeedEvent,
  chipStateForEvent,
  emptyFeedState,
  eventAnnouncement,
  FEED_EVENT_TYPES,
  FEED_STATE_WORDS,
  initialFeedState,
  parseSseEvent,
  sentenceState,
  type FeedEvent,
  type FeedState,
  type StageSnapshot,
  type StageState,
} from '../workspace/events.js';
import { stateGlyph } from '../workspace/glyphs.js';
import { paintStages } from '../workspace/railDom.js';

export interface WsElement {
  textContent: string;
  innerHTML?: string;
  hidden?: boolean;
  getAttribute?(name: string): string | null;
  setAttribute?(name: string, value: string): void;
  removeAttribute?(name: string): void;
  querySelector?(selector: string): WsElement | null;
  querySelectorAll?(selector: string): ArrayLike<WsElement>;
  focus?(): void;
  remove?(): void;
}

export interface KeyboardEventLike {
  key: string;
  target?: WsElement | null;
  preventDefault?(): void;
}

export interface WsDocument {
  querySelector(selector: string): WsElement | null;
  querySelectorAll(selector: string): ArrayLike<WsElement>;
  readonly activeElement?: {
    readonly tagName?: string;
    readonly isContentEditable?: boolean;
  } | null;
  addEventListener?(type: string, handler: (event: KeyboardEventLike) => void): void;
}

export interface MessageEventLike {
  readonly data?: string;
}

export interface EventSourceLike {
  addEventListener(type: string, handler: (event: MessageEventLike) => void): void;
  close?(): void;
}

export interface WorkspaceEnvironment {
  now(): number;
  /** Injected so tests never open a socket. */
  openEvents?(url: string): EventSourceLike | null;
  setInterval?(handler: () => void, ms: number): unknown;
  navigate?(href: string): void;
  eventsUrl?: string;
}

export interface WorkspaceEnhancer {
  state(): FeedState;
  apply(event: FeedEvent): void;
  /** Reveal the ribbon from the current state (also used after an SSR-only render). */
  refresh(): void;
  close(): void;
}

function attr(element: WsElement, name: string): string | null {
  return element.getAttribute?.(name) ?? null;
}

function setAttr(element: WsElement, name: string, value: string): void {
  element.setAttribute?.(name, value);
}

function each(nodes: ArrayLike<WsElement>, visit: (node: WsElement, index: number) => void): void {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node !== undefined) visit(node, index);
  }
}

function toArray(nodes: ArrayLike<WsElement>): WsElement[] {
  const list: WsElement[] = [];
  each(nodes, (node) => list.push(node));
  return list;
}

function readStages(doc: WsDocument): Record<string, StageSnapshot> {
  const stages: Record<string, StageSnapshot> = {};
  each(doc.querySelectorAll('[data-stage]'), (node) => {
    const code = attr(node, 'data-stage');
    const state = attr(node, 'data-state');
    if (code === null || state === null) return;
    stages[code] = {
      state: state as StageState,
      stale: attr(node, 'data-stale') === 'true',
    };
  });
  return stages;
}

function readWorkspaceState(root: WsElement, doc: WsDocument): FeedState {
  const base = initialFeedState({
    status: attr(root, 'data-video-status') ?? '',
    current_stage: attr(root, 'data-current-stage') ?? '',
    attention_kind: attr(root, 'data-attention-kind') ?? '',
    attention_reason: attr(root, 'data-attention-reason') ?? null,
    stages: Object.entries(readStages(doc)).map(([stage, snapshot]) => ({
      stage,
      state: snapshot.state,
      stale: snapshot.stale,
    })),
  });
  return base;
}

function renderChip(doc: WsDocument, state: FeedState): void {
  const video = state.video;
  if (video === null) return;
  const stageState = state.stages[video.currentStage]?.state ?? 'not_run';
  const chipState = chipStateForEvent(video.status, video.attentionKind, stageState);
  const chip = doc.querySelector('#video-chip');
  if (chip !== null) {
    setAttr(chip, 'data-state', chipState);
    const label = chip.querySelector?.('.vchip-label');
    if (label !== null && label !== undefined) label.textContent = sentenceState(chipState);
    const glyph = chip.querySelector?.('[data-glyph]');
    if (glyph !== null && glyph !== undefined) glyph.innerHTML = stateGlyph(chipState);
  }
  const reason = doc.querySelector('[data-video-reason]');
  if (reason !== null) {
    const text =
      video.attentionKind === 'none' ? '' : (video.attentionReason ?? video.attentionKind);
    reason.textContent = text;
    reason.hidden = text.length === 0;
  }
  for (const node of toArray(doc.querySelectorAll('[data-stage]'))) {
    const current = attr(node, 'data-stage') === video.currentStage;
    setAttr(node, 'data-current', current ? 'true' : 'false');
    const link = node.querySelector?.('a');
    if (link === null || link === undefined) continue;
    if (current) setAttr(link, 'aria-current', 'step');
    else link.removeAttribute?.('aria-current');
  }
}

function renderCurrentStage(doc: WsDocument, stage: string): void {
  const nodes = toArray(doc.querySelectorAll('[data-stage]'));
  for (const node of nodes) {
    const current = attr(node, 'data-stage') === stage;
    setAttr(node, 'data-current', current ? 'true' : 'false');
    const link = node.querySelector?.('a');
    if (link === null || link === undefined) continue;
    if (current) setAttr(link, 'aria-current', 'step');
    else link.removeAttribute?.('aria-current');
  }
}

function readCount(element: WsElement | null): number {
  if (element === null) return 0;
  const inner = element.querySelector?.('[data-count-value]');
  const raw = inner?.textContent ?? element.textContent;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Updates the number, not the sentence around it (the strip says "N need attention"). */
function setCounts(doc: WsDocument, next: number): void {
  const value = String(Math.max(0, next));
  each(doc.querySelectorAll('[data-attention-count]'), (node) => {
    const inner = node.querySelector?.('[data-count-value]');
    if (inner !== null && inner !== undefined) inner.textContent = value;
    else node.textContent = value;
    const withValue = node.getAttribute?.('data-attention-count') ?? '';
    if (withValue.length > 0) setAttr(node, 'data-attention-count', value);
  });
}

/**
 * Overview rows are the only place a video's own label exists; the feed's
 * `video.updated` carries no label, so a brand-new attention item is announced
 * as a refresh hint instead of being invented into the list.
 */
function renderOverview(doc: WsDocument, event: FeedEvent, state: FeedState): void {
  if (event.type === 'video.updated') {
    const row = doc.querySelector('[data-attention-row="' + event.video_id + '"]');
    if (row !== null) {
      if (event.status !== 'NEEDS_ATTENTION') {
        row.remove?.();
        const counter = doc.querySelector('[data-attention-count]');
        setCounts(doc, readCount(counter) - 1);
        return;
      }
      setAttr(row, 'data-stage', event.current_stage);
      const snapshot = state.stages[event.current_stage];
      if (snapshot !== undefined) setAttr(row, 'data-stage-state', snapshot.state);
      const reason = row.querySelector?.('[data-attention-reason]');
      if (reason !== null && reason !== undefined) {
        reason.textContent = event.attention_reason ?? event.attention_kind;
      }
      const detail = row.querySelector?.('[data-attention-detail]');
      if (detail !== null && detail !== undefined) {
        detail.textContent = event.current_stage;
      }
      return;
    }
    if (event.status === 'NEEDS_ATTENTION') {
      const note = doc.querySelector('[data-overview-new]');
      if (note !== null) {
        note.hidden = false;
        note.textContent =
          'A video needs attention — refresh to see it in the queue. Nothing was changed.';
      }
    }
    return;
  }
  if (event.type === 'batch.progress') {
    const counter = doc.querySelector('[data-batch-progress="' + event.batch_id + '"]');
    if (counter !== null) {
      counter.textContent = event.completed_count + ' of ' + event.target_count + ' complete';
    }
  }
}

function bumpFreshness(doc: WsDocument, now: number): void {
  const node = doc.querySelector('[data-updated-at]');
  if (node === null) return;
  setAttr(node, 'data-updated-at', String(now));
  setAttr(node, 'data-stale', 'false');
}

export function initWorkspace(
  doc: WsDocument,
  env: WorkspaceEnvironment = { now: () => Date.now() },
): WorkspaceEnhancer | null {
  const root = doc.querySelector('[data-workspace]');
  const overview = doc.querySelector('[data-overview]');
  if (root === null && overview === null) return null;

  const statusNode = doc.querySelector('#live-status');
  const alertNode = doc.querySelector('#live-alert');
  const region =
    statusNode === null || alertNode === null
      ? null
      : new LiveRegion(statusNode, { debounceMs: 0, clearAfterMs: 10_000 });
  const alert = alertNode === null ? null : new LiveRegion(alertNode);

  const videoId = root === null ? null : attr(root, 'data-video-id');
  let state = root === null ? emptyFeedState() : readWorkspaceState(root, doc);

  function announce(message: string | null): void {
    if (message === null) return;
    const operator = false;
    if (!shouldAnnounce(doc.activeElement ?? null, operator)) return;
    if (region !== null) region.announce(message, env.now());
    else if (statusNode !== null) statusNode.textContent = message;
  }

  function apply(event: FeedEvent): void {
    const isThisVideo = videoId === null || !('video_id' in event) || event.video_id === videoId;
    if (!isThisVideo) {
      // Another video's event: only the feed is known to be alive.
      bumpFreshness(doc, env.now());
      return;
    }
    state = applyFeedEvent(state, event);
    if (event.type === 'stage.updated') {
      paintStages(doc, state.stages);
    } else if (event.type === 'video.updated') {
      renderCurrentStage(doc, event.current_stage);
      renderChip(doc, state);
    } else if (event.type === 'health.changed' && !event.ready && alert !== null) {
      alert.announce('Service degraded.', env.now(), { urgent: true });
    }
    renderOverview(doc, event, state);
    bumpFreshness(doc, env.now());
    announce(eventAnnouncement(event));
  }

  function receive(data: string | undefined): void {
    if (data === undefined) return;
    const event = parseSseEvent(data);
    if (event === null) return; // fail closed: an unknown frame changes nothing
    apply(event);
  }

  let source: EventSourceLike | null = null;
  if (env.openEvents !== undefined) {
    source = env.openEvents(env.eventsUrl ?? '/api/events');
    if (source !== null) {
      for (const type of FEED_EVENT_TYPES) {
        source.addEventListener(type, (event) => receive(event.data));
      }
      source.addEventListener('message', (event) => receive(event.data));
      source.addEventListener('open', () => bumpFreshness(doc, env.now()));
    }
  }

  function refresh(): void {
    if (root !== null) {
      paintStages(doc, state.stages);
      renderChip(doc, state);
    }
  }

  // ── Keyboard model (UC-03, UC-02, IP-03) ──────────────────────────────────
  function focusableLinks(selector: string): WsElement[] {
    return toArray(doc.querySelectorAll(selector));
  }

  function moveFocus(links: WsElement[], index: number): void {
    const target = links[index];
    if (target === undefined) return;
    for (const [position, link] of links.entries()) {
      setAttr(link, 'tabindex', position === index ? '0' : '-1');
    }
    target.focus?.();
  }

  function onKeydown(event: KeyboardEventLike): void {
    if (isTextField((doc.activeElement ?? null) as ActiveElementShape | null)) return;
    const active: WsElement | null =
      event.target ?? (doc.activeElement as WsElement | undefined) ?? null;

    if (event.key === 'g') {
      pendingG = true;
      event.preventDefault?.();
      return;
    }
    if (pendingG) {
      pendingG = false;
      const stage = STAGE_SHORTCUTS[event.key];
      if (stage !== undefined) {
        const node = doc.querySelector('[data-stage="' + stage + '"] a');
        const href = node === null ? null : attr(node, 'href');
        if (href !== null) {
          event.preventDefault?.();
          if (env.navigate !== undefined) env.navigate(href);
        }
      }
      return;
    }

    const railLinks = focusableLinks('[data-stage] a');
    const railIndex = active === null ? -1 : railLinks.indexOf(active);
    if (railIndex >= 0) {
      if (event.key === 'ArrowRight') {
        event.preventDefault?.();
        moveFocus(railLinks, (railIndex + 1) % railLinks.length);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault?.();
        moveFocus(railLinks, (railIndex - 1 + railLinks.length) % railLinks.length);
      } else if (event.key === 'Home') {
        event.preventDefault?.();
        moveFocus(railLinks, 0);
      } else if (event.key === 'End') {
        event.preventDefault?.();
        moveFocus(railLinks, railLinks.length - 1);
      }
      return;
    }

    const tabLinks = focusableLinks('[role="tab"]');
    const tabIndex = active === null ? -1 : tabLinks.indexOf(active);
    if (tabIndex >= 0) {
      if (event.key === 'ArrowRight') {
        event.preventDefault?.();
        moveFocus(tabLinks, (tabIndex + 1) % tabLinks.length);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault?.();
        moveFocus(tabLinks, (tabIndex - 1 + tabLinks.length) % tabLinks.length);
      } else if (event.key === 'Home') {
        event.preventDefault?.();
        moveFocus(tabLinks, 0);
      } else if (event.key === 'End') {
        event.preventDefault?.();
        moveFocus(tabLinks, tabLinks.length - 1);
      }
    }
  }

  let pendingG = false;
  doc.addEventListener?.('keydown', onKeydown);

  const enhancer: WorkspaceEnhancer = {
    state: () => state,
    apply,
    refresh,
    close: () => source?.close?.(),
  };

  (globalThis as { reelsWorkspace?: WorkspaceEnhancer; reelsAnnounce?: unknown }).reelsWorkspace =
    enhancer;

  if (env.setInterval !== undefined && region !== null) {
    env.setInterval(() => region.poll(env.now()), 1_000);
  }
  refresh();

  return enhancer;
}

/** IP-03's documented shortcuts; `g` then this letter jumps to that stage. */
const STAGE_SHORTCUTS: Readonly<Record<string, string>> = {
  s: 'SC',
  i: 'IM',
  f: 'FA',
};

/** `FEED_STATE_WORDS` is re-exported for tests that assert SSR/enhancer parity. */
export { FEED_STATE_WORDS };

const runtimeDocument = (globalThis as { document?: WsDocument }).document;
if (runtimeDocument !== undefined) {
  initWorkspace(runtimeDocument);
}
