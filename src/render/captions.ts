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
 * makes the ink box, not just the nominal text box, inside the rectangle.
 */
import {
  CAPTION_FONT,
  CAPTION_FONT_SIZE,
  CAPTION_INK_THRESHOLD,
  CAPTION_MAX_CHARS_PER_LINE,
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

/** ASS outline and shadow widths, in pixels, from the style below. */
export const CAPTION_OUTLINE_PX = 4;
export const CAPTION_SHADOW_PX = 2;

/**
 * ASS margins for a bottom-centred caption inside the safe area. The text box is
 * inset by the outline and the shadow as well, so glyph ink — not the nominal
 * box — stays inside `[left,right] x [top,bottom]`.
 */
export function assMargins(safe: CaptionSafeArea): {
  readonly left: number;
  readonly right: number;
  readonly vertical: number;
} {
  const pad = CAPTION_OUTLINE_PX + CAPTION_SHADOW_PX;
  return {
    left: safe.left + pad,
    right: safe.width - safe.right + pad,
    vertical: safe.height - safe.bottom + pad,
  };
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
 * 0.55 em for average mixed text; capitals and digits are wider. The estimate is
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

/** Estimated ink width of one line, in output pixels (bold adds ~5 %). */
export function estimateTextWidthPx(text: string, fontSize: number = CAPTION_FONT_SIZE): number {
  let ems = 0;
  for (const character of text) ems += charWidthEm(character);
  return Math.ceil(ems * fontSize * 1.05);
}

export interface CaptionGroupingOptions {
  readonly maxCharsPerLine?: number;
  readonly maxLines?: number;
  /** Available ink width; defaults to the 918 px safe width at 1080x1920. */
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
 * word would exceed the character *or* the width budget — the design's "≤ 2
 * lines, ≤ ~42 chars/line" is an upper bound and the width budget is the binding
 * one at 48 px. A single word wider than a line gets its own line (nothing is
 * truncated or dropped: a silent caption edit is worse than a wide one, and the
 * safe-area scan is what flags it).
 */
export function groupCaptionCues(
  words: readonly CaptionWord[],
  options: CaptionGroupingOptions = {},
): CaptionCue[] {
  const maxChars = options.maxCharsPerLine ?? CAPTION_MAX_CHARS_PER_LINE;
  const maxLines = options.maxLines ?? CAPTION_MAX_LINES;
  const safe = captionSafeArea();
  const maxWidth = options.maxLineWidthPx ?? safe.right - safe.left;
  const fontSize = options.fontSize ?? CAPTION_FONT_SIZE;

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

/**
 * The ASS burn-in document. PlayRes matches the output, `WrapStyle: 2` disables
 * libass's own wrapping (line breaks are ours), and the style's margins are the
 * safe area minus the outline/shadow so the ink box is inside the rectangle by
 * construction.
 */
export function buildAssDocument(
  cues: readonly CaptionCue[],
  safe: CaptionSafeArea = captionSafeArea(),
): string {
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
