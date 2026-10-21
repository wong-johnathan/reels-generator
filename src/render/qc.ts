/**
 * QC — the six automated assertions of R-010-2…7 (US-025, TECH_DESIGN §6.7).
 *
 * Every check reads the *delivered* file, not the render plan:
 *
 *   geometry       ffprobe: 1080x1920 (±0), 30 fps (±1), H.264 + AAC (R-010-2)
 *   audio          ffprobe: audio present, |audio − video| ≤ 0.5 s (R-010-3)
 *   blank_white    a full `format=gray,signalstats` pass: 0 frames with mean
 *                  luminance < 16 or > 240 (R-010-4)
 *   scene_presence the MP4's chapter track: every scene present, each chapter
 *                  ≥ its narration span − 0.2 s (R-010-5)
 *   caption_safe   the same ASS burned over black, then the four regions outside
 *                  `[54,1026]×[96,1824]` scanned for ink; 0 ink pixels outside,
 *                  and ink inside or the captions never rendered (R-010-6)
 *   duration       rendered length against R-009-3's band (R-010-7)
 *
 * Honest limitation, stated in TECH_DESIGN §6.7 and §12: the safe-area guarantee
 * is deterministic ASS margins plus a text-pixel scan of an isolated caption
 * pass — not per-glyph OCR over the delivered frames. The scan proves no ink
 * fell outside the rectangle for the same ASS, font and geometry that were
 * burned in; it cannot read the glyphs.
 */
import { join } from 'node:path';

import {
  AUDIO_VIDEO_TOLERANCE_S,
  CAPTION_INK_THRESHOLD,
  CAPTION_PRESENT_THRESHOLD,
  DURATION_TOLERANCE_S,
  FPS_TOLERANCE,
  MAX_LUMINANCE,
  MIN_LUMINANCE,
  OUTPUT_FPS,
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  SCENE_PRESENCE_SLACK_S,
} from './constants.js';
import { captionSafeArea } from './captions.js';
import { buildCaptionScanArgs } from './graph.js';
import {
  parseFrameRate,
  parseSeconds,
  parseSignalStats,
  type FfmpegRunner,
  type ProbeResult,
} from './ffmpeg.js';

import type { RenderManifest } from './render.js';

export const CAPTION_SCAN_FILE = 'caption-scan.mp4';

/** Contract `QCCheckSchema` (contract/api.ts) — id/label/pass/measured/expected/requirement. */
export interface QcCheck {
  readonly id: string;
  readonly label: string;
  readonly pass: boolean;
  readonly measured: string;
  readonly expected: string;
  readonly requirement: string;
}

export interface QcMetrics {
  readonly width: number | null;
  readonly height: number | null;
  readonly frame_rate: number | null;
  readonly video_duration_s: number | null;
  readonly audio_duration_s: number | null;
  readonly video_codec: string | null;
  readonly audio_codec: string | null;
  readonly frame_count: number;
  readonly flagged_frames: readonly number[];
  readonly min_luminance: number | null;
  readonly max_luminance: number | null;
  readonly chapter_count: number;
  readonly caption_outside_max: number | null;
  readonly caption_inside_max: number | null;
  readonly target_s: number;
  readonly band_min_s: number;
  readonly band_max_s: number;
}

export interface QcReport {
  readonly status: 'pass' | 'fail';
  readonly checks: readonly QcCheck[];
  readonly metrics: QcMetrics;
  readonly checked_at: string;
}

export interface TimingBand {
  readonly target_s: number;
  readonly tolerance_s: number;
  readonly min_s: number;
  readonly max_s: number;
}

export interface QcInput {
  readonly videoPath: string;
  readonly workDir: string;
  /** The render manifest: duration, scenes and caption count, as recorded. */
  readonly manifest: RenderManifest;
  /** R-009-3's band, computed by B-11's `timingBand()` and carried in the timing plan. */
  readonly band: TimingBand;
  readonly runner: FfmpegRunner;
  readonly now?: Date;
}

export class QcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QcError';
  }
}

