import { describe, expect, it } from 'vitest';

import { StoryboardViewSchema, VideoDetailSchema } from '../../contract/api.js';
import { FIXTURES } from '../../contract/mock/fixtures.js';
import { initSceneGrid } from '../../src/web/client/sceneGrid.js';
import { renderSceneGrid } from '../../src/web/render/sceneGrid.js';
import type { StoryboardView } from '../../src/web/scenes/model.js';
import { FakeDocument, type FakeElement } from './helpers/fake-dom.js';

/**
 * S-12 keyboard behaviour (UI_SPEC §5 UC-07, §8.4 AX-02, UI_SPEC §6.7).
 *
 * The enhancer runs against the real server-rendered grid parsed into the fake
 * DOM: `j`/`k`/arrows move a roving tabindex (selection follows focus), `Enter`
 * is the browser's own link activation, `r` jumps to the replace scope, `Esc`
 * clears, and one live region announces the selection with the exact sentence
 * UI_SPEC specifies. Single-key shortcuts stay inert inside a text field
 * (AX-03/§8.5) — proven through the shared `isTextField` rule.
 */

const storyboard = StoryboardViewSchema.parse(FIXTURES['storyboard.get']);
const detail = VideoDetailSchema.parse(FIXTURES['video.get']);

const firstThree: StoryboardView = {
  ...storyboard,
  first_three_reviewed: false,
  approved: false,
  approved_at: null,
  scenes: storyboard.scenes.map((scene, index) =>
    index < 3
      ? { ...scene, state: 'done' as const }
      : { ...scene, asset: null, state: 'not_run' as const },
  ),
};

function setup(board: StoryboardView = firstThree, columns = 6) {
  const doc = new FakeDocument();
  doc.addRoot(
    '<html><body>' +
      renderSceneGrid({
        detail: detail as never,
        storyboard: board,
        release: { wired: true },
        columns,
      }) +
      '</body></html>',
  );
  const navigations: string[] = [];
  const enhancer = initSceneGrid(doc, { navigate: (href) => navigations.push(href) });
  const tiles = doc.querySelectorAll('[data-scene-tile]');
  return { doc, enhancer, tiles, navigations };
}

describe('selection (UC-07, AX-02)', () => {
  it('pages forward/back with one visible scene, exact readout, and focus retained', () => {
    const { doc } = setup();
    let click: ((event: { key: string; target?: FakeElement | null }) => void) | undefined;
    const listen = doc.addEventListener.bind(doc);
    doc.addEventListener = (type, handler) => {
      if (type === 'click') click = handler;
      else listen(type, handler);
    };
    initSceneGrid(doc);
    const next = doc.querySelector('[data-pager-step="1"]');
    const prev = doc.querySelector('[data-pager-step="-1"]');
    next?.focus();
    click?.({ key: '', target: next });
    click?.({ key: '', target: next });
    expect(doc.querySelector('[data-pager-readout]')?.textContent).toBe('S03 of 17');
    expect(doc.querySelector('[data-grid-announce]')?.textContent).toContain('S03 of 17');
    const items = doc.querySelectorAll('[data-pager-item]');
    expect(items.filter((item) => item.getAttribute('hidden') === null)).toHaveLength(1);
    expect(items[2]?.getAttribute('hidden')).toBeNull();
    expect(doc.activeElement).toBe(next);
    click?.({ key: '', target: prev });
    expect(doc.querySelector('[data-pager-readout]')?.textContent).toBe('S02 of 17');
  });

  it('starts with no selection and one tab stop', () => {
    const { enhancer, tiles, doc } = setup();
    expect(enhancer).not.toBeNull();
    expect(enhancer?.selectedIndex()).toBe(-1);
    expect(tiles[0]?.getAttribute('tabindex')).toBe('0');
    expect(doc.querySelector('[data-selection-text]')?.textContent).toContain('selected: —');
  });

  it('moves the roving tabindex and the selection bar to the chosen tile', () => {
    const { enhancer, tiles, doc } = setup();
    enhancer?.select(2);
    expect(enhancer?.selectedIndex()).toBe(2);
    expect(tiles[2]?.getAttribute('tabindex')).toBe('0');
    expect(tiles[2]?.getAttribute('aria-selected')).toBe('true');
    expect(tiles[0]?.getAttribute('tabindex')).toBe('-1');
    expect(tiles[0]?.getAttribute('aria-selected')).toBe('false');
    const text = doc.querySelector('[data-selection-text]')?.textContent ?? '';
    expect(text).toContain('selected: S03');
    expect(text).toContain('replace 1 image call');
    expect(text).toContain('reorder 0 calls');
  });

  it('points the replace control at the selected scene', () => {
    const { enhancer, doc, tiles } = setup();
    enhancer?.select(6);
    const replace = doc.querySelector('[data-selection-replace]');
    expect(replace?.getAttribute('href')).toBe(
      (tiles[6]?.getAttribute('href') ?? '') + '#replace-image',
    );
    expect(replace?.getAttribute('aria-disabled')).toBeNull();
  });

  it('announces the selection with the UI_SPEC sentence', () => {
    const { enhancer, doc, tiles } = setup();
    enhancer?.select(2);
    expect(doc.querySelector('[data-grid-announce]')?.textContent).toBe(
      tiles[2]?.getAttribute('data-announce'),
    );
    expect(doc.querySelector('[data-grid-announce]')?.textContent).toBe(
      'Scene 3 of 17, S03, done, 4.4 seconds, pin v3',
    );
  });
});

