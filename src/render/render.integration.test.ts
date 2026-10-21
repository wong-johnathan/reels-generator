/**
 * The pipeline against real FFmpeg (TECH_DESIGN §11.2: the fake covers the unit
 * layer, the real binary is exercised here). Kept short — two 0.5 s scenes —
 * because the point is that the graph, the muxer, the chapter track and the
 * scans agree with each other, not throughput (that is the benchmark's job).
 *
 * Skipped loudly when FFmpeg is not on PATH: the worker image always has it, a
 * bare developer shell may not.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { buildCaptionDocuments } from './captions.js';
import { ProcessFfmpegRunner } from './ffmpeg.js';
import { buildRenderPlan, type RenderSceneSource } from './plan.js';
import { runVideoQc } from './qc.js';
import { renderVideo } from './render.js';
import type { TimingBand } from './qc.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const hasFfprobe = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

const workDir = mkdtempSync(join(tmpdir(), 'reels-render-it-'));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe.skipIf(!hasFfmpeg || !hasFfprobe)('render pipeline with real ffmpeg', () => {
  it('renders a two-scene video and passes every R-010 assertion', async () => {
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=768x1376:r=1',
        '-frames:v',
        '1',
        join(workDir, 'img-1.png'),
      ],
      { stdio: 'ignore' },
    );
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=768x1376:r=1',
        '-frames:v',
        '1',
        join(workDir, 'img-2.png'),
      ],
      { stdio: 'ignore' },
    );
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=330:sample_rate=48000:duration=1',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        join(workDir, 'narration.m4a'),
      ],
      { stdio: 'ignore' },
    );

    const scenes: RenderSceneSource[] = [
      {
        sceneNo: 'S01',
        position: 1,
        cameraMove: 'zoom_in',
        imageFileName: 'img-1.png',
        narrationStartMs: 0,
        narrationEndMs: 500,
      },
      {
        sceneNo: 'S02',
        position: 2,
        cameraMove: 'pan_l',
        imageFileName: 'img-2.png',
        narrationStartMs: 500,
        narrationEndMs: 1000,
      },
    ];
    const plan = buildRenderPlan({ scenes, leadS: 0.5, trailS: 0.5 });
    const { cues, documents } = buildCaptionDocuments({
      words: [
        { word: 'the', start_ms: 0, end_ms: 150 },
        { word: 'quiet', start_ms: 150, end_ms: 320 },
        { word: 'machine', start_ms: 320, end_ms: 500 },
        { word: 'runs', start_ms: 520, end_ms: 680 },
        { word: 'your', start_ms: 680, end_ms: 830 },
        { word: 'morning', start_ms: 830, end_ms: 980 },
      ],
      leadS: 0.5,
    });

    const runner = new ProcessFfmpegRunner();
    const rendered = await renderVideo({
      plan,
      workDir,
      narrationFileName: 'narration.m4a',
      captions: documents,
      captionCueCount: cues.length,
      runner,
      now: new Date('2026-10-21T00:00:00Z'),
    });

    expect(existsSync(rendered.videoPath)).toBe(true);
    expect(rendered.manifest.total_frames).toBe(plan.totalFrames);
    expect(rendered.manifest.band).toBeNull();
    // The 0.5 s scenes are below the 0.6 s threshold: §6.3 downgrades them.
    expect(rendered.manifest.scenes.map((scene) => scene.transition_downgraded)).toEqual([
      true,
      false,
    ]);

    const probe = await runner.probe(rendered.videoPath);
    const video = probe.streams.find((stream) => stream.codec_type === 'video');
    expect(video).toMatchObject({ width: 1080, height: 1920, codec_name: 'h264' });
    expect(probe.chapters.map((chapter) => chapter.tags.title)).toEqual(['S01', 'S02']);

    const band: TimingBand = { target_s: 2, tolerance_s: 1, min_s: 1, max_s: 3 };
    const report = await runVideoQc({
      videoPath: rendered.videoPath,
      workDir,
      manifest: rendered.manifest,
      band,
      runner,
    });

    expect(report.status).toBe('pass');
    expect(report.checks.map((check) => check.id)).toEqual([
      'geometry',
      'audio',
      'blank_white',
      'scene_presence',
      'caption_safe_area',
      'duration',
    ]);
    expect(report.metrics.frame_count).toBe(plan.totalFrames);
    expect(report.metrics.caption_outside_max).toBe(0);
    expect(report.metrics.caption_inside_max).toBeGreaterThan(0);
  }, 180_000);

  it('refuses to call a render successful when ffmpeg fails', async () => {
    const failing = {
      run: async () => ({
        exitCode: 1,
        wallTimeMs: 5,
        peakRssKb: null,
        timedOut: false,
        stderrTail: ['boom'],
      }),
      probe: async () => {
        throw new Error('probe should not be called');
      },
      analyse: async () => '',
    };
    const plan = buildRenderPlan({
      scenes: [
        {
          sceneNo: 'S01',
          position: 1,
          cameraMove: 'static',
          imageFileName: 'img-1.png',
          narrationStartMs: 0,
          narrationEndMs: 500,
        },
      ],
      leadS: 0.5,
      trailS: 0.5,
    });
    const { documents } = buildCaptionDocuments({ words: [], leadS: 0.5 });
    await expect(
      renderVideo({
        plan,
        workDir,
        narrationFileName: 'narration.m4a',
        captions: documents,
        captionCueCount: 0,
        runner: failing,
      }),
    ).rejects.toThrow(/ffmpeg exited 1/);
  });
});
