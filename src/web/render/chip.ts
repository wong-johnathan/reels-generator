/**
 * UC-04 — video state chip (UI_SPEC §3.1, §5 UC-04).
 *
 * Eight states × three sizes, four channels: colour (token), glyph, word and
 * the border structure that makes the silhouette readable in greyscale
 * (§3.2). The chip never animates beyond an 80 ms colour transition and never
 * invents a ninth state.
 */
import type { StageState } from '../../shared/stages.js';
import { sentenceState, STATE_LABELS } from '../workspace/model.js';
import { escapeAttr } from './html.js';
import { stateGlyph } from '../workspace/glyphs.js';

export type ChipSize = 'sm' | 'md' | 'lg';

export interface ChipOptions {
  readonly size?: ChipSize;
  /** Override the visible word (the header may name the gate rather than the state). */
  readonly label?: string;
  /** Stable hook for the SSE enhancer, e.g. `video-chip`. */
  readonly id?: string;
}

/** `sm` is uppercase 11 px; `md`/`lg` are sentence case 12 px (§3.1). */
export function chipLabel(state: StageState, size: ChipSize): string {
  return size === 'sm' ? STATE_LABELS[state] : sentenceState(state);
}

export function renderChip(state: StageState, options: ChipOptions = {}): string {
  const size = options.size ?? 'sm';
  const label = options.label ?? chipLabel(state, size);
  return (
    '<span class="vchip"' +
    ' data-state="' +
    escapeAttr(state) +
    '"' +
    ' data-size="' +
    size +
    '"' +
    (options.id === undefined ? '' : ' id="' + escapeAttr(options.id) + '"') +
    '>' +
    '<span class="vchip-glyph" data-glyph>' +
    stateGlyph(state, size === 'lg' ? 14 : 12) +
    '</span>' +
    '<span class="vchip-label">' +
    escapeAttr(label) +
    '</span>' +
    '</span>'
  );
}
