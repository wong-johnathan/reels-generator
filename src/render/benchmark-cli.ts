/**
 * Milestone A render benchmark runner (CTO risk #2, CTO risk #6 eyeball inputs).
 *
 * Builds a deterministic 17-scene / 75 s fixture — synthetic stills at the
 * series' image resolution, synthetic narration, 228 caption words — renders it
 * with the real FFmpeg pipeline, runs the real QC, and prints the benchmark
 * record plus the QC report as JSON.
 *
 * Why synthetic: no paid provider may be called from a benchmark, and the
 * Milestone A render budget does not depend on what the pictures contain. The
 * images are `testsrc2` at 768×1376 (the provider's 1K output, so the 1.406×
 * upscale path is the one measured) or 1536×2752 for the 2K comparison.
 *
 * Usage (from the worker image, on the target hardware):
 *
 *   node --experimental-strip-types src/render/benchmark-cli.ts \
 *     --scenes 17 --duration 75 --resolution 1K \
 *     --out /tmp/reels-benchmark --json /tmp/reels-benchmark.json \
 *     --label "Synology DS923+ (render-worker)"
 *
 * The `--label` is recorded verbatim in the benchmark record: a run on any other
 * host must say so, because the exit criterion names the DS923+.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { timingBand } from '../workers/timing-stage.js';
import { buildRenderBenchmark, formatBenchmark, type RenderBenchmarkRecord } from './benchmark.js';
import { buildCaptionDocuments } from './captions.js';
import { ProcessFfmpegRunner } from './ffmpeg.js';
import { buildRenderPlan, type RenderSceneSource } from './plan.js';
import { runVideoQc, type QcReport } from './qc.js';
import { renderVideo } from './render.js';
import type { CameraMove } from '../shared/states.js';

interface CliOptions {
  readonly scenes: number;
  readonly durationS: number;
  readonly resolution: '1K' | '2K';
  readonly outDir: string;
  readonly jsonPath: string | null;
  readonly label: string;
  readonly keep: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith('--')) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      values.set(argument.slice(2), 'true');
      continue;
    }
    values.set(argument.slice(2), value);
    index += 1;
  }
  const resolution = values.get('resolution') === '2K' ? '2K' : '1K';
  const outDir = values.get('out');
  const jsonPath = values.get('json');
  return {
    scenes: Number(values.get('scenes') ?? 17),
    durationS: Number(values.get('duration') ?? 75),
    resolution,
    outDir:
      outDir === undefined ? mkdtempSync(join(tmpdir(), 'reels-benchmark-')) : resolve(outDir),
    jsonPath: jsonPath === undefined ? null : resolve(jsonPath),
    label: values.get('label') ?? 'unspecified host',
    keep: values.get('keep') === 'true' || outDir !== undefined,
  };
}

const VOCABULARY = [
  'the',
  'quiet',
  'machine',
  'that',
  'runs',
  'your',
  'morning',
  'decides',
  'what',
  'you',
  'see',
  'first',
  'and',
  'what',
  'never',
  'arrives',
  'at',
  'all',
  'because',
  'attention',
  'is',
  'the',
  'only',
  'currency',
  'that',
  'compounds',
  'while',
  'you',
  'sleep',
  'through',
  'another',
  'ordinary',
  'day',
  'of',
  'small',
  'choices',
  'made',
  'without',
  'you',
];

const CAMERA_MOVES: readonly CameraMove[] = ['zoom_in', 'pan_r', 'zoom_out', 'pan_l', 'static'];

function makeWords(
  count: number,
  narrationMs: number,
): { word: string; start_ms: number; end_ms: number }[] {
  const step = narrationMs / count;
  return Array.from({ length: count }, (_, index) => ({
    word: VOCABULARY[index % VOCABULARY.length]!,
    start_ms: Math.round(index * step),
    end_ms: Math.round(index * step + step * 0.82),
  }));
}

/** Split the word list into `sceneCount` contiguous groups and anchor spans to the words. */
function makeScenes(
  words: readonly { start_ms: number; end_ms: number }[],
  sceneCount: number,
): RenderSceneSource[] {
  const perScene = Math.ceil(words.length / sceneCount);
  const scenes: RenderSceneSource[] = [];
  for (let index = 0; index < sceneCount; index += 1) {
    const first = index * perScene;
    const last = Math.min(words.length - 1, first + perScene - 1);
    if (first > last) break;
    scenes.push({
      sceneNo: `S${String(index + 1).padStart(2, '0')}`,
      position: index + 1,
      cameraMove: CAMERA_MOVES[index % CAMERA_MOVES.length]!,
      imageFileName: `img-${String(index + 1).padStart(2, '0')}.png`,
      narrationStartMs: words[first]!.start_ms,
      narrationEndMs: words[last]!.end_ms,
    });
  }
  return scenes;
}

function ffmpeg(args: readonly string[]): void {
  execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args], { stdio: 'ignore' });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(options.outDir, { recursive: true });
  const workDir = join(options.outDir, 'work');
  mkdirSync(workDir, { recursive: true });

  const leadS = 0.5;
  const trailS = 0.5;
  const narrationMs = Math.round((options.durationS - leadS - trailS) * 1000);
  const words = makeWords(228, narrationMs);
  const sceneSources = makeScenes(words, options.scenes);

  const sourceWidth = options.resolution === '2K' ? 1536 : 768;
  const sourceHeight = options.resolution === '2K' ? 2752 : 1376;
  sceneSources.forEach((scene, index) => {
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      `testsrc2=s=${sourceWidth}x${sourceHeight}:r=1`,
      '-vf',
      `hue=h=${(index * 37) % 360}`,
      '-frames:v',
      '1',
      join(workDir, scene.imageFileName),
    ]);
  });

  const narrationSeconds = (narrationMs / 1000).toFixed(3);
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=220:sample_rate=48000:duration=${narrationSeconds}`,
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    join(workDir, 'narration.m4a'),
  ]);

  const plan = buildRenderPlan({
    scenes: sceneSources,
    leadS,
    trailS,
  });
  const { cues, documents } = buildCaptionDocuments({ words, leadS });
  const runner = new ProcessFfmpegRunner();
  const rendered = await renderVideo({
    plan,
    workDir,
    narrationFileName: 'narration.m4a',
    captions: documents,
    captionCueCount: cues.length,
    runner,
  });

  const band = timingBand(options.durationS);
  const qc: QcReport = await runVideoQc({
    videoPath: rendered.videoPath,
    workDir,
    manifest: rendered.manifest,
    band,
    runner,
  });

  const benchmark: RenderBenchmarkRecord = buildRenderBenchmark({
    plan,
    result: rendered,
    hostLabel: options.label,
    sourceResolution: options.resolution,
    notes: [
      'synthetic fixture: testsrc2 stills at the series image resolution, sine narration, 228 words',
      'QC ran on the delivered MP4 in the same invocation',
      'the DS923+ exit criterion is only met by a run whose --label says DS923+',
    ],
  });

  const payload = {
    benchmark,
    qc,
    artefacts: {
      work_dir: options.keep ? workDir : null,
      video: rendered.videoPath,
      captions: rendered.captions,
    },
  };

  const json = JSON.stringify(payload, null, 2);
  console.log(json);
  if (options.jsonPath !== null) writeFileSync(options.jsonPath, json + '\n', 'utf8');
  console.error(formatBenchmark(benchmark));
  console.error(
    `QC: ${qc.status} — ${qc.checks.map((check) => `${check.id}=${check.pass ? 'pass' : 'FAIL'}`).join(', ')}`,
  );
  if (qc.status !== 'pass') process.exitCode = 1;
}

await main();
