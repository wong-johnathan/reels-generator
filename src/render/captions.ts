/**
 * Captions — word timings to ASS burn-in, .srt and .vtt (TECH_DESIGN §6.4, §8.1).
 *
 * One transform owns caption text order and grouping, because R-010-6 is a
 * geometric promise: the ASS file is authored so the caption box cannot leave
 * the 9:16 safe area, and the delivered `.srt`/`.vtt` are generated from the
 * *same* cue list as the burn-in. A second grouping implementation would let the
 * burned-in captions and the sidecars disagree about what was said when.
 *
 * The safe area is a rectangle inset 5 % from each edge (R-010-6, D13):
 * `x ∈ [54, 1026]`, `y ∈ [96, 1824]` at 1080x1920. ASS margins are *not* the
 * safe area: the outline and the drop shadow are drawn outside the text box, so
 * the margins are inset by `outline + shadow` on top of the 5 % inset. That
 * makes the ink box, not just the nominal text box, inside the rectangle. The
 * block is also raised off the bottom edge to `CAPTION_BLOCK_BOTTOM_RATIO` so it
 * stays clear of the platform UI that lives in the bottom ~25 % of a 9:16 frame.
 */
import {
  CAPTION_BLOCK_BOTTOM_RATIO,
  CAPTION_FONT,
  CAPTION_FONT_SIZE,
  CAPTION_INK_THRESHOLD,
  CAPTION_MAX_LINES,
  CAPTION_SAFE_INSET_RATIO,
  CAPTION_STYLE,
  MIN_LUMINANCE,
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
} from './constants.js';