/** One full luma pass: mean luminance per decoded frame, full range (0…255). */
export async function scanLuminance(runner: FfmpegRunner, videoPath: string): Promise<number[]> {
  const output = await runner.analyse([
    '-hide_banner',
    '-nostdin',
    '-i',
    videoPath,
    '-vf',
    'format=gray,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
    '-an',
    '-f',
    'null',
    '-',
  ]);
  return parseSignalStats(output, 'lavfi.signalstats.YAVG');
}

export interface ScanRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The four rectangles outside the safe area, plus the safe rectangle itself. */
export function captionScanRegions(): {
  readonly outside: readonly ScanRegion[];
  readonly inside: ScanRegion;
} {
  const safe = captionSafeArea();
  const outside: ScanRegion[] = [
    { x: 0, y: 0, width: safe.left, height: safe.height },
    { x: safe.right, y: 0, width: safe.width - safe.right, height: safe.height },
    { x: 0, y: 0, width: safe.width, height: safe.top },
    { x: 0, y: safe.bottom, width: safe.width, height: safe.height - safe.bottom },
  ];
  return {
    outside,
    inside: {
      x: safe.left,
      y: safe.top,
      width: safe.right - safe.left,
      height: safe.bottom - safe.top,
    },
  };
}

/** The maximum luma value in one crop of one file (0 when the crop is empty). */
export async function scanRegionMax(
  runner: FfmpegRunner,
  file: string,
  region: ScanRegion,
): Promise<number> {
  const output = await runner.analyse([
    '-hide_banner',
    '-nostdin',
    '-i',
    file,
    '-vf',
    `format=gray,crop=${region.width}:${region.height}:${region.x}:${region.y},` +
      'signalstats,metadata=print:key=lavfi.signalstats.YMAX:file=-',
    '-an',
    '-f',
    'null',
    '-',
  ]);
  const values = parseSignalStats(output, 'lavfi.signalstats.YMAX');
  return values.length === 0 ? 0 : Math.max(...values);
}

/**
 * Render the captions over black at the output geometry, then scan the four
 * outside regions and the safe rectangle. Returns the worst outside ink value
 * and the brightest inside value.
 */
export async function scanCaptionSafeArea(
  runner: FfmpegRunner,
  input: { durationMs: number; workDir: string; captionsFileName: string },
): Promise<{ outsideMax: number; insideMax: number }> {
  const scanFile = join(input.workDir, CAPTION_SCAN_FILE);
  const args = buildCaptionScanArgs({
    durationMs: input.durationMs,
    captionsFileName: input.captionsFileName,
    outputFileName: CAPTION_SCAN_FILE,
  });
  const result = await runner.run(args, { cwd: input.workDir });
  if (result.exitCode !== 0) {
    throw new QcError(
      `the caption-isolation pass failed (ffmpeg ${result.exitCode}): ${result.stderrTail
        .slice(-3)
        .join(' | ')}`,
    );
  }

  const regions = captionScanRegions();
  let outsideMax = 0;
  for (const region of regions.outside) {
    outsideMax = Math.max(outsideMax, await scanRegionMax(runner, scanFile, region));
  }
  const insideMax = await scanRegionMax(runner, scanFile, regions.inside);
  return { outsideMax, insideMax };
}

