/**
 * One render — write the artefacts, run FFmpeg once, report what it cost
 * (TECH_DESIGN §6, §6.8).
 *
 * `renderVideo` is deliberately storage- and database-free: it takes a finished
 * plan, a working directory, the narration file and the caption documents. The
 * RE stage (`stage.ts`) resolves inputs from Postgres and the blob store and
 * persists the result; the benchmark CLI and the tests call this directly. That
 * split is what lets the pipeline be exercised with real FFmpeg and synthetic
 * media without a database.
 *
 * Outputs inside `workDir`:
 *   images (named by the plan) · narration · captions.ass/.srt/.vtt ·
 *   chapters.txt · output.mp4
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AUDIO_BITRATE_KBPS,
  OUTPUT_FPS,
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  RENDER_TIMEOUT_MS,
  X264_CRF,
  X264_PRESET,
} from './constants.js';
import type { CaptionDocuments } from './captions.js';
import { buildFfmpegArgs } from './graph.js';
import type { FfmpegRunner, RenderProgress } from './ffmpeg.js';
import { buildChapterMetadata, type RenderPlan } from './plan.js';

export const RENDER_MANIFEST_SCHEMA_VERSION = 'render-manifest.v1';

export interface RenderManifestScene {
  readonly scene_no: string;
  readonly position: number;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly visible_ms: number;
  readonly narration_start_ms: number;
  readonly narration_end_ms: number;
  readonly camera_move: string;
  readonly frame_count: number;
  readonly transition_frames: number;
  readonly transition_downgraded: boolean;
  readonly asset_id: string | null;
}

/**
 * The render manifest is the bridge between the MP4 and the QC assertions: it
 * records what was asked for (spans, offsets, chapters), while QC reads the
 * delivered file back. A mismatch between the two is the failure mode worth
 * catching, so QC never trusts this document alone.
 */
export interface RenderManifest {
  readonly schema_version: typeof RENDER_MANIFEST_SCHEMA_VERSION;
  readonly project_id: string | null;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly duration_ms: number;
  readonly total_frames: number;
  readonly transition_ms: number;
  readonly lead_ms: number;
  readonly trail_ms: number;
  readonly scenes: readonly RenderManifestScene[];
  /**
   * R-009-3's band, carried from the timing document. QC's duration check reads
   * this rather than recomputing it, so the band the operator saw is the band
   * that was asserted.
   */
  readonly band: {
    readonly target_s: number;
    readonly tolerance_s: number;
    readonly min_s: number;
    readonly max_s: number;
  } | null;
  readonly captions: { readonly cue_count: number; readonly style: string };
  readonly encoder: {
    readonly video: string;
    readonly preset: string;
    readonly crf: number;
    readonly audio: string;
    readonly audio_bitrate_kbps: number;
  };
  readonly generated_at: string;
}

export const CAPTIONS_ASS_FILE = 'captions.ass';
export const CAPTIONS_SRT_FILE = 'captions.srt';
export const CAPTIONS_VTT_FILE = 'captions.vtt';
export const CHAPTERS_FILE = 'chapters.txt';
export const RENDERED_VIDEO_FILE = 'output.mp4';

export interface RenderVideoInput {
  readonly plan: RenderPlan;
  readonly workDir: string;
  /** File name of the narration audio inside `workDir`. */
  readonly narrationFileName: string;
  readonly captions: CaptionDocuments;
  /** How many cues the caption documents contain (recorded in the manifest). */
  readonly captionCueCount: number;
  readonly runner: FfmpegRunner;
  readonly projectId?: string | null;
  readonly band?: RenderManifest['band'];
  /** `scene_no → asset id`, recorded in the manifest for provenance. */
  readonly sceneAssetIds?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly now?: Date;
  readonly onProgress?: (progress: RenderProgress) => void;
}

export interface RenderVideoResult {
  readonly videoFile: string;
  readonly videoPath: string;
  readonly captions: {
    readonly assPath: string;
    readonly srtPath: string;
    readonly vttPath: string;
  };
  readonly chaptersPath: string;
  readonly manifest: RenderManifest;
  readonly wallTimeMs: number;
  readonly peakRssKb: number | null;
  readonly stderrTail: readonly string[];
}

export class RenderError extends Error {
  constructor(
    message: string,
    readonly stderrTail: readonly string[] = [],
  ) {
    super(message);
    this.name = 'RenderError';
  }
}

