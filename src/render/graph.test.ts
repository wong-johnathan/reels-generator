import { describe, expect, it } from 'vitest';

import {
  SCALE_CROP_FILTER,
  UNSHARP_FILTER,
  buildAudioGraph,
  buildCaptionScanArgs,
  buildFfmpegArgs,
  buildFilterGraph,
  buildSceneFilter,
  zoompanExpression,
} from './graph.js';
import { buildRenderPlan, type RenderSceneSource } from './plan.js';

const SCENES: RenderSceneSource[] = [
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
    cameraMove: 'zoom_out',
    imageFileName: 'img-3.png',
    narrationStartMs: 4500,
    narrationEndMs: 7600,
  },
];

const plan = buildRenderPlan({ scenes: SCENES, leadS: 0.5, trailS: 0.5 });

describe('scene filter (§6.1/§6.2)', () => {
  it('cover-scales, centre-crops, lanczos-upscales and sharpens conservatively', () => {
    const filter = buildSceneFilter(plan.scenes[0]!, 0);
    expect(filter).toContain(SCALE_CROP_FILTER);
    expect(SCALE_CROP_FILTER).toContain('force_original_aspect_ratio=increase');
    expect(SCALE_CROP_FILTER).toContain('flags=lanczos');
    expect(SCALE_CROP_FILTER).toContain('crop=1080:1920:(iw-1080)/2:(ih-1920)/2');
    expect(filter).toContain(UNSHARP_FILTER);
    expect(filter.startsWith('[0:v]')).toBe(true);
    expect(filter.endsWith('[v0]')).toBe(true);
  });

  it('zoompans for exactly the scene frame count at the output geometry', () => {
    const filter = buildSceneFilter(plan.scenes[0]!, 0);
    expect(filter).toContain(`:d=${plan.scenes[0]!.frameCount}:s=1080x1920:fps=30`);
  });

  it('builds a motion expression per camera_move and caps amplitude at 1.2x', () => {
    expect(zoompanExpression('zoom_in').z).toBe('min(zoom+0.0006,1.20)');
    expect(zoompanExpression('zoom_out').z).toBe('if(eq(on,0),1.20,max(zoom-0.0006,1.0))');
    expect(zoompanExpression('pan_l').x).toBe('(iw-iw/zoom)*(1-on/max(duration-1,1))');
    expect(zoompanExpression('pan_r').x).toBe('(iw-iw/zoom)*(on/max(duration-1,1))');
    expect(zoompanExpression('static'.trim() as never).z).toBe('1.0');
    for (const move of ['zoom_in', 'zoom_out', 'pan_l', 'pan_r', 'static'] as const) {
      expect(zoompanExpression(move).z).toMatch(/1\.(0|05|20)|min|max/);
    }
  });

  it('escapes the commas inside zoompan expressions', () => {
    const filter = buildSceneFilter(plan.scenes[0]!, 0);
    expect(filter).toContain('min(zoom+0.0006\\,1.20)');
  });

  it('forces constant frame rate so xfade accepts the link', () => {
    expect(buildSceneFilter(plan.scenes[0]!, 0)).toContain('settb=AVTB,setpts=N/(30*TB),fps=30');
  });
});

