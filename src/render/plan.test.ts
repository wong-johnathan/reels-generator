import { describe, expect, it } from 'vitest';

import {
  buildChapterMetadata,
  buildRenderPlan,
  RenderPlanError,
  seconds,
  type RenderSceneSource,
} from './plan.js';

const THREE_SCENES: RenderSceneSource[] = [
  {
    sceneNo: 'S01',
    position: 1,
    cameraMove: 'zoom_in',
    imageFileName: 'img-1.png',
    narrationStartMs: 0,
    narrationEndMs: 2000,
  },
  {
    sceneNo: 'S02',
    position: 2,
    cameraMove: 'pan_r',
    imageFileName: 'img-2.png',
    narrationStartMs: 2000,
    narrationEndMs: 4500,
  },
  {
    sceneNo: 'S03',
    position: 3,
    cameraMove: 'static',
    imageFileName: 'img-3.png',
    narrationStartMs: 4500,
    narrationEndMs: 7600,
  },
];

describe('buildRenderPlan', () => {
  it('lays the scenes end to end with lead and trail on the outer clips', () => {
    const plan = buildRenderPlan({ scenes: THREE_SCENES, leadS: 0.5, trailS: 0.5 });
    expect(plan.transitionMs).toBe(300);
    expect(plan.leadMs).toBe(500);
    expect(plan.trailMs).toBe(500);
    // 2.0 + 2.5 + 3.1 s of narration + 1 s lead/trail — one frame per boundary
    // is absorbed by the crossfade overlap, so the total is the audio length.
    expect(plan.totalFrames).toBe(258);
    expect(plan.durationMs).toBe(8600);
    expect(plan.scenes.map((scene) => scene.frameCount)).toEqual([84, 84, 108]);
    expect(plan.scenes.map((scene) => scene.startFrame)).toEqual([0, 75, 150]);
  });

  it('gives each scene a chapter that lasts its visible narration time', () => {
    const plan = buildRenderPlan({ scenes: THREE_SCENES, leadS: 0.5, trailS: 0.5 });
    const chapters = plan.chapters;
    expect(chapters).toHaveLength(3);
    expect(chapters.map((chapter) => chapter.title)).toEqual(['S01', 'S02', 'S03']);
    // S01 owns the lead, S03 owns the trail; every chapter still covers its span.
    expect(chapters[0]!.endMs - chapters[0]!.startMs).toBeGreaterThanOrEqual(2000);
    expect(chapters[1]!.endMs - chapters[1]!.startMs).toBe(2500);
    expect(chapters[2]!.endMs - chapters[2]!.startMs).toBeGreaterThanOrEqual(3100);
    expect(chapters[2]!.endFrame).toBe(plan.totalFrames);
  });

  it('closes a pause forward instead of leaving a hole', () => {
    const plan = buildRenderPlan({
      scenes: [
        { ...THREE_SCENES[0]!, narrationEndMs: 1000 },
        { ...THREE_SCENES[1]!, narrationStartMs: 1300, narrationEndMs: 2000 },
      ],
      leadS: 0.5,
      trailS: 0.5,
    });
    expect(plan.scenes[0]!.visibleMs).toBe(1300);
    expect(plan.scenes[1]!.visibleMs).toBe(700);
    expect(plan.durationMs).toBe(3000);
  });

  it('refuses overlapping narration spans', () => {
    expect(() =>
      buildRenderPlan({
        scenes: [{ ...THREE_SCENES[0]!, narrationEndMs: 2500 }, THREE_SCENES[1]!],
        leadS: 0.5,
        trailS: 0.5,
      }),
    ).toThrow(/overlap/);
  });

  it('refuses duplicate positions, duplicate scene numbers, empty spans and an empty plan', () => {
    expect(() => buildRenderPlan({ scenes: [], leadS: 0.5, trailS: 0.5 })).toThrow(RenderPlanError);
    expect(() =>
      buildRenderPlan({
        scenes: [{ ...THREE_SCENES[0]!, narrationEndMs: 0 }],
        leadS: 0.5,
        trailS: 0.5,
      }),
    ).toThrow(/empty narration span/);
    expect(() =>
      buildRenderPlan({
        scenes: [THREE_SCENES[0]!, { ...THREE_SCENES[1]!, position: 1 }],
        leadS: 0.5,
        trailS: 0.5,
      }),
    ).toThrow(/position 1 appears twice/);
    expect(() =>
      buildRenderPlan({
        scenes: [THREE_SCENES[0]!, { ...THREE_SCENES[1]!, sceneNo: 'S01' }],
        leadS: 0.5,
        trailS: 0.5,
      }),
    ).toThrow(/S01 appears twice/);
  });

  it('downgrades a scene shorter than 0.6 s to a hard cut (§6.3)', () => {
    const plan = buildRenderPlan({
      scenes: [
        { ...THREE_SCENES[0]!, narrationEndMs: 400 },
        { ...THREE_SCENES[1]!, narrationStartMs: 400, narrationEndMs: 2400 },
      ],
      leadS: 0,
      trailS: 0,
    });
    expect(plan.scenes[0]!.transitionDowngraded).toBe(true);
    expect(plan.scenes[0]!.transitionFrames).toBe(1);
    expect(plan.scenes[1]!.transitionFrames).toBe(0);
  });

  it('uses no transitions at all when transitionS is 0', () => {
    const plan = buildRenderPlan({ scenes: THREE_SCENES, leadS: 0, trailS: 0, transitionS: 0 });
    expect(plan.transitionMs).toBe(0);
    expect(plan.scenes.map((scene) => scene.transitionFrames)).toEqual([0, 0, 0]);
    expect(plan.scenes.map((scene) => scene.startFrame)).toEqual([0, 60, 135]);
    expect(plan.durationMs).toBe(7600);
  });

  it('handles a single scene', () => {
    const plan = buildRenderPlan({ scenes: [THREE_SCENES[0]!], leadS: 0.5, trailS: 0.5 });
    expect(plan.scenes[0]!.frameCount).toBe(90);
    expect(plan.chapters[0]).toMatchObject({ startFrame: 0, endFrame: 90 });
  });

  it('defaults a null camera move to static and rejects an unknown one', () => {
    const plan = buildRenderPlan({
      scenes: [{ ...THREE_SCENES[0]!, cameraMove: null }],
      leadS: 0,
      trailS: 0,
    });
    expect(plan.scenes[0]!.cameraMove).toBe('static');
    expect(() =>
      buildRenderPlan({
        scenes: [{ ...THREE_SCENES[0]!, cameraMove: 'wobble' as never }],
        leadS: 0,
        trailS: 0,
      }),
    ).toThrow(/camera_move/);
  });
});

describe('chapter metadata', () => {
  it('writes an ffmetadata chapter per scene with millisecond timebases', () => {
    const plan = buildRenderPlan({ scenes: THREE_SCENES, leadS: 0.5, trailS: 0.5 });
    const metadata = buildChapterMetadata(plan);
    expect(metadata.startsWith(';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000')).toBe(true);
    expect(metadata.match(/\[CHAPTER\]/g)).toHaveLength(3);
    expect(metadata).toContain('title=S02');
    expect(metadata).toContain('END=8600');
  });

  it('formats seconds for filter arguments', () => {
    expect(seconds(2.5)).toBe('2.500');
    expect(seconds(1 / 3)).toBe('0.333');
  });
});
