import { describe, expect, it } from 'vitest';

import { NarrationViewSchema, VideoDetailSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import {
  initNarration,
  type NarrationDocument,
  type NarrationElement,
  type NarrationEvent,
} from '../../src/web/client/narration.js';
import { renderNarrationPanel } from '../../src/web/render/narration.js';
import type { NarrationView } from '../../src/web/narration/model.js';
import type { VideoDetail } from '../../src/web/workspace/model.js';
import { byId, byTag, parseHtml, type HtmlNode } from './helpers/html.js';

/**
 * S-14 progressive enhancement, driven against the markup the renderer really
 * emits (no jsdom in this repo). Proves the enhancer's whole contract:
 *   - it follows the audio with the derived word rows;
 *   - a row click seeks and never starts playback (AX-16);
 *   - the transport readout is `mm:ss.s` (UI_SPEC §9.6);
 *   - it does nothing on a surface with no player.
 */

const detail: VideoDetail = VideoDetailSchema.parse(FIXTURES['video.get']);
const fixture: NarrationView = NarrationViewSchema.parse(FIXTURES['audio.get']);

class StubElement implements NarrationElement {
  textContent: string;
  currentTime?: number;
  paused = true;
  playCalls = 0;
  private readonly attributes: Record<string, string>;
  private readonly listeners = new Map<string, Array<(event: NarrationEvent) => void>>();

  constructor(attrs: Readonly<Record<string, string>> = {}, text = '') {
    this.attributes = { ...attrs };
    this.textContent = text;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  removeAttribute(name: string): void {
    delete this.attributes[name];
  }

  addEventListener(type: string, handler: (event: NarrationEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  emit(type: string): void {
    for (const handler of this.listeners.get(type) ?? []) handler({ target: this });
  }

  play(): void {
    this.playCalls += 1;
    this.paused = false;
  }
}

interface Harness {
  readonly doc: NarrationDocument;
  readonly audio: StubElement;
  readonly position: StubElement;
  readonly rows: readonly StubElement[];
}

function harness(input: { withPanel?: boolean; withAudio?: boolean } = {}): Harness {
  const html =
    input.withPanel === false
      ? '<main><p>Nothing here</p></main>'
      : renderNarrationPanel({
          detail,
          narration: fixture,
          alignmentId: null,
          acceptWired: false,
        });
  const page = parseHtml(html);
  const panel = byId(page, 'narration');
  const audioNode = input.withAudio === false ? undefined : byId(page, 'narration-audio');
  const positionNode =
    byId(page, 'narration-position') ??
    byTag(page, 'span').find((node) => node.attrs['data-narration-position'] !== undefined);
  const table = byTag(page, 'table').find(
    (node) => node.attrs['data-narration-words'] !== undefined,
  );
  const rowNodes =
    table === undefined
      ? []
      : byTag(table, 'tr').filter((node) => node.attrs['data-word-index'] !== undefined);

  const audio = new StubElement(audioNode?.attrs ?? {});
  const position = new StubElement(
    positionNode?.attrs ?? {},
    positionNode === undefined ? '' : textOfNode(positionNode),
  );
  const rows = rowNodes.map((node) => {
    const wordCell = byTag(node, 'th').find((cell) => cell.attrs['scope'] === 'row');
    const cell = byTag(node, 'td')[0];
    return new StubElement(
      node.attrs,
      (wordCell === undefined ? '' : textOfNode(wordCell)) + (cell === undefined ? '' : ''),
    );
  });

  const doc: NarrationDocument = {
    querySelector(selector: string): NarrationElement | null {
      if (selector === '[data-narration]')
        return panel === undefined ? null : new StubElement(panel.attrs);
      if (selector === '#narration-audio') return audioNode === undefined ? null : audio;
      if (selector === '[data-narration-position]') return position;
      return null;
    },
    querySelectorAll(selector: string): ArrayLike<NarrationElement> {
      if (selector === '[data-narration-words] tr[data-word-index]') return rows;
      return [];
    },
  };

  return { doc, audio, position, rows };
}

function textOfNode(node: HtmlNode): string {
  const own = node.type === 'text' ? node.text : '';
  return own + node.children.map((child) => textOfNode(child)).join('');
}

describe('S-14 enhancer', () => {
  it('does nothing on a page without the panel or without a player', () => {
    expect(initNarration(harness({ withPanel: false }).doc)).toBeNull();
    expect(initNarration(harness({ withAudio: false }).doc)).toBeNull();
  });

  it('starts at the first word and the 00:00.0 transport readout', () => {
    const { audio, position, doc } = harness();
    audio.currentTime = 0;
    const controller = initNarration(doc);
    expect(controller).not.toBeNull();
    expect(position.textContent).toBe('00:00.0');
    expect(controller?.activeIndex()).toBe(0);
  });

  it('follows the audio and marks exactly one row', () => {
    const { audio, position, rows, doc } = harness();
    audio.currentTime = 0;
    const controller = initNarration(doc);
    expect(controller).not.toBeNull();

    audio.currentTime = 0.6;
    audio.emit('timeupdate');
    expect(controller?.activeIndex()).toBe(3);
    expect(position.textContent).toBe('00:00.6');
    expect(rows.map((row) => row.getAttribute('data-active'))).toEqual([null, null, null, 'true']);
    expect(rows[3]?.getAttribute('aria-current')).toBe('true');
    expect(rows[0]?.getAttribute('aria-current')).toBeNull();

    audio.currentTime = 0.22;
    audio.emit('seeked');
    expect(controller?.activeIndex()).toBe(1);
    expect(rows.slice(0, 3).map((row) => row.getAttribute('aria-current'))).toEqual([
      null,
      'true',
      null,
    ]);
    expect(rows[3]?.getAttribute('aria-current')).toBeNull();
  });

  it('seeks on a row click without starting playback (AX-16)', () => {
    const { audio, position, rows, doc } = harness();
    audio.currentTime = 0;
    initNarration(doc);
    expect(audio.playCalls).toBe(0);

    rows[2]?.emit('click');
    expect(audio.currentTime).toBeCloseTo(0.38, 5);
    expect(position.textContent).toBe('00:00.3');
    expect(audio.paused).toBe(true);
    expect(audio.playCalls).toBe(0);

    rows[3]?.emit('click');
    expect(audio.currentTime).toBeCloseTo(0.52, 5);
    expect(position.textContent).toBe('00:00.5');
  });

  it('keeps the player non-autoplaying and metadata-only', () => {
    const { audio, doc } = harness();
    initNarration(doc);
    expect(audio.getAttribute('autoplay')).toBeNull();
    expect(audio.getAttribute('preload')).toBe('metadata');
    expect(audio.paused).toBe(true);
    expect(audio.playCalls).toBe(0);
  });

  it('exposes a seek that clamps at zero', () => {
    const { audio, position, doc } = harness();
    const controller = initNarration(doc);
    controller?.seek(-500);
    expect(audio.currentTime).toBe(0);
    expect(position.textContent).toBe('00:00.0');
    expect(controller?.position()).toBe('00:00.0');
  });
});
