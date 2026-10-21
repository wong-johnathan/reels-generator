/**
 * Rail painting (UC-03/UC-05, DI-05) — shared by the SSE enhancer and the S-10
 * commit flow.
 *
 * One function renders the stage nodes, the `stale:` summary and the stale
 * ribbon from a snapshot map. Both callers must show exactly the same thing:
 * an SSE frame and a post-commit refetch are two ways of learning the same
 * server state, not two renderers.
 */
import { stateGlyph } from './glyphs.js';
import {
  FEED_RAIL_WORDS,
  ribbonCodes,
  staleCodes,
  type StageSnapshot,
  type StageState,
} from './events.js';

export interface RailElement {
  textContent: string;
  innerHTML?: string;
  hidden?: boolean;
  getAttribute?(name: string): string | null;
  setAttribute?(name: string, value: string): void;
  removeAttribute?(name: string): void;
  querySelector?(selector: string): RailElement | null;
  querySelectorAll?(selector: string): ArrayLike<RailElement>;
  remove?(): void;
}

export interface RailDocument {
  querySelector(selector: string): RailElement | null;
  querySelectorAll(selector: string): ArrayLike<RailElement>;
}

function attr(element: RailElement, name: string): string | null {
  return element.getAttribute?.(name) ?? null;
}

function setAttr(element: RailElement, name: string, value: string): void {
  element.setAttribute?.(name, value);
}

function each(nodes: ArrayLike<RailElement>, visit: (node: RailElement) => void): void {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node !== undefined) visit(node);
  }
}

function renderStageNode(doc: RailDocument, code: string, snapshot: StageSnapshot): void {
  const node = doc.querySelector('[data-stage="' + code + '"]');
  if (node === null) return;
  // DI-05: a stale stage displays STALE even though its stored state is still
  // `done`; the tooltip keeps the underlying state (see model.railStateFor).
  const displayed: StageState = snapshot.stale ? 'stale' : snapshot.state;
  setAttr(node, 'data-state', displayed);
  setAttr(node, 'data-stale', snapshot.stale ? 'true' : 'false');
  const word = node.querySelector?.('[data-state-word]');
  if (word !== null && word !== undefined) word.textContent = FEED_RAIL_WORDS[displayed];
  const glyph = node.querySelector?.('[data-glyph]');
  if (glyph !== null && glyph !== undefined) glyph.innerHTML = stateGlyph(displayed);
  // The progress bar belongs to `running` only (UC-03: never a percentage of a
  // whole stage); a finished stage hides it rather than freezing a stale bar.
  const progress = node.querySelector?.('[data-progress]');
  if (progress !== null && progress !== undefined) progress.hidden = snapshot.state !== 'running';
}

export function paintStages(
  doc: RailDocument,
  stages: Readonly<Record<string, StageSnapshot>>,
): void {
  for (const [code, snapshot] of Object.entries(stages)) {
    renderStageNode(doc, code, snapshot);
  }
  const nodes: RailElement[] = [];
  each(doc.querySelectorAll('[data-stage]'), (node) => nodes.push(node));

  const summary = doc.querySelector('[data-stale-summary]');
  const allStale = staleCodes(stages);
  if (summary !== null) {
    summary.textContent = allStale.length === 0 ? 'stale: none' : 'stale: ' + allStale.join(', ');
  }

  const ribbon = doc.querySelector('[data-stale-ribbon]');
  if (ribbon !== null) {
    const codes = ribbonCodes(stages);
    ribbon.hidden = codes.length === 0;
    if (codes.length === 0) ribbon.setAttribute?.('hidden', '');
    else ribbon.removeAttribute?.('hidden');
    const list = ribbon.querySelector?.('[data-ribbon-list]');
    if (list !== null && list !== undefined) {
      list.innerHTML = codes
        .map(
          (code) =>
            '<span class="stale-ribbon-stage mono" data-ribbon-stage="' +
            code +
            '">' +
            code +
            ' ' +
            stateGlyph('stale') +
            ' stale</span>',
        )
        .join('<span class="stale-separator" aria-hidden="true"> · </span>');
    }
  }

  // Keep the rail a single tab stop even after a state change.
  const active = nodes.find((node) => attr(node, 'data-current') === 'true') ?? nodes[0];
  for (const node of nodes) {
    const link = node.querySelector?.('a');
    if (link === null || link === undefined) continue;
    setAttr(link, 'tabindex', node === active ? '0' : '-1');
  }
}