function check(
  id: string,
  label: string,
  requirement: string,
  pass: boolean,
  measured: string,
  expected: string,
): QcCheck {
  return { id, label, requirement, pass, measured, expected };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Read the media geometry and durations out of an ffprobe report. */
export function readProbeFacts(probe: ProbeResult): {
  video: ProbeResult['streams'][number] | null;
  audio: ProbeResult['streams'][number] | null;
  videoDurationS: number | null;
  audioDurationS: number | null;
} {
  const video = probe.streams.find((stream) => stream.codec_type === 'video') ?? null;
  const audio = probe.streams.find((stream) => stream.codec_type === 'audio') ?? null;
  const formatDuration = parseSeconds(probe.format.duration);
  return {
    video,
    audio,
    videoDurationS: parseSeconds(video?.duration) ?? formatDuration,
    audioDurationS: parseSeconds(audio?.duration) ?? formatDuration,
  };
}

/**
 * Run every assertion and return the report. A failed check never throws: the
 * report is the artefact, and the QC stage persists it so the operator can read
 * the number that failed (S-15).
 */
export async function runVideoQc(input: QcInput): Promise<QcReport> {
  const probe = await input.runner.probe(input.videoPath);
  const { video, audio, videoDurationS, audioDurationS } = readProbeFacts(probe);
  const frameRate =
    parseFrameRate(video?.r_frame_rate ?? null) ?? parseFrameRate(video?.avg_frame_rate ?? null);

  const checks: QcCheck[] = [];

  // R-010-2 — geometry, frame rate, codecs.
  const geometryPass =
    video !== null &&
    video.width === OUTPUT_WIDTH &&
    video.height === OUTPUT_HEIGHT &&
    video.codec_name === 'h264' &&
    frameRate !== null &&
    Math.abs(frameRate - OUTPUT_FPS) <= FPS_TOLERANCE &&
    audio !== null &&
    audio.codec_name === 'aac';
  checks.push(
    check(
      'geometry',
      'Geometry & codecs',
      'R-010-2',
      geometryPass,
      `${video?.width ?? '—'}×${video?.height ?? '—'}, ${video?.codec_name ?? 'no video'} + ` +
        `${audio?.codec_name ?? 'no audio'}, ${frameRate === null ? '—' : round2(frameRate)} fps`,
      `${OUTPUT_WIDTH}×${OUTPUT_HEIGHT} H.264 + AAC at ${OUTPUT_FPS} fps (±${FPS_TOLERANCE})`,
    ),
  );

  // R-010-3 — audio present and within 0.5 s of the video.
  const audioGap =
    audioDurationS !== null && videoDurationS !== null
      ? Math.abs(audioDurationS - videoDurationS)
      : null;
  const audioPass =
    audio !== null &&
    audioDurationS !== null &&
    videoDurationS !== null &&
    audioGap !== null &&
    audioGap <= AUDIO_VIDEO_TOLERANCE_S;
  checks.push(
    check(
      'audio',
      'Audio track',
      'R-010-3',
      audioPass,
      audio === null
        ? 'no audio stream'
        : `audio ${round2(audioDurationS ?? NaN)} s vs video ${round2(videoDurationS ?? NaN)} s ` +
            `(Δ ${audioGap === null ? '—' : round2(audioGap)} s)`,
      `audio present, within ±${AUDIO_VIDEO_TOLERANCE_S} s of the video duration`,
    ),
  );

  // R-010-4 — blank/white frame detection over every frame.
  const luminances = await scanLuminance(input.runner, input.videoPath);
  const flagged: number[] = [];
  luminances.forEach((value, index) => {
    if (value < MIN_LUMINANCE || value > MAX_LUMINANCE) flagged.push(index);
  });
  const minLuma = luminances.length === 0 ? null : Math.min(...luminances);
  const maxLuma = luminances.length === 0 ? null : Math.max(...luminances);
  checks.push(
    check(
      'blank_white',
      'Blank / white frames',
      'R-010-4',
      flagged.length === 0 && luminances.length > 0,
      luminances.length === 0
        ? 'no frames decoded'
        : `${luminances.length} frames, mean luma ${round2(minLuma ?? 0)}–${round2(maxLuma ?? 0)}, ` +
            `${flagged.length} flagged${flagged.length === 0 ? '' : ` (first ${flagged.slice(0, 5).join(', ')})`}`,
      `0 frames with mean luminance <${MIN_LUMINANCE} or >${MAX_LUMINANCE}`,
    ),
  );

  // R-010-5 — every scene present, from the MP4's own chapter track.
  const chapters = probe.chapters.map((chapter) => ({
    title: chapter.tags.title ?? '',
    start: parseSeconds(chapter.start_time) ?? 0,
    end: parseSeconds(chapter.end_time) ?? 0,
  }));
  const missingScenes: string[] = [];
  const shortScenes: string[] = [];
  const chapterByTitle = new Map(chapters.map((chapter) => [chapter.title, chapter]));
  for (const planned of input.manifest.scenes) {
    const chapter = chapterByTitle.get(planned.scene_no);
    if (chapter === undefined) {
      missingScenes.push(planned.scene_no);
      continue;
    }
    const chapterDuration = chapter.end - chapter.start;
    const required =
      (planned.narration_end_ms - planned.narration_start_ms) / 1000 - SCENE_PRESENCE_SLACK_S;
    if (chapterDuration + 1e-6 < required) {
      shortScenes.push(`${planned.scene_no} ${round2(chapterDuration)} s < ${round2(required)} s`);
    }
  }
  const scenePass =
    chapters.length === input.manifest.scenes.length &&
    missingScenes.length === 0 &&
    shortScenes.length === 0;
  checks.push(
    check(
      'scene_presence',
      'Scene presence',
      'R-010-5',
      scenePass,
      `${chapters.length}/${input.manifest.scenes.length} chapters` +
        (missingScenes.length > 0 ? `, missing ${missingScenes.join(', ')}` : '') +
        (shortScenes.length > 0 ? `, short: ${shortScenes.join('; ')}` : ''),
      `every scene has a chapter lasting ≥ its narration span − ${SCENE_PRESENCE_SLACK_S} s`,
    ),
  );

  // R-010-6 — caption ink inside the safe area, from an isolated caption pass.
  const captionScan = await scanCaptionSafeArea(input.runner, {
    durationMs: input.manifest.duration_ms,
    workDir: input.workDir,
    captionsFileName: 'captions.ass',
  });
  const noCaptions = input.manifest.captions.cue_count === 0;
  const captionPass = noCaptions
    ? captionScan.outsideMax <= CAPTION_INK_THRESHOLD
    : captionScan.outsideMax <= CAPTION_INK_THRESHOLD &&
      captionScan.insideMax >= CAPTION_PRESENT_THRESHOLD;
  checks.push(
    check(
      'caption_safe_area',
      'Caption safe area',
      'R-010-6',
      captionPass,
      noCaptions
        ? 'no caption cues (vacuously inside)'
        : `max ink outside ${captionScan.outsideMax}, max ink inside ${captionScan.insideMax} ` +
            `(${input.manifest.captions.cue_count} cues)`,
      `0 ink outside [54,1026]×[96,1824]; ink present inside`,
    ),
  );

  // R-010-7 — rendered duration meets R-009-3.
  const renderedS = videoDurationS;
  const bandPass =
    renderedS !== null &&
    Math.abs(renderedS - input.manifest.duration_ms / 1000) <= DURATION_TOLERANCE_S &&
    renderedS >= input.band.min_s &&
    renderedS <= input.band.max_s;
  checks.push(
    check(
      'duration',
      'Rendered duration',
      'R-010-7',
      bandPass,
      `${renderedS === null ? '—' : round2(renderedS)} s vs plan ` +
        `${round2(input.manifest.duration_ms / 1000)} s, band ${input.band.min_s}–${input.band.max_s} s ` +
        `(target ${input.band.target_s} s)`,
      `rendered length within ${DURATION_TOLERANCE_S} s of the plan and inside R-009-3's band`,
    ),
  );

  const metrics: QcMetrics = {
    width: video?.width ?? null,
    height: video?.height ?? null,
    frame_rate: frameRate === null ? null : round2(frameRate),
    video_duration_s: videoDurationS === null ? null : round2(videoDurationS),
    audio_duration_s: audioDurationS === null ? null : round2(audioDurationS),
    video_codec: video?.codec_name ?? null,
    audio_codec: audio?.codec_name ?? null,
    frame_count: luminances.length,
    flagged_frames: flagged,
    min_luminance: minLuma === null ? null : round2(minLuma),
    max_luminance: maxLuma === null ? null : round2(maxLuma),
    chapter_count: chapters.length,
    caption_outside_max: captionScan.outsideMax,
    caption_inside_max: captionScan.insideMax,
    target_s: input.band.target_s,
    band_min_s: input.band.min_s,
    band_max_s: input.band.max_s,
  };

  return {
    status: checks.every((entry) => entry.pass) ? 'pass' : 'fail',
    checks,
    metrics,
    checked_at: (input.now ?? new Date()).toISOString(),
  };
}
