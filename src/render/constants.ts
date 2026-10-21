/**
 * Render pipeline constants — TECH_DESIGN §6 and R-010.
 *
 * One module owns the numbers so the encoder, the QC thresholds and the tests
 * cannot drift apart. Every value here is quoted from the design; a change is a
 * design change, not a local tuning knob.
 */

/** R-010-1: 9:16 output geometry and frame rate. */
export const OUTPUT_WIDTH = 1080;
export const OUTPUT_HEIGHT = 1920;
export const OUTPUT_FPS = 30;

/** §6.3: crossfade default; a scene shorter than 0.6 s is cut instead. */
export const TRANSITION_S = 0.3;
export const MIN_TRANSITION_SCENE_S = 0.6;

/** §6.5/§6.6: audio mix and encoder settings. */
export const AUDIO_SAMPLE_RATE = 48_000;
export const AUDIO_BITRATE_KBPS = 128;
export const AUDIO_CHANNELS = 2;
export const X264_PRESET = 'medium';
export const X264_CRF = 20;

/** §6.8: hard runtime ceiling for one render attempt. */
export const RENDER_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * §6.4: caption line grouping — at most two lines per cue. The per-line
 * character budget is derived from the font size (`captionMaxCharsPerLine` in
 * captions.ts), so the character budget and the width budget can never
 * disagree about how much fits on one line.
 */
export const CAPTION_MAX_LINES = 2;
/** R-010-6 / D13: one generic 5 % inset per aspect ratio. */
export const CAPTION_SAFE_INSET_RATIO = 0.05;

/** R-010-4: a frame whose mean luminance is < 16 or > 240 is blank/white. */
export const MIN_LUMINANCE = 16;
export const MAX_LUMINANCE = 240;

/** R-010-5: visible scene duration must be ≥ narration span − 0.2 s. */
export const SCENE_PRESENCE_SLACK_S = 0.2;

/** R-010-3: audio duration within ±0.5 s of video duration. */
export const AUDIO_VIDEO_TOLERANCE_S = 0.5;

/** R-010-2: frame rate within ±1 fps of 30. */
export const FPS_TOLERANCE = 1;

/** R-010-7: rendered duration must match the timing band to the frame. */
export const DURATION_TOLERANCE_S = 0.1;

/**
 * Luminance above this counts as ink when scanning the caption-safe-area pass.
 * The scan runs on a black background, so any value above the floor is glyph
 * anti-aliasing; 32 is well clear of a limited-range black (16) and of JPEG-ish
 * noise, and well below a caption glyph (≥ 128 at full opacity).
 */
export const CAPTION_INK_THRESHOLD = 32;

/** The inverse: a caption pass with no pixel this bright contains no captions. */
export const CAPTION_PRESENT_THRESHOLD = 128;

/** The ASS style name and font used for burn-in and for the isolated scan pass. */
export const CAPTION_STYLE = 'ReelsCaption';
export const CAPTION_FONT = 'DejaVu Sans';
/** 68 px reads at arm's length on a phone at a 1080-wide frame (the 64–72 px band). */
export const CAPTION_FONT_SIZE = 68;
/**
 * The caption block's bottom anchor: the *ink* bottom (glyph + outline +
 * shadow) sits at this fraction of the frame height — 75 % — so the block lives
 * in the lower third and stays clear of the bottom ~25 % of a 9:16 frame, where
 * the platform caption row, like/comment rail and audio row sit.
 */
export const CAPTION_BLOCK_BOTTOM_RATIO = 0.75;