describe('keyboard (j/k, arrows, r, Esc)', () => {
  it('pages through pending scenes, wraps, and never replaces from reading surfaces', () => {
    const { doc, navigations } = setup({ ...firstThree, scenes: firstThree.scenes.slice(0, 3) });
    const pager = doc.querySelectorAll('[data-scene-pager]');
    const next = doc.querySelector('[data-pager-step="1"]');
    expect(pager).toHaveLength(17);
    next?.focus();
    for (let step = 0; step < 16; step += 1) doc.press('ArrowRight', next);
    expect(doc.querySelector('[data-pager-readout]')?.textContent).toBe('S17 of 17');
    expect(doc.activeElement).toBe(next);
    doc.press('ArrowRight', next);
    expect(doc.querySelector('[data-pager-readout]')?.textContent).toBe('S01 of 17');
    doc.press('r', pager[0] ?? null);
    doc.press('r', doc.querySelector('[data-scene-list]'));
    expect(navigations).toEqual([]);
  });

  it('moves with j and k, selection following focus', () => {
    const { doc, tiles, enhancer } = setup();
    tiles[0]?.focus();
    doc.press('j', tiles[0] ?? null);
    expect(enhancer?.selectedIndex()).toBe(1);
    expect(tiles[1]?.focused).toBe(true);
    doc.press('j', tiles[1] ?? null);
    expect(enhancer?.selectedIndex()).toBe(2);
    doc.press('k', tiles[2] ?? null);
    expect(enhancer?.selectedIndex()).toBe(1);
  });

  it('moves a row with ArrowDown and ArrowUp using the rendered column count', () => {
    const { doc, tiles, enhancer } = setup(firstThree, 6);
    tiles[0]?.focus();
    doc.press('ArrowDown', tiles[0] ?? null);
    expect(enhancer?.selectedIndex()).toBe(6);
    doc.press('ArrowUp', tiles[6] ?? null);
    expect(enhancer?.selectedIndex()).toBe(0);
  });

  it('wraps at the end of the grid rather than falling off it', () => {
    const { doc, tiles, enhancer } = setup();
    enhancer?.select(16);
    doc.press('j', tiles[16] ?? null);
    expect(enhancer?.selectedIndex()).toBe(0);
    doc.press('k', tiles[0] ?? null);
    expect(enhancer?.selectedIndex()).toBe(16);
  });

  it('opens the replace scope with r', () => {
    const { doc, tiles, enhancer, navigations } = setup();
    enhancer?.select(6);
    doc.press('r', tiles[6] ?? null);
    expect(navigations).toEqual([(tiles[6]?.getAttribute('href') ?? '') + '#replace-image']);
  });

  it('clears the selection with Escape without navigating', () => {
    const { doc, tiles, enhancer, navigations } = setup();
    enhancer?.select(3);
    doc.press('Escape', tiles[3] ?? null);
    expect(enhancer?.selectedIndex()).toBe(-1);
    expect(tiles[3]?.getAttribute('aria-selected')).toBe('false');
    expect(doc.querySelector('[data-selection-text]')?.textContent).toContain('selected: —');
    expect(navigations).toEqual([]);
  });

  it('stays inert while a text field has focus (AX-03)', () => {
    const { doc, enhancer } = setup();
    const field = doc.addRoot('<div><textarea id="image-prompt">Scene 7</textarea></div>');
    const textarea = field.querySelector('#image-prompt');
    textarea?.focus();
    doc.press('j', textarea ?? null);
    expect(enhancer?.selectedIndex()).toBe(-1);
  });

  it('returns null when the page has no scene grid', () => {
    const doc = new FakeDocument();
    doc.addRoot('<main><h1>Storyboard</h1></main>');
    expect(initSceneGrid(doc, {})).toBeNull();
  });
});