/** Write the plan's side artefacts into the work directory. */
export function writeRenderArtefacts(
  workDir: string,
  plan: RenderPlan,
  captions: CaptionDocuments,
): {
  readonly assPath: string;
  readonly srtPath: string;
  readonly vttPath: string;
  readonly chaptersPath: string;
} {
  const assPath = join(workDir, CAPTIONS_ASS_FILE);
  const srtPath = join(workDir, CAPTIONS_SRT_FILE);
  const vttPath = join(workDir, CAPTIONS_VTT_FILE);
  const chaptersPath = join(workDir, CHAPTERS_FILE);
  writeFileSync(assPath, captions.ass, 'utf8');
  writeFileSync(srtPath, captions.srt, 'utf8');
  writeFileSync(vttPath, captions.vtt, 'utf8');
  writeFileSync(chaptersPath, buildChapterMetadata(plan), 'utf8');
  return { assPath, srtPath, vttPath, chaptersPath };
}

export function buildRenderManifest(input: {
  plan: RenderPlan;
  captionCueCount: number;
  projectId?: string | null;
  band?: RenderManifest['band'];
  sceneAssetIds?: Readonly<Record<string, string>>;
  now?: Date;
}): RenderManifest {
  const { plan } = input;
  return {
    schema_version: RENDER_MANIFEST_SCHEMA_VERSION,
    project_id: input.projectId ?? null,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    duration_ms: plan.durationMs,
    total_frames: plan.totalFrames,
    transition_ms: plan.transitionMs,
    lead_ms: plan.leadMs,
    trail_ms: plan.trailMs,
    scenes: plan.scenes.map((scene) => ({
      scene_no: scene.sceneNo,
      position: scene.position,
      start_ms: scene.startMs,
      end_ms: scene.endMs,
      visible_ms: scene.visibleMs,
      narration_start_ms: scene.narrationStartMs,
      narration_end_ms: scene.narrationEndMs,
      camera_move: scene.cameraMove,
      frame_count: scene.frameCount,
      transition_frames: scene.transitionFrames,
      transition_downgraded: scene.transitionDowngraded,
      asset_id: input.sceneAssetIds?.[scene.sceneNo] ?? null,
    })),
    captions: { cue_count: input.captionCueCount, style: 'ReelsCaption' },
    encoder: {
      video: 'libx264',
      preset: X264_PRESET,
      crf: X264_CRF,
      audio: 'aac',
      audio_bitrate_kbps: AUDIO_BITRATE_KBPS,
    },
    band: input.band ?? null,
    generated_at: (input.now ?? new Date()).toISOString(),
  };
}

/**
 * Run the render. The caller owns `workDir` (it writes the scene images and the
 * narration there before calling); this function adds the caption/chapter
 * artefacts, spawns FFmpeg with `cwd = workDir`, and fails loudly on a non-zero
 * exit or a missing output.
 */
export async function renderVideo(input: RenderVideoInput): Promise<RenderVideoResult> {
  const { plan, workDir, runner } = input;
  if (!existsSync(workDir)) {
    throw new RenderError(`render work directory ${workDir} does not exist`);
  }

  const artefacts = writeRenderArtefacts(workDir, plan, input.captions);
  const { args } = buildFfmpegArgs({
    plan,
    imageFileNames: plan.scenes.map((scene) => scene.imageFileName),
    narrationFileName: input.narrationFileName,
    captionsFileName: CAPTIONS_ASS_FILE,
    chaptersFileName: CHAPTERS_FILE,
    outputFileName: RENDERED_VIDEO_FILE,
  });

  const result = await runner.run(args, {
    cwd: workDir,
    timeoutMs: input.timeoutMs ?? RENDER_TIMEOUT_MS,
    onProgress: input.onProgress,
  });

  if (result.timedOut) {
    throw new RenderError(
      `render exceeded its ${(input.timeoutMs ?? RENDER_TIMEOUT_MS) / 1000} s ceiling and was killed (§6.8)`,
      result.stderrTail,
    );
  }
  if (result.exitCode !== 0) {
    throw new RenderError(
      `ffmpeg exited ${result.exitCode}: ${result.stderrTail.slice(-4).join(' | ')}`,
      result.stderrTail,
    );
  }

  const videoPath = join(workDir, RENDERED_VIDEO_FILE);
  if (!existsSync(videoPath)) {
    throw new RenderError(`ffmpeg exited 0 but wrote no ${RENDERED_VIDEO_FILE}`, result.stderrTail);
  }

  return {
    videoFile: RENDERED_VIDEO_FILE,
    videoPath,
    captions: {
      assPath: artefacts.assPath,
      srtPath: artefacts.srtPath,
      vttPath: artefacts.vttPath,
    },
    chaptersPath: artefacts.chaptersPath,
    manifest: buildRenderManifest({
      plan,
      captionCueCount: input.captionCueCount,
      projectId: input.projectId,
      band: input.band,
      now: input.now,
    }),
    wallTimeMs: result.wallTimeMs,
    peakRssKb: result.peakRssKb,
    stderrTail: result.stderrTail,
  };
}

export { OUTPUT_FPS, OUTPUT_HEIGHT, OUTPUT_WIDTH };
