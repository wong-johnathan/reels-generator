/**
 * State glyphs — UI_SPEC §2.6 and §3.1, copied path-for-path from the visual
 * reference in `mockups/ui-mockup.html` (symbols `i-dot`, `i-spin`, `i-check`,
 * `i-lock`, `i-warn`, `i-x`, `i-ban`, `i-slash`).
 *
 * Inline SVG, not a font and not an emoji: the glyph is half of AX-13's
 * structure channel (the other half is the chip border pattern), so it must
 * render identically in greyscale, at 200 % zoom and with no network request.
 * The markup is a fixed string per state — never interpolated with data.
 */
import type { StageState } from '../../shared/stages.js';

type GlyphName = 'dot' | 'spin' | 'check' | 'lock' | 'warn' | 'x' | 'ban' | 'slash';

const PATHS: Readonly<Record<GlyphName, string>> = {
  dot: '<circle cx="8" cy="8" r="3" fill="currentColor"/>',
  spin:
    '<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".3"/>' +
    '<path d="M8 2.4A5.6 5.6 0 0113.6 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  check:
    '<path d="M3 8.5l3.2 3.2L13 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  lock:
    '<rect x="3.5" y="7" width="9" height="6.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
    '<path d="M5.6 7V5.4a2.4 2.4 0 014.8 0V7" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  warn:
    '<path d="M8 2.6l5.8 10.2H2.2L8 2.6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
    '<path d="M8 6.2v3.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
    '<circle cx="8" cy="11.3" r=".9" fill="currentColor"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  ban:
    '<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
    '<path d="M4.2 4.2l7.6 7.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  slash: '<path d="M3 13L13 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
};

/** The eight stage states ↔ their glyph, exactly UI_SPEC §3.1's column. */
export const STATE_GLYPH: Readonly<Record<StageState, GlyphName>> = {
  not_run: 'dot',
  running: 'spin',
  done: 'check',
  awaiting_approval: 'lock',
  stale: 'warn',
  failed: 'x',
  blocked: 'ban',
  cancelled: 'slash',
};

/** A self-contained 16×16 glyph; colour comes from `currentColor`. */
export function glyphSvg(name: GlyphName, size = 12): string {
  return (
    '<svg class="glyph" viewBox="0 0 16 16" width="' +
    size +
    '" height="' +
    size +
    '" aria-hidden="true" focusable="false">' +
    PATHS[name] +
    '</svg>'
  );
}

/** The glyph for a stage state (UI_SPEC §3.1). */
export function stateGlyph(state: StageState, size = 12): string {
  return glyphSvg(STATE_GLYPH[state], size);
}

/** The clock glyph used by the benign `waiting:` attention reasons (§3.4). */
export function clockGlyph(size = 12): string {
  return glyphSvg('spin', size);
}
