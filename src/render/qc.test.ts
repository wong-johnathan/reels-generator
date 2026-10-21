import { describe, expect, it } from 'vitest';

import { QCCheckSchema } from '../../contract/api.js';

import { buildRenderPlan, type RenderSceneSource } from './plan.js';
import { buildRenderManifest } from './render.js';
import { captionScanRegions, readProbeFacts, runVideoQc, type TimingBand } from './qc.js';
import { FakeFfmpegRunner, chaptersFixture, probeFixture } from './fake-ffmpeg.js';
import type { ProbeResult } from './ffmpeg.js';

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
    cameraMove: 'static',
    imageFileName: 'img-3.png',
    narrationStartMs: 4500,
    narrationEndMs: 7600,
  },
];

const plan = buildRenderPlan({ scenes: SCENES, leadS: 0.5, trailS: 0.5 });
const band: TimingBand = { target_s: 8.6, tolerance_s: 1, min_s: 7.6, max_s: 9.6 };
const manifest = buildRenderManifest({ plan, captionCueCount: 4, projectId: null, band });

function passProbe(): ProbeResult {
  return probeFixture({
    chapters: chaptersFixture(
      plan.chapters.map((chapter) => ({
        scene_no: chapter.title,
        start_ms: chapter.startMs,
        end_ms: chapter.endMs,
      })),
    ),
    format: { duration: (plan.durationMs / 1000).toFixed(3), size: '1000', format_name: 'mp4' },
    streams: probeFixture().streams.map((stream) => ({
      ...stream,
      duration: (plan.durationMs / 1000).toFixed(3),
    })),
  });
}

function luminance(count = plan.totalFrames, value = 120): number[] {
  return Array.from({ length: count }, () => value);
}

function run(overrides: {
  probe?: ProbeResult;
  luminance?: number[];
  captionRegions?: { outside: number; inside: number };
}) {
  const runner = new FakeFfmpegRunner({
    probe: overrides.probe ?? passProbe(),
    luminance: overrides.luminance ?? luminance(),
    captionRegions: overrides.captionRegions ?? { outside: 0, inside: 255 },
  });
  return runVideoQc({
    videoPath: '/tmp/rendered.mp4',
    workDir: '/tmp',
    manifest,
    band,
    runner,
    now: new Date('2026-10-21T00:00:00Z'),
  }).then((report) => ({ report, runner }));
}

function checkById(report: Awaited<ReturnType<typeof run>>['report'], id: string) {
  const found = report.checks.find((check) => check.id === id);
  if (found === undefined) throw new Error(`no check ${id}`);
  return found;
}

describe('caption scan geometry', () => {
  it('covers the four rectangles outside the safe area plus the safe rectangle', () => {
    const regions = captionScanRegions();
    expect(regions.outside).toEqual([
      { x: 0, y: 0, width: 54, height: 1920 },
      { x: 1026, y: 0, width: 54, height: 1920 },
      { x: 0, y: 0, width: 1080, height: 96 },
      { x: 0, y: 1824, width: 1080, height: 96 },
    ]);
    expect(regions.inside).toEqual({ x: 54, y: 96, width: 972, height: 1728 });
  });
});

describe('runVideoQc — the pass case', () => {
  it('passes all six R-010 assertions on a conforming file', async () => {
    const { report } = await run({});
    expect(report.status).toBe('pass');
    expect(report.checks.map((check) => check.id)).toEqual([
      'geometry',
      'audio',
      'blank_white',
      'scene_presence',
      'caption_safe_area',
      'duration',
    ]);
    expect(report.checks.map((check) => check.requirement)).toEqual([
      'R-010-2',
      'R-010-3',
      'R-010-4',
      'R-010-5',
      'R-010-6',
      'R-010-7',
    ]);
    expect(report.checks.every((check) => check.pass)).toBe(true);
    expect(report.metrics.chapter_count).toBe(3);
    expect(report.metrics.frame_count).toBe(plan.totalFrames);
    expect(report.checked_at).toBe('2026-10-21T00:00:00.000Z');
  });

  it('scans the caption pass over black at the render duration', async () => {
    const { runner } = await run({});
    const scanRun = runner.runs.find((args) =>
      args.join(' ').includes('subtitles=filename=captions.ass'),
    );
    expect(scanRun?.join(' ')).toContain('color=c=black:s=1080x1920:r=30:d=8.600');
    const ymaxPasses = runner.analyses.filter((args) => args.join(' ').includes('YMAX'));
    expect(ymaxPasses).toHaveLength(5);
  });
});

