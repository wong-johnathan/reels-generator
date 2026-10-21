/**
 * The render plan — narration spans → clip, transition and chapter geometry
 * (TECH_DESIGN §6.2/§6.3, R-010-1/5/7).
 *
 * Everything downstream (the filter graph, the chapter track, the QC
 * assertions, the benchmark) reads this one plan, in **frames**, because frames
 * are what the encoder actually produces. Milliseconds are derived for display
 * only; deriving offsets independently in ms and frames is how a render ends up
 * out of sync with its own captions.
 *
 * Two rules make R-010-5 mechanical:
 *
 * 1. A scene's visible window runs from its start to the **next** scene's start,
 *    so a pause between two scenes stays on the outgoing scene instead of
 *    becoming a hole. B-11's spans are word-anchored and need not be contiguous
 *    (speech has gaps); a gap is not an error, an overlap is.
 * 2. A scene's clip is longer than its visible window by the outgoing transition,
 *    and the chapter track runs from clip start to the next clip's start. A
 *    chapter therefore lasts exactly the scene's visible time, and QC can
 *    assert the delivered MP4's chapters against the narration spans without
 *    trusting the render manifest.
 */
import {
  MIN_TRANSITION_SCENE_S,
  OUTPUT_FPS,
  OUTPUT_HEIGHT,
  OUTPUT_WIDTH,
  TRANSITION_S,
} from './constants.js';
import { CAMERA_MOVES, type CameraMove } from '../shared/states.js';

export interface RenderSceneSource {
  readonly sceneNo: string;
  /** 1-based storyboard position; the render order. */
  readonly position: number;
  readonly cameraMove: CameraMove | null;
  /** File name inside the render work directory. */
  readonly imageFileName: string;
  /** Narration-relative span from the timing document (B-11). */
  readonly narrationStartMs: number;
  readonly narrationEndMs: number;
}

export interface PlannedScene {
  readonly sceneNo: string;
  readonly position: number;
  readonly cameraMove: CameraMove;
  readonly imageFileName: string;
  readonly narrationStartMs: number;
  readonly narrationEndMs: number;
  /** The window this scene owns on screen (to the next scene's start). */
  readonly visibleMs: number;
  /** Clip length handed to zoompan: visible + the outgoing transition. */
  readonly clipMs: number;
  readonly transitionMs: number;
  readonly transitionFrames: number;
  readonly frameCount: number;
  /** Output frame index where this clip starts. */
  readonly startFrame: number;
  readonly endFrame: number;
  readonly startMs: number;
  readonly endMs: number;
  /** True when the scene was too short for a crossfade (§6.3). */
  readonly transitionDowngraded: boolean;
}

export interface RenderChapter {
  readonly sceneNo: string;
  readonly position: number;
  readonly title: string;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly startMs: number;
  readonly endMs: number;
}

export interface RenderPlan {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly transitionMs: number;
  readonly leadMs: number;
  readonly trailMs: number;
  /** Total output length: lead + narration + trail. */
  readonly durationMs: number;
  readonly totalFrames: number;
  readonly scenes: readonly PlannedScene[];
  readonly chapters: readonly RenderChapter[];
}

export interface BuildRenderPlanInput {
  readonly scenes: readonly RenderSceneSource[];
  /** §6.5: silence before the first word and after the last. */
  readonly leadS: number;
  readonly trailS: number;
  readonly transitionS?: number;
  readonly fps?: number;
  readonly width?: number;
  readonly height?: number;
}

export class RenderPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderPlanError';
  }
}

function assertCameraMove(value: CameraMove | null, sceneNo: string): CameraMove {
  if (value === null || value === undefined) return 'static';
  if (!(CAMERA_MOVES as readonly string[]).includes(value)) {
    throw new RenderPlanError(
      `scene ${sceneNo} has camera_move "${String(value)}"; the schema admits ${CAMERA_MOVES.join('|')}`,
    );
  }
  return value;
}

/**
 * Build the plan. Scenes must be ordered, non-overlapping and carry a non-empty
 * narration span; gaps between scenes are pauses and are closed forward. An
 * overlap means two scenes claim the same speech, which the storyboard and the
 * timing document cannot both be right about — the render refuses.
 */