describe('filter graph (§6.3/§6.4/§6.5)', () => {
  const graph = buildFilterGraph({
    plan,
    captionsFileName: 'captions.ass',
    narrationInputIndex: 3,
    musicInputIndex: 4,
  });

  it('chains one xfade per boundary, with the outgoing scene duration and the incoming start offset', () => {
    expect(graph).toContain('[v0][v1]xfade=transition=fade:duration=0.300:offset=2.500[x1]');
    expect(graph).toContain('[x1][v2]xfade=transition=fade:duration=0.300:offset=5.000[x2]');
  });

  it('burns the ASS in on the final video label', () => {
    expect(graph).toContain('[x2]subtitles=filename=captions.ass[vout]');
  });

  it('delays narration by the lead, pads, mixes the silent music slot and keeps the level', () => {
    expect(graph).toContain('adelay=500|500');
    expect(graph).toContain('apad,atrim=0:8.600');
    expect(graph).toContain('[4:a]atrim=0:8.600,volume=0[music]');
    expect(graph).toContain('amix=inputs=2:duration=first:normalize=0[aout]');
  });

  it('uses concat when the plan has no transitions', () => {
    const cutPlan = buildRenderPlan({ scenes: SCENES, leadS: 0.5, trailS: 0.5, transitionS: 0 });
    const cutGraph = buildFilterGraph({
      plan: cutPlan,
      captionsFileName: 'captions.ass',
      narrationInputIndex: 3,
      musicInputIndex: 4,
    });
    expect(cutGraph).toContain('[v0][v1][v2]concat=n=3:v=1:a=0[cut]');
    expect(cutGraph).toContain('[cut]subtitles=filename=captions.ass[vout]');
    expect(cutGraph).not.toContain('xfade');
  });

  it('a one-scene plan has no transition at all', () => {
    const single = buildRenderPlan({ scenes: [SCENES[0]!], leadS: 0.5, trailS: 0.5 });
    const singleGraph = buildFilterGraph({
      plan: single,
      captionsFileName: 'a.ass',
      narrationInputIndex: 1,
      musicInputIndex: 2,
    });
    expect(singleGraph).not.toContain('xfade');
    expect(singleGraph).toContain('[v0]subtitles=filename=a.ass[vout]');
  });

  it('buildAudioGraph is a pure function of its inputs', () => {
    expect(
      buildAudioGraph({ narrationInputIndex: 0, musicInputIndex: 1, leadMs: 0, durationMs: 1000 }),
    ).toHaveLength(3);
  });
});

describe('ffmpeg argv (§6.6)', () => {
  const args = buildFfmpegArgs({
    plan,
    imageFileNames: ['img-1.png', 'img-2.png', 'img-3.png'],
    narrationFileName: 'narration.m4a',
    captionsFileName: 'captions.ass',
    chaptersFileName: 'chapters.txt',
    outputFileName: 'output.mp4',
  });

  it('orders inputs scenes, narration, silent music, chapter metadata', () => {
    expect(args.narrationInputIndex).toBe(3);
    expect(args.musicInputIndex).toBe(4);
    expect(args.metadataInputIndex).toBe(5);
    const joined = args.args.join(' ');
    expect(joined).toContain('-i img-1.png -i img-2.png -i img-3.png -i narration.m4a');
    expect(joined).toContain('-f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000');
    expect(joined).toContain('-f ffmetadata -i chapters.txt');
    expect(joined).toContain('-map_metadata 5');
  });

  it('encodes H.264 medium crf 20 yuv420p 30fps 1080x1920 and AAC 128k stereo', () => {
    const joined = args.args.join(' ');
    expect(joined).toContain(
      '-c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -r 30 -s 1080x1920',
    );
    expect(joined).toContain('-c:a aac -b:a 128k -ac 2');
    expect(joined).toContain('-movflags +faststart');
  });

  it('cuts the output at the plan duration', () => {
    expect(args.args.join(' ')).toContain('-t 8.600 output.mp4');
  });

  it('refuses a mismatched image list', () => {
    expect(() =>
      buildFfmpegArgs({
        plan,
        imageFileNames: ['img-1.png'],
        narrationFileName: 'narration.m4a',
        captionsFileName: 'captions.ass',
        chaptersFileName: 'chapters.txt',
        outputFileName: 'output.mp4',
      }),
    ).toThrow(/3 scenes but 1 images/);
  });
});

describe('caption isolation pass', () => {
  it('burns the same ASS over black at the output geometry and duration', () => {
    const args = buildCaptionScanArgs({
      durationMs: 8600,
      captionsFileName: 'captions.ass',
      outputFileName: 'scan.mp4',
    });
    const joined = args.join(' ');
    expect(joined).toContain('color=c=black:s=1080x1920:r=30:d=8.600');
    expect(joined).toContain('subtitles=filename=captions.ass,format=yuv420p');
    expect(joined).toContain('-preset ultrafast');
  });
});