describe('runVideoQc — each assertion can fail', () => {
  it('fails geometry when the frame rate is wrong', async () => {
    const probe = passProbe();
    const broken = {
      ...probe,
      streams: probe.streams.map((stream) =>
        stream.codec_type === 'video' ? { ...stream, r_frame_rate: '25/1' } : stream,
      ),
    };
    const { report } = await run({ probe: broken });
    expect(checkById(report, 'geometry').pass).toBe(false);
    expect(checkById(report, 'geometry').measured).toContain('25 fps');
  });

  it('fails geometry when the resolution is off by a pixel', async () => {
    const probe = passProbe();
    const broken = {
      ...probe,
      streams: probe.streams.map((stream) =>
        stream.codec_type === 'video' ? { ...stream, height: 1921 } : stream,
      ),
    };
    const { report } = await run({ probe: broken });
    expect(checkById(report, 'geometry').pass).toBe(false);
  });

  it('fails audio when no audio stream is present', async () => {
    const probe = passProbe();
    const broken = {
      ...probe,
      streams: probe.streams.filter((stream) => stream.codec_type !== 'audio'),
    };
    const { report } = await run({ probe: broken });
    expect(checkById(report, 'audio').pass).toBe(false);
    expect(checkById(report, 'audio').measured).toBe('no audio stream');
  });

  it('fails audio when it drifts more than 0.5 s from the video', async () => {
    const probe = passProbe();
    const broken = {
      ...probe,
      streams: probe.streams.map((stream) =>
        stream.codec_type === 'audio' ? { ...stream, duration: '9.400' } : stream,
      ),
    };
    const { report } = await run({ probe: broken });
    expect(checkById(report, 'audio').pass).toBe(false);
    expect(checkById(report, 'audio').measured).toContain('Δ 0.8 s');
  });

  it('flags blank and white frames (R-010-4)', async () => {
    const frame = luminance();
    frame[10] = 8;
    frame[20] = 250;
    const { report } = await run({ luminance: frame });
    const check = checkById(report, 'blank_white');
    expect(check.pass).toBe(false);
    expect(check.measured).toContain('2 flagged (first 10, 20)');
    expect(report.metrics.flagged_frames).toEqual([10, 20]);
  });

  it('fails scene presence when a scene has no chapter', async () => {
    const probe = passProbe();
    const broken = { ...probe, chapters: probe.chapters.slice(0, 2) };
    const { report } = await run({ probe: broken });
    const check = checkById(report, 'scene_presence');
    expect(check.pass).toBe(false);
    expect(check.measured).toContain('2/3 chapters');
    expect(check.measured).toContain('missing S03');
  });

  it('fails scene presence when a chapter is shorter than its narration span − 0.2 s', async () => {
    const probe = passProbe();
    const chapters = probe.chapters.map((chapter) =>
      chapter.tags.title === 'S02'
        ? { ...chapter, end_time: (Number(chapter.start_time) + 1.0).toFixed(3) }
        : chapter,
    );
    const { report } = await run({ probe: { ...probe, chapters } });
    const check = checkById(report, 'scene_presence');
    expect(check.pass).toBe(false);
    expect(check.measured).toContain('short: S02');
  });

  it('fails the safe-area check when caption ink lands outside the inset rectangle', async () => {
    const { report } = await run({ captionRegions: { outside: 90, inside: 255 } });
    const check = checkById(report, 'caption_safe_area');
    expect(check.pass).toBe(false);
    expect(check.measured).toContain('max ink outside 90');
  });

  it('fails the safe-area check when the caption pass burned no captions at all', async () => {
    const { report } = await run({ captionRegions: { outside: 0, inside: 0 } });
    expect(checkById(report, 'caption_safe_area').pass).toBe(false);
  });

  it('accepts a caption pass with nothing to place when the manifest has zero cues', async () => {
    const emptyManifest = buildRenderManifest({ plan, captionCueCount: 0, projectId: null, band });
    const runner = new FakeFfmpegRunner({
      probe: passProbe(),
      luminance: luminance(),
      captionRegions: { outside: 0, inside: 0 },
    });
    const report = await runVideoQc({
      videoPath: '/tmp/rendered.mp4',
      workDir: '/tmp',
      manifest: emptyManifest,
      band,
      runner,
    });
    expect(checkById(report, 'caption_safe_area').pass).toBe(true);
  });

  it('fails duration when the rendered file is short of the plan', async () => {
    const probe = passProbe();
    const short = {
      ...probe,
      streams: probe.streams.map((stream) => ({ ...stream, duration: '6.000' })),
    };
    const { report } = await run({ probe: short });
    const check = checkById(report, 'duration');
    expect(check.pass).toBe(false);
    expect(check.measured).toContain('6 s vs plan 8.6 s');
  });

  it('fails duration when the render lands outside the R-009-3 band', async () => {
    const probe = passProbe();
    const wild = buildRenderPlan({ scenes: SCENES, leadS: 0.5, trailS: 0.5 });
    const wideBand: TimingBand = { target_s: 20, tolerance_s: 1, min_s: 19, max_s: 21 };
    const runner = new FakeFfmpegRunner({
      probe,
      luminance: luminance(),
      captionRegions: { outside: 0, inside: 255 },
    });
    const report = await runVideoQc({
      videoPath: '/tmp/rendered.mp4',
      workDir: '/tmp',
      manifest: buildRenderManifest({ plan: wild, captionCueCount: 4, band: wideBand }),
      band: wideBand,
      runner,
    });
    expect(checkById(report, 'duration').pass).toBe(false);
  });
});

describe('readProbeFacts', () => {
  it('falls back to the container duration when a stream has none', () => {
    const probe = probeFixture({
      streams: probeFixture().streams.map((stream) => ({ ...stream, duration: null })),
    });
    const facts = readProbeFacts(probe);
    expect(facts.videoDurationS).toBeCloseTo(75.1, 3);
    expect(facts.audioDurationS).toBeCloseTo(75.1, 3);
  });
});

describe('contract conformance', () => {
  it('every check satisfies contract QCCheckSchema', async () => {
    const { report } = await run({});
    for (const check of report.checks) {
      expect(QCCheckSchema.safeParse(check).success, JSON.stringify(check)).toBe(true);
    }
  });
});
