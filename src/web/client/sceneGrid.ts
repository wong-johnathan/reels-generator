/**
 * S-12 progressive enhancement — selection and its announcement
 * (UI_SPEC §5 UC-07, §8.4 AX-02, §6.7; UX_SPEC W-06).
 *
 * Adds exactly what HTML cannot: a roving tabindex over the 17 tiles, the
 * selection bar's target, and one live-region sentence. Everything it prints
 * comes from attributes the server rendered (`data-scene-no`, `data-announce`,
 * the tile `href`), so the browser never formats a scene, a span or a call
 * count of its own, and there is no shared module to fork.
 *
 * `Enter` is deliberately not handled: each tile is a link to S-13, so the
 * browser's own activation is the behaviour (no custom navigation to break
 * middle-click or a summary link).
 */
import { isTextField, type ActiveElementShape } from './behaviours.js';

export interface GridElement {
  textContent: string;
  disabled?: boolean;
  value?: string;
  focus?(): void;
  getAttribute?(name: string): string | null;
  setAttribute?(name: string, value: string): void;
  removeAttribute?(name: string): void;
}

export interface GridEventLike {
  readonly key: string;
  readonly target?: GridElement | null;
  preventDefault?(): void;
}

export interface GridDocumentLike {
  querySelector(selector: string): GridElement | null;
  querySelectorAll(selector: string): ArrayLike<GridElement>;
  readonly activeElement?: GridElement | null;
  addEventListener?(type: string, handler: (event: GridEventLike) => void): void;
}

export interface SceneGridEnvironment {
  readonly navigate?: (href: string) => void;
}

export interface SceneGridEnhancer {
  selectedIndex(): number;
  select(index: number): void;
  clear(): void;
}

const SELECTION_PREFIX = 'selected: ';
const SELECTION_SUFFIX = ' · replace 1 image call · reorder 0 calls';
const NO_SELECTION = SELECTION_PREFIX + '—' + SELECTION_SUFFIX;
const REPLACE_ANCHOR = '#replace-image';

function toArray(list: ArrayLike<GridElement>): GridElement[] {
  return Array.from(list as ArrayLike<GridElement>);
}

function attr(element: GridElement | null, name: string): string | null {
  return element?.getAttribute?.(name) ?? null;
}

/**
 * Wires the grid's selection. Returns null when the page has no grid, so the
 * shell can include this module on every workspace tab without a guard.
 */