export function buildRenderPlan(input: BuildRenderPlanInput): RenderPlan {
  const fps = input.fps ?? OUTPUT_FPS;
  const width = input.width ?? OUTPUT_WIDTH;
  const height = input.height ?? OUTPUT_HEIGHT;
  const transitionS = input.transitionS ?? TRANSITION_S;

  if (!Number.isFinite(fps) || fps <= 0) throw new RenderPlanError('fps must be positive');
  if (input.scenes.length === 0) throw new RenderPlanError('a render needs at least one scene');
  if (!(input.leadS >= 0) || !(input.trailS >= 0)) {
    throw new RenderPlanError('lead_s and trail_s must be >= 0');
  }
  if (!(transitionS >= 0)) throw new RenderPlanError('transition duration must be >= 0');

  const ordered = [...input.scenes].sort((left, right) => left.position - right.position);
  const seenPositions = new Set<number>();
  const seenScenes = new Set<string>();
  let previous: RenderSceneSource | null = null;

  for (const scene of ordered) {
    if (seenPositions.has(scene.position)) {
      throw new RenderPlanError(`position ${scene.position} appears twice in the scene plan`);
    }
    if (seenScenes.has(scene.sceneNo)) {
      throw new RenderPlanError(`scene ${scene.sceneNo} appears twice in the scene plan`);
    }
    seenPositions.add(scene.position);
    seenScenes.add(scene.sceneNo);

    const { narrationStartMs, narrationEndMs } = scene;
    if (!Number.isFinite(narrationStartMs) || !Number.isFinite(narrationEndMs)) {
      throw new RenderPlanError(`scene ${scene.sceneNo} has a non-finite narration span`);
    }
    if (narrationStartMs < 0) {
      throw new RenderPlanError(`scene ${scene.sceneNo} starts before zero`);
    }
    if (narrationEndMs <= narrationStartMs) {
      throw new RenderPlanError(
        `scene ${scene.sceneNo} has an empty narration span (${narrationStartMs}–${narrationEndMs} ms)`,
      );
    }
    if (previous !== null) {
      if (narrationStartMs < previous.narrationStartMs) {
        throw new RenderPlanError(
          `scene ${scene.sceneNo} starts at ${narrationStartMs} ms, before scene ${previous.sceneNo} ` +
            `at ${previous.narrationStartMs} ms: the positions and the narration disagree`,
        );
      }
      if (narrationStartMs < previous.narrationEndMs) {
        throw new RenderPlanError(
          `scene ${scene.sceneNo} starts at ${narrationStartMs} ms but scene ${previous.sceneNo} ` +
            `ends at ${previous.narrationEndMs} ms: the narration spans overlap`,
        );
      }
    }
    previous = scene;
  }

  const transitionFrames = Math.round(transitionS * fps);
  const leadFrames = Math.round(input.leadS * fps);
  const trailFrames = Math.round(input.trailS * fps);

  const scenes: PlannedScene[] = [];
  let startFrame = 0;

  ordered.forEach((scene, index) => {
    const isLast = index === ordered.length - 1;
    const next = ordered[index + 1];
    // Scene 0 owns the pause before the first word; every other scene starts
    // where its first word starts. A scene ends where the next one starts.
    const windowStartMs = index === 0 ? 0 : scene.narrationStartMs;
    const windowEndMs = next === undefined ? scene.narrationEndMs : next.narrationStartMs;
    const windowMs = windowEndMs - windowStartMs;
    if (windowMs <= 0) {
      throw new RenderPlanError(
        `scene ${scene.sceneNo} owns an empty window (${windowStartMs}–${windowEndMs} ms)`,
      );
    }

    const visibleFrames = Math.max(1, Math.round((windowMs * fps) / 1000));
    const visibleMs = Math.round((visibleFrames * 1000) / fps);
    const visibleS = visibleFrames / fps;

    const wantsTransition = !isLast && transitionFrames > 0;
    const transitionDowngraded = wantsTransition && visibleS < MIN_TRANSITION_SCENE_S;
    // §6.3: too short for a crossfade → a hard cut. The plan keeps a one-frame
    // boundary so there is exactly one code path (see graph.ts).
    const boundaryFrames = wantsTransition ? (transitionDowngraded ? 1 : transitionFrames) : 0;

    const padFrames = (index === 0 ? leadFrames : 0) + (isLast ? trailFrames : 0);
    const frameCount = Math.max(1, visibleFrames + boundaryFrames + padFrames);
    const endFrame = startFrame + frameCount;

    scenes.push({
      sceneNo: scene.sceneNo,
      position: scene.position,
      cameraMove: assertCameraMove(scene.cameraMove, scene.sceneNo),
      imageFileName: scene.imageFileName,
      narrationStartMs: scene.narrationStartMs,
      narrationEndMs: scene.narrationEndMs,
      visibleMs,
      clipMs: Math.round((frameCount * 1000) / fps),
      transitionMs: Math.round((boundaryFrames * 1000) / fps),
      transitionFrames: boundaryFrames,
      frameCount,
      startFrame,
      endFrame,
      startMs: Math.round((startFrame * 1000) / fps),
      endMs: Math.round((endFrame * 1000) / fps),
      transitionDowngraded,
    });

    // The next clip starts where this one's crossfade begins.
    startFrame = endFrame - boundaryFrames;
  });

  const last = scenes[scenes.length - 1]!;
  const totalFrames = last.endFrame;

  const chapters: RenderChapter[] = scenes.map((scene, index) => {
    const next = scenes[index + 1];
    const chapterEndFrame = next === undefined ? totalFrames : next.startFrame;
    return {
      sceneNo: scene.sceneNo,
      position: scene.position,
      title: scene.sceneNo,
      startFrame: scene.startFrame,
      endFrame: chapterEndFrame,
      startMs: Math.round((scene.startFrame * 1000) / fps),
      endMs: Math.round((chapterEndFrame * 1000) / fps),
    };
  });

  return {
    width,
    height,
    fps,
    transitionMs: Math.round((transitionFrames * 1000) / fps),
    leadMs: Math.round((leadFrames * 1000) / fps),
    trailMs: Math.round((trailFrames * 1000) / fps),
    durationMs: Math.round((totalFrames * 1000) / fps),
    totalFrames,
    scenes,
    chapters,
  };
}

/** `1.457` — seconds, three decimals, for ffmpeg filter arguments. */
export function seconds(value: number): string {
  return (Math.round(value * 1000) / 1000).toFixed(3);
}

/** The ffmetadata chapter block (§6.3/§8: the MP4 carries one chapter per scene). */
export function buildChapterMetadata(plan: RenderPlan): string {
  const blocks = plan.chapters.map((chapter) => {
    return [
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      `START=${chapter.startMs}`,
      `END=${chapter.endMs}`,
      `title=${chapter.title}`,
    ].join('\n');
  });
  return [';FFMETADATA1', ...blocks].join('\n') + '\n';
}
