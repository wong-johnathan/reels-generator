/**
 * The FFmpeg filter graph and argument vector — TECH_DESIGN §6.1–§6.6.
 *
 * Pure functions only: the graph is a string, the command is an array, and both
 * are asserted in tests without spawning anything. The values are the design's:
 *
 *   cover-scale + centre-crop  scale=1080:1920:force_original_aspect_ratio=increase
 *                              :flags=lanczos,crop=1080:1920:(iw-1080)/2:(ih-1920)/2
 *   conservative sharpening   unsharp=5:5:0.5:5:5:0.0
 *   Ken Burns                 zoompan at d = the scene's exact frame count
 *   transitions               xfade, offset = the next clip's start frame
 *   captions                  one subtitles= burn-in of the same ASS the
 *                             .srt/.vtt are derived from
 *   audio                     narration + adelay(lead/trail) + apad + a muted
 *                             anullsrc mixed via amix (the music slot, Q2 default)
 *   encoder                   libx264 medium crf 20 yuv420p @30, AAC 128k stereo
 *
 * The graph is one `filter_complex` string with no shell involved: ffmpeg is
 * spawned with an argv array, so only FFmpeg's own filtergraph escaping applies.
 * That escaping is the `\,` inside expression option values — a raw comma would
 * end the filter.
 */
import {
  AUDIO_BITRATE_KBPS,
  AUDIO_CHANNELS,
  AUDIO_SAMPLE_RATE,
  OUTPUT_FPS,
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  X264_CRF,
  X264_PRESET,
} from './constants.js';
import { seconds, type PlannedScene, type RenderPlan } from './plan.js';
import type { CameraMove } from '../shared/states.js';

/** Cover-scale, centre-crop 1.406x — §6.1. */
export const SCALE_CROP_FILTER =
  `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos,` +
  `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(iw-${OUTPUT_WIDTH})/2:(ih-${OUTPUT_HEIGHT})/2`;

/** Conservative sharpening after the upscale — §6.1. */
export const UNSHARP_FILTER = 'unsharp=5:5:0.5:5:5:0.0';

/** The zoompan expression per `scene.camera_move` — §6.2. Amplitude ≤ 1.2x. */
export function zoompanExpression(cameraMove: CameraMove): {
  readonly z: string;
  readonly x: string;
  readonly y: string;
} {
  const centredX = 'iw/2-(iw/zoom/2)';
  const centredY = 'ih/2-(ih/zoom/2)';
  switch (cameraMove) {
    case 'zoom_in':
      return { z: 'min(zoom+0.0006,1.20)', x: centredX, y: centredY };
    case 'zoom_out':
      return { z: 'if(eq(on,0),1.20,max(zoom-0.0006,1.0))', x: centredX, y: centredY };
    case 'pan_l':
      return { z: '1.05', x: `(iw-iw/zoom)*(1-on/max(duration-1,1))`, y: centredY };
    case 'pan_r':
      return { z: '1.05', x: `(iw-iw/zoom)*(on/max(duration-1,1))`, y: centredY };
    case 'static':
      return { z: '1.0', x: centredX, y: centredY };
  }
}

/** Escape the commas inside a filter option expression. */
function escapeExpression(expression: string): string {
  return expression.replace(/,/g, '\\,');
}

/** One scene's chain: still image → 1080x1920 clip of exactly `frameCount` frames. */
export function buildSceneFilter(scene: PlannedScene, inputIndex: number): string {
  const move = zoompanExpression(scene.cameraMove);
  const zoompan =
    `zoompan=z='${escapeExpression(move.z)}'` +
    `:x='${escapeExpression(move.x)}'` +
    `:y='${escapeExpression(move.y)}'` +
    `:d=${scene.frameCount}:s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:fps=${OUTPUT_FPS}`;
  return (
    `[${inputIndex}:v]${SCALE_CROP_FILTER},${UNSHARP_FILTER},${zoompan},` +
    `format=yuv420p,settb=AVTB,setpts=N/(${OUTPUT_FPS}*TB),fps=${OUTPUT_FPS}[v${inputIndex}]`
  );
}

export interface AudioGraphInput {
  /** Input index of the narration audio file. */
  readonly narrationInputIndex: number;
  /** Input index of the silent `anullsrc` that stands in for music (Q2). */
  readonly musicInputIndex: number;
  readonly leadMs: number;
  readonly durationMs: number;
}

/** §6.5: narration delayed by the lead, padded to the video length, mixed with silence. */
export function buildAudioGraph(input: AudioGraphInput): string[] {
  const duration = seconds(input.durationMs / 1000);
  return [
    `[${input.narrationInputIndex}:a]aformat=sample_fmts=fltp:channel_layouts=stereo,` +
      `adelay=${input.leadMs}|${input.leadMs},apad,atrim=0:${duration},` +
      `aresample=${AUDIO_SAMPLE_RATE}[narration]`,
    `[${input.musicInputIndex}:a]atrim=0:${duration},volume=0[music]`,
    '[narration][music]amix=inputs=2:duration=first:normalize=0[aout]',
  ];
}