export function initSceneGrid(
  doc: GridDocumentLike,
  env: SceneGridEnvironment = {},
): SceneGridEnhancer | null {
  const grid = doc.querySelector('[data-scene-grid]');
  if (grid === null) return null;
  const tiles = toArray(doc.querySelectorAll('[data-scene-tile]'));
  if (tiles.length === 0) return null;

  const parsedColumns = Number(attr(grid, 'data-columns') ?? '6');
  const columns =
    Number.isFinite(parsedColumns) && parsedColumns > 0 ? Math.trunc(parsedColumns) : 6;
  const selectionText = doc.querySelector('[data-selection-text]');
  const announce = doc.querySelector('[data-grid-announce]');
  const replace = doc.querySelector('[data-selection-replace]');
  const pagerItems = toArray(doc.querySelectorAll('[data-pager-item]'));
  const pagerTiles = toArray(doc.querySelectorAll('[data-scene-pager]'));
  const readout = doc.querySelector('[data-pager-readout]');
  const controls = doc.querySelector('[data-pager-controls]');
  let pagerIndex = 0;
  let index = -1;

  // Pager selection must not focus the hidden desktop grid.
  function paintPager(next: number, speak = true): void {
    pagerIndex = ((next % pagerItems.length) + pagerItems.length) % pagerItems.length;
    for (const [position, item] of pagerItems.entries()) {
      if (position === pagerIndex) item.removeAttribute?.('hidden');
      else item.setAttribute?.('hidden', '');
      pagerTiles[position]?.setAttribute?.(
        'aria-current',
        position === pagerIndex ? 'true' : 'false',
      );
    }
    const tile = pagerTiles[pagerIndex];
    const label = (attr(tile ?? null, 'data-scene-label') ?? '—') + ' of ' + pagerItems.length;
    if (readout !== null) readout.textContent = label;
    if (speak) {
      index = pagerIndex < tiles.length ? pagerIndex : -1;
      paintSelection(false);
      if (announce !== null)
        announce.textContent =
          label +
          '. ' +
          (attr(tile ?? null, 'data-announce') ?? attr(tile ?? null, 'aria-label') ?? '');
    }
  }

  function paintSelection(focus = true): void {
    for (const [position, tile] of tiles.entries()) {
      const selected = position === index;
      tile.setAttribute?.('tabindex', selected || (index === -1 && position === 0) ? '0' : '-1');
      tile.setAttribute?.('aria-selected', selected ? 'true' : 'false');
    }
    const tile = index >= 0 ? tiles[index] : undefined;
    if (selectionText !== null) {
      selectionText.textContent =
        tile === undefined
          ? NO_SELECTION
          : SELECTION_PREFIX + (attr(tile, 'data-scene-no') ?? '') + SELECTION_SUFFIX;
    }
    if (replace !== null) {
      if (tile === undefined) {
        replace.setAttribute?.('href', REPLACE_ANCHOR);
        replace.setAttribute?.('aria-disabled', 'true');
        replace.setAttribute?.('tabindex', '-1');
      } else {
        replace.setAttribute?.('href', (attr(tile, 'href') ?? '') + REPLACE_ANCHOR);
        replace.removeAttribute?.('aria-disabled');
        replace.removeAttribute?.('tabindex');
      }
    }
    if (announce !== null) {
      announce.textContent = tile === undefined ? '' : (attr(tile, 'data-announce') ?? '');
      if (tile !== undefined) announce.setAttribute?.('data-announced', 'true');
    }
    if (focus) tile?.focus?.();
  }

  const enhancer: SceneGridEnhancer = {
    selectedIndex: () => index,
    select(next: number): void {
      if (tiles.length === 0) return;
      const wrapped = ((next % tiles.length) + tiles.length) % tiles.length;
      index = wrapped;
      if (pagerItems.length > 0) paintPager(index, false);
      paintSelection();
    },
    clear(): void {
      index = -1;
      paintSelection();
    },
  };

  function onKeydown(event: GridEventLike): void {
    if (isTextField((doc.activeElement ?? null) as ActiveElementShape | null)) return;
    const active = event.target ?? doc.activeElement ?? null;
    const pagerCurrent = active === null ? -1 : pagerTiles.indexOf(active);
    if (pagerCurrent >= 0 || attr(active, 'data-pager-step') !== null) {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault?.();
        paintPager(pagerIndex + (event.key === 'ArrowRight' ? 1 : -1));
        if (pagerCurrent >= 0) pagerTiles[pagerIndex]?.focus?.();
      }
      return;
    }
    const current = active === null ? -1 : tiles.indexOf(active);
    if (current < 0) return;

    switch (event.key) {
      case 'j':
      case 'ArrowRight':
        event.preventDefault?.();
        enhancer.select(current + 1);
        return;
      case 'k':
      case 'ArrowLeft':
        event.preventDefault?.();
        enhancer.select(current - 1);
        return;
      case 'ArrowDown':
        event.preventDefault?.();
        enhancer.select(Math.min(tiles.length - 1, current + columns));
        return;
      case 'ArrowUp':
        event.preventDefault?.();
        enhancer.select(Math.max(0, current - columns));
        return;
      case 'r': {
        const selected = index >= 0 ? tiles[index] : tiles[current];
        const href = attr(selected ?? null, 'href');
        if (href !== null) {
          event.preventDefault?.();
          if (env.navigate !== undefined) env.navigate(href + REPLACE_ANCHOR);
        }
        return;
      }
      case 'Escape':
        event.preventDefault?.();
        enhancer.clear();
        return;
      default:
        // `Enter` stays the browser's own link activation.
        return;
    }
  }

  doc.addEventListener?.('keydown', onKeydown);
  doc.addEventListener?.('click', (event) => {
    const step = attr(event.target ?? null, 'data-pager-step');
    if (step !== null) paintPager(pagerIndex + Number(step));
  });
  if (pagerItems.length > 0) {
    paintPager(0, false);
    controls?.removeAttribute?.('hidden');
  }
  paintSelection();
  return enhancer;
}

const runtimeDocument = (globalThis as { document?: GridDocumentLike }).document;
if (runtimeDocument !== undefined) initSceneGrid(runtimeDocument);