/** The 5 % inset rectangle, in output pixels, plus its size. */
export interface CaptionSafeArea {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

/** R-010-6 / D13: one generic safe area per aspect ratio. */
export function captionSafeArea(
  width: number = OUTPUT_WIDTH,
  height: number = OUTPUT_HEIGHT,
  insetRatio: number = CAPTION_SAFE_INSET_RATIO,
): CaptionSafeArea {
  const insetX = Math.round(width * insetRatio);
  const insetY = Math.round(height * insetRatio);
  return {
    left: insetX,
    top: insetY,
    right: width - insetX,
    bottom: height - insetY,
    width,
    height,
  };
}

/**
 * ASS outline and shadow widths, in pixels, from the style below. A tight dark
 * outline plus a subtle drop shadow gives white bold text contrast over busy
 * imagery without a background box (BorderStyle stays 1: outline + shadow, no
 * opaque panel).
 */
export const CAPTION_OUTLINE_PX = 3;
export const CAPTION_SHADOW_PX = 3;

/** The ink margin added on every side by the outline and the drop shadow. */
export const CAPTION_INK_PAD_PX = CAPTION_OUTLINE_PX + CAPTION_SHADOW_PX;

/**
 * ASS margins for a horizontally-centred caption block whose *ink* bottom sits
 * at `CAPTION_BLOCK_BOTTOM_RATIO` of the frame height. The text box is inset by
 * the outline and the shadow, so glyph ink — not the nominal box — stays inside
 * `[left,right]` and above the block-bottom line by construction.
 */
export function assMargins(safe: CaptionSafeArea): {
  readonly left: number;
  readonly right: number;
  readonly vertical: number;
} {
  // Ink bottom at 75 % of the frame height (clear of the bottom ~25 % UI); the
  // ASS bottom margin is measured to the *text box* bottom, which sits one ink
  // pad higher so the outline and shadow stay above the line too.
  const inkBottom = Math.round(safe.height * CAPTION_BLOCK_BOTTOM_RATIO);
  const textBottom = inkBottom - CAPTION_INK_PAD_PX;
  return {
    left: safe.left + CAPTION_INK_PAD_PX,
    right: safe.width - safe.right + CAPTION_INK_PAD_PX,
    vertical: safe.height - textBottom,
  };
}

/**
 * The width of the caption *text box* in output pixels: the safe rectangle
 * minus the ink pad on each side. A line whose estimated glyph width fits this
 * budget cannot put ink outside the safe area (outline and shadow are already
 * accounted for by the pad).
 */
export function captionTextWidthPx(safe: CaptionSafeArea = captionSafeArea()): number {
  return safe.right - safe.left - 2 * CAPTION_INK_PAD_PX;
}

/**
 * The per-line character budget derived from the font size, so the char cap and
 * the width budget always agree. Uses the mean advance width of the character
 * classes below (0.56 em, the default class) so it is an upper bound, not the
 * binding constraint — the width estimate in `fitsOnLine` is what breaks lines.
 */
export function captionMaxCharsPerLine(fontSize: number = CAPTION_FONT_SIZE): number {
  return Math.max(
    1,
    Math.floor(captionTextWidthPx() / (AVG_CHAR_WIDTH_EM * fontSize * BOLD_EM_FACTOR)),
  );
}

/** A word as the timing document stores it (narration-relative milliseconds). */
export interface CaptionWord {
  readonly word: string;
  readonly start_ms: number;
  readonly end_ms: number;
}

/** One on-screen caption: one or two lines over one time range. */
export interface CaptionCue {
  /** 1-based, in playback order — the `.srt` sequence number. */
  readonly index: number;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly lines: readonly string[];
}

/**
 * Rough advance width per character class, in ems. Bold DejaVu Sans is about
 * 0.56 em for average mixed text; capitals and digits are wider. The estimate is
 * deliberately pessimistic so a cue that passes here cannot overflow margins and
 * fail the safe-area scan on a real render.
 */
function charWidthEm(character: string): number {
  if (character === ' ') return 0.32;
  if (/[iljtfr.,;:'!|]/.test(character)) return 0.32;
  if (/[mwMW@%]/.test(character)) return 0.92;
  if (/[A-Z0-9#&$]/.test(character)) return 0.68;
  return 0.56;
}

/** The default (mean) advance width class, in ems — matches `charWidthEm`. */
const AVG_CHAR_WIDTH_EM = 0.56;
/** Bold DejaVu Sans advances ~5 % wider than the nominal em. */
const BOLD_EM_FACTOR = 1.05;

/** Estimated ink width of one line, in output pixels (bold adds ~5 %). */
export function estimateTextWidthPx(text: string, fontSize: number = CAPTION_FONT_SIZE): number {
  let ems = 0;
  for (const character of text) ems += charWidthEm(character);
  return Math.ceil(ems * fontSize * BOLD_EM_FACTOR);
}

export interface CaptionGroupingOptions {
  readonly maxCharsPerLine?: number;
  readonly maxLines?: number;
  /** Available text-box width; defaults to the safe width minus the ink pad. */
  readonly maxLineWidthPx?: number;
  readonly fontSize?: number;
}

function fitsOnLine(
  candidate: string,
  maxChars: number,
  maxWidthPx: number,
  fontSize: number,
): boolean {
  if (candidate.length > maxChars) return false;
  return estimateTextWidthPx(candidate, fontSize) <= maxWidthPx;
}

/**
 * Group words into cues of at most `maxLines` lines. A line breaks when the next
 * word would exceed the character *or* the width budget — the character budget
 * is derived from the font size and the width budget is the binding one. A
 * single word wider than a line gets its own line (nothing is truncated or
 * dropped), and `buildAssDocument` refuses that cue loudly rather than let it
 * bleed off-screen.
 */
export function groupCaptionCues(
  words: readonly CaptionWord[],
  options: CaptionGroupingOptions = {},
): CaptionCue[] {
  const fontSize = options.fontSize ?? CAPTION_FONT_SIZE;
  const maxChars = options.maxCharsPerLine ?? captionMaxCharsPerLine(fontSize);
  const maxLines = options.maxLines ?? CAPTION_MAX_LINES;
  const maxWidth = options.maxLineWidthPx ?? captionTextWidthPx();

  const cues: CaptionCue[] = [];
  let lines: string[] = [];
  let current = '';
  let startMs = 0;
  let endMs = 0;
  let open = false;

  const flush = (): void => {
    if (!open || lines.length === 0) return;
    cues.push({ index: cues.length + 1, start_ms: startMs, end_ms: endMs, lines: [...lines] });
    lines = [];
    current = '';
    open = false;
  };

  for (const word of words) {
    const text = sanitizeCaptionText(word.word);
    if (text === '') continue;

    if (!open) {
      open = true;
      startMs = word.start_ms;
      endMs = word.end_ms;
      current = text;
      continue;
    }

    const candidate = current === '' ? text : `${current} ${text}`;
    if (fitsOnLine(candidate, maxChars, maxWidth, fontSize)) {
      current = candidate;
      endMs = word.end_ms;
      continue;
    }

    // The word does not fit the current line: close it and try a new line.
    lines.push(current);
    current = text;
    endMs = word.end_ms;

    if (lines.length >= maxLines) {
      // The cue is full; the word that just opened a new line starts the next cue.
      const nextStartMs = word.start_ms;
      const nextEndMs = word.end_ms;
      const pending = current;
      flush();
      open = true;
      startMs = nextStartMs;
      endMs = nextEndMs;
      current = pending;
    }
  }

  if (open) {
    if (current !== '') lines.push(current);
    flush();
  }

  return cues;
}

/** ASS/VTT text cannot contain ASS override syntax or line breaks. */
export function sanitizeCaptionText(text: string): string {
  return text
    .replace(/[{}]/g, '')
    .replace(/\\/g, '/')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

/** `H:MM:SS.cc` — ASS event timestamps use centiseconds. */
export function assTimestamp(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const centiseconds = Math.floor((clamped % 1000) / 10);
  const totalSeconds = Math.floor(clamped / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return `${hours}:${pad2(minutes)}:${pad2(seconds)}.${pad2(centiseconds)}`;
}

/** `HH:MM:SS,mmm` — SubRip. */
export function srtTimestamp(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const millis = clamped % 1000;
  const totalSeconds = Math.floor(clamped / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)},${millis.toString().padStart(3, '0')}`;
}

/** `HH:MM:SS.mmm` — WebVTT. */
export function vttTimestamp(ms: number): string {
  return srtTimestamp(ms).replace(',', '.');
}

export interface CaptionDocuments {
  readonly ass: string;
  readonly srt: string;
  readonly vtt: string;
}

/** A cue line whose estimated width exceeds the caption text box. */
export class CaptionOverflowError extends Error {
  constructor(line: string, widthPx: number, maxPx: number) {
    super(
      `caption line ${JSON.stringify(line)} is ~${widthPx} px wide, over the ` +
        `${maxPx} px safe text width`,
    );
    this.name = 'CaptionOverflowError';
  }
}

/**
 * The ASS burn-in document. PlayRes matches the output, `WrapStyle: 2` disables
 * libass's own wrapping (line breaks are ours), and the style's margins anchor
 * the block at `CAPTION_BLOCK_BOTTOM_RATIO` of the frame height and inset it by
 * the outline/shadow so the ink box is inside the safe area by construction.
 *
 * Before authoring, every line is checked against the text-box width. Because
 * `WrapStyle: 2` disables libass's own wrapping, an over-long line would
 * otherwise overflow silently; this assertion is the deterministic guarantee
 * that no rendered line can exceed the safe width.
 */
export function buildAssDocument(
  cues: readonly CaptionCue[],
  safe: CaptionSafeArea = captionSafeArea(),
): string {
  const textWidth = captionTextWidthPx(safe);
  for (const cue of cues) {
    for (const line of cue.lines) {
      const width = estimateTextWidthPx(sanitizeCaptionText(line), CAPTION_FONT_SIZE);
      if (width > textWidth) {
        throw new CaptionOverflowError(sanitizeCaptionText(line), width, textWidth);
      }
    }
  }

  const margins = assMargins(safe);
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${safe.width}`,
    `PlayResY: ${safe.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, ' +
      'Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, ' +
      'Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: ${CAPTION_STYLE},${CAPTION_FONT},${CAPTION_FONT_SIZE},&H00FFFFFF,&H000000FF,` +
      `&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${CAPTION_OUTLINE_PX},${CAPTION_SHADOW_PX},` +
      `2,${margins.left},${margins.right},${margins.vertical},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const events = cues.map((cue) => {
    const text = cue.lines.map((line) => sanitizeCaptionText(line)).join('\\N');
    return (
      `Dialogue: 0,${assTimestamp(cue.start_ms)},${assTimestamp(cue.end_ms)},${CAPTION_STYLE},,` +
      `0,0,0,,{\\fad(120,120)}${text}`
    );
  });
  return `${header.join('\n')}\n${events.join('\n')}\n`;
}

/** `HH:MM:SS,mmm` blocks — the deliverable SubRip sidecar. */
export function buildSrtDocument(cues: readonly CaptionCue[]): string {
  const blocks = cues.map((cue) => {
    const text = cue.lines.join('\n');
    return `${cue.index}\n${srtTimestamp(cue.start_ms)} --> ${srtTimestamp(cue.end_ms)}\n${text}\n`;
  });
  return blocks.join('\n');
}

/** `WEBVTT` with `.` millisecond separators — the deliverable WebVTT sidecar. */
export function buildVttDocument(cues: readonly CaptionCue[]): string {
  const blocks = cues.map((cue) => {
    const text = cue.lines.join('\n');
    return `${cue.index}\n${vttTimestamp(cue.start_ms)} --> ${vttTimestamp(cue.end_ms)}\n${text}\n`;
  });
  return `WEBVTT\n\n${blocks.join('\n')}`;
}

/**
 * Shift cue times by the audio lead so captions land on the speech in the video
 * timeline. Words arrive narration-relative (first word at 0); the video starts
 * with `lead_s` of silence (§6.5).
 */
export function offsetCues(cues: readonly CaptionCue[], offsetMs: number): CaptionCue[] {
  if (offsetMs === 0) return [...cues];
  return cues.map((cue) => ({
    ...cue,
    start_ms: cue.start_ms + offsetMs,
    end_ms: cue.end_ms + offsetMs,
  }));
}

export interface BuildCaptionInput {
  readonly words: readonly CaptionWord[];
  readonly leadS: number;
  readonly maxCharsPerLine?: number;
  readonly fontSize?: number;
}

/**
 * The whole caption transform: words → cues → ASS + `.srt` + `.vtt`, from one
 * cue list (R-010-6, R-014-1).
 *
 * Emphasis note: the storyboard carries a per-scene `caption_emphasis` phrase,
 * but it does not reach this transform — the timing document's `words` are
 * `{ word, start_ms, end_ms }` with no emphasis, and the render stage passes
 * only `words` + `leadS`. Emphasising a phrase would mean matching free text
 * against the word stream, which this module deliberately does not invent;
 * honouring it is a follow-up that belongs with the TC/timing stage.
 */
export function buildCaptionDocuments(input: BuildCaptionInput): {
  readonly cues: readonly CaptionCue[];
  readonly documents: CaptionDocuments;
} {
  const cues = offsetCues(
    groupCaptionCues(input.words, {
      maxCharsPerLine: input.maxCharsPerLine,
      fontSize: input.fontSize,
    }),
    Math.round(input.leadS * 1000),
  );
  return {
    cues,
    documents: {
      ass: buildAssDocument(cues),
      srt: buildSrtDocument(cues),
      vtt: buildVttDocument(cues),
    },
  };
}

export { CAPTION_INK_THRESHOLD, MIN_LUMINANCE };