export interface FilterGraphInput {
  readonly plan: RenderPlan;
  /** Name of the ASS file, relative to the ffmpeg working directory. */
  readonly captionsFileName: string;
  readonly narrationInputIndex: number;
  readonly musicInputIndex: number;
}

/** The complete `filter_complex` string. */
export function buildFilterGraph(input: FilterGraphInput): string {
  const { plan } = input;
  const parts: string[] = plan.scenes.map((scene, index) => buildSceneFilter(scene, index));

  let lastLabel = 'v0';
  if (plan.transitionMs === 0) {
    // No transitions at all: hard cuts via concat. The plan's clips already
    // butt up against each other, so the concatenation is the timeline.
    const inputs = plan.scenes.map((_, index) => `[v${index}]`).join('');
    parts.push(`${inputs}concat=n=${plan.scenes.length}:v=1:a=0[cut]`);
    lastLabel = 'cut';
  } else {
    for (let index = 1; index < plan.scenes.length; index += 1) {
      const scene = plan.scenes[index]!;
      const previousScene = plan.scenes[index - 1]!;
      const previous = index === 1 ? 'v0' : `x${index - 1}`;
      const offset = seconds(scene.startFrame / plan.fps);
      // The boundary belongs to the outgoing scene: it is that clip's extra
      // length, and it is where the incoming clip starts.
      const duration = seconds(previousScene.transitionFrames / plan.fps);
      parts.push(
        `[${previous}][v${index}]xfade=transition=fade:duration=${duration}:offset=${offset}[x${index}]`,
      );
      lastLabel = `x${index}`;
    }
  }
  parts.push(`[${lastLabel}]subtitles=filename=${input.captionsFileName}[vout]`);
  parts.push(
    ...buildAudioGraph({
      narrationInputIndex: input.narrationInputIndex,
      musicInputIndex: input.musicInputIndex,
      leadMs: plan.leadMs,
      durationMs: plan.durationMs,
    }),
  );
  return parts.join(';');
}

export interface FfmpegArgsInput {
  readonly plan: RenderPlan;
  readonly imageFileNames: readonly string[];
  readonly narrationFileName: string;
  readonly captionsFileName: string;
  readonly chaptersFileName: string;
  readonly outputFileName: string;
}

export interface FfmpegArgs {
  readonly args: readonly string[];
  readonly narrationInputIndex: number;
  readonly musicInputIndex: number;
  readonly metadataInputIndex: number;
}

/**
 * The argv for one render. Input order is load-bearing:
 * `0…n-1` scene images, `n` narration, `n+1` the silent music source,
 * `n+2` the chapter metadata.
 */
export function buildFfmpegArgs(input: FfmpegArgsInput): FfmpegArgs {
  const { plan } = input;
  if (input.imageFileNames.length !== plan.scenes.length) {
    throw new RangeError(
      `the render plan has ${plan.scenes.length} scenes but ${input.imageFileNames.length} images were supplied`,
    );
  }
  const narrationInputIndex = plan.scenes.length;
  const musicInputIndex = narrationInputIndex + 1;
  const metadataInputIndex = musicInputIndex + 1;

  const graph = buildFilterGraph({
    plan,
    captionsFileName: input.captionsFileName,
    narrationInputIndex,
    musicInputIndex,
  });

  const args: string[] = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats'];
  for (const imageFileName of input.imageFileNames) args.push('-i', imageFileName);
  args.push('-i', input.narrationFileName);
  args.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_SAMPLE_RATE}`);
  args.push('-f', 'ffmetadata', '-i', input.chaptersFileName);
  args.push('-filter_complex', graph);
  args.push('-map', '[vout]', '-map', '[aout]');
  args.push('-map_metadata', String(metadataInputIndex));
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    X264_PRESET,
    '-crf',
    String(X264_CRF),
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(OUTPUT_FPS),
    '-s',
    `${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}`,
  );
  args.push('-c:a', 'aac', '-b:a', `${AUDIO_BITRATE_KBPS}k`, '-ac', String(AUDIO_CHANNELS));
  args.push('-movflags', '+faststart');
  args.push('-t', seconds(plan.durationMs / 1000));
  args.push(input.outputFileName);

  return { args, narrationInputIndex, musicInputIndex, metadataInputIndex };
}

/** The caption-isolation pass used by the safe-area scan (§6.7). */
export interface CaptionScanArgsInput {
  readonly durationMs: number;
  readonly captionsFileName: string;
  readonly outputFileName: string;
}

/**
 * Burn the captions over black at the output geometry and frame rate, so any
 * bright pixel is caption ink and nothing else. Encoded with `-preset ultrafast`
 * because this artefact is scanned, never delivered.
 */
export function buildCaptionScanArgs(input: CaptionScanArgsInput): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:r=${OUTPUT_FPS}:d=${seconds(
      input.durationMs / 1000,
    )}`,
    '-vf',
    `subtitles=filename=${input.captionsFileName},format=yuv420p`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(OUTPUT_FPS),
    '-t',
    seconds(input.durationMs / 1000),
    input.outputFileName,
  ];
}
