/**
 * S-14 progressive enhancement (UI_SPEC §8.4/§9.6, AX-15/AX-16, UX_SPEC A-18).
 *
 * Adds exactly what static HTML cannot:
 *   - the transport readout in `mm:ss.s`, updated as the take plays;
 *   - the active word row, so the derived timing can be checked against what
 *     is heard (`data-active` + `aria-current`, no live-region chatter — 228
 *     announcements would drown the page, AX-10);
 *   - click-to-seek on a row, which changes position only and never starts
 *     playback (AX-16: no autoplay, no auto-playing audio).
 *
 * The server render is complete without this module: the transcript, the band
 * and both commits work with JavaScript off.
 */
import { formatTransportTime, wordIndexAt, type WordTimingRow } from '../narration/model.js';

export interface NarrationElement {
  textContent?: string;
  currentTime?: number;
  paused?: boolean;
  getAttribute?(name: string): string | null;
  setAttribute?(name: string, value: string): void;
  removeAttribute?(name: string): void;
  addEventListener?(type: string, handler: (event: NarrationEvent) => void): void;
}

export interface NarrationEvent {
  readonly target?: NarrationElement | null;
}

export interface NarrationDocument {
  querySelector(selector: string): NarrationElement | null;
  querySelectorAll(selector: string): ArrayLike<NarrationElement>;
}

export interface NarrationController {
  /** `mm:ss.s` for the position the player is at. */
  readonly position: () => string;
  /** The row index currently marked, or -1. */
  readonly activeIndex: () => number;
  /** Seek without changing the play state. */
  readonly seek: (ms: number) => void;
  /** Re-read the player's position and repaint (used by the tests). */
  readonly sync: () => void;
}

function numberAttribute(element: NarrationElement, name: string): number {
  const raw = element.getAttribute?.(name) ?? null;
  if (raw === null) return Number.NaN;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function initNarration(doc: NarrationDocument): NarrationController | null {
  if (doc.querySelector('[data-narration]') === null) return null;
  const audio = doc.querySelector('#narration-audio');
  if (audio === null) return null;

  const positionTarget = doc.querySelector('[data-narration-position]');
  const rowElements = Array.from(
    doc.querySelectorAll('[data-narration-words] tr[data-word-index]'),
  );
  const rows: WordTimingRow[] = [];
  for (const element of rowElements) {
    const index = numberAttribute(element, 'data-word-index');
    const startMs = numberAttribute(element, 'data-word-start');
    const endMs = numberAttribute(element, 'data-word-end');
    if (!Number.isFinite(index) || !Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    rows.push({
      index,
      word: element.textContent ?? '',
      startMs,
      endMs,
      startLabel: formatTransportTime(startMs),
      spanLabel: '',
    });
  }

  let active = -1;

  const paint = (index: number): void => {
    if (index === active) return;
    active = index;
    for (const element of rowElements) {
      const rowIndex = numberAttribute(element, 'data-word-index');
      if (rowIndex === index) {
        element.setAttribute?.('data-active', 'true');
        element.setAttribute?.('aria-current', 'true');
      } else {
        element.removeAttribute?.('data-active');
        element.removeAttribute?.('aria-current');
      }
    }
  };

  const position = (): string => {
    const seconds = audio.currentTime ?? 0;
    return formatTransportTime(seconds * 1000);
  };

  const sync = (): void => {
    const label = position();
    if (positionTarget !== null) positionTarget.textContent = label;
    paint(wordIndexAt(rows, (audio.currentTime ?? 0) * 1000));
  };

  const seek = (ms: number): void => {
    const clamped = Math.max(0, ms);
    audio.currentTime = clamped / 1000;
    sync();
  };

  for (const element of rowElements) {
    element.addEventListener?.('click', () => {
      seek(numberAttribute(element, 'data-word-start'));
    });
  }
  for (const type of ['timeupdate', 'seeked', 'loadedmetadata']) {
    audio.addEventListener?.(type, sync);
  }

  sync();

  return {
    position,
    activeIndex: () => active,
    seek,
    sync,
  };
}

const runtimeDocument = (globalThis as { document?: NarrationDocument }).document;
if (runtimeDocument !== undefined) {
  initNarration(runtimeDocument);
}
