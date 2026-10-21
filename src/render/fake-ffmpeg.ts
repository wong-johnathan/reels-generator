/**
 * Deterministic FFmpeg/ffprobe fake — TECH_DESIGN §11.1: "a fake FFmpeg
 * (`ffmpeg`/`ffprobe` wrapper that writes a minimal valid MP4 + probe JSON)".
 *
 * Unit tests assert the graph, the QC arithmetic and the stage wiring against
 * this fake, so they never pay for a 1080p encode and never depend on the host
 * having FFmpeg at all. The real binary is exercised by the integration tests
 * and by `benchmark-cli.ts`.
 *
 * The fake answers three kinds of call:
 *   run()      records the argv, optionally "writes" an output marker file, and
 *              returns the configured exit code / wall time / peak RSS;
 *   probe()    returns a configured `ProbeResult`;
 *   analyse()  parses the `metadata=print` key and crop geometry out of the
 *              argv and returns synthetic per-frame values — so the luminance
 *              and caption-region scans are exercised end to end.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  FfmpegRunOptions,
  FfmpegRunResult,
  FfmpegRunner,
  ProbeChapter,
  ProbeResult,
  ProbeStream,
} from './ffmpeg.js';

export interface FakeRegionValues {
  readonly outside: number;
  readonly inside: number;
}

export interface FakeFfmpegScenario {
  readonly probe?: ProbeResult;
  /** Per-frame mean luminance for `format=gray,signalstats` YAVG scans. */
  readonly luminance?: readonly number[];
  /** Max luma per region for the caption-safe-area scan. */
  readonly captionRegions?: FakeRegionValues;
  readonly run?: Partial<FfmpegRunResult>;
  /** Write this file name (relative to the run cwd) as the render output. */
  readonly outputFile?: string;
  readonly outputBytes?: Uint8Array;
}

export function probeFixture(overrides: Partial<ProbeResult> = {}): ProbeResult {
  const video: ProbeStream = {
    index: 0,
    codec_type: 'video',
    codec_name: 'h264',
    width: 1080,
    height: 1920,
    r_frame_rate: '30/1',
    avg_frame_rate: '30/1',
    duration: '75.100',
    nb_frames: '2253',
    sample_rate: null,
    channels: null,
  };
  const audio: ProbeStream = {
    index: 1,
    codec_type: 'audio',
    codec_name: 'aac',
    width: null,
    height: null,
    r_frame_rate: null,
    avg_frame_rate: null,
    duration: '75.100',
    nb_frames: null,
    sample_rate: '48000',
    channels: 2,
  };
  return {
    streams: [video, audio],
    chapters: [],
    format: { duration: '75.100', size: '1000', format_name: 'mov,mp4' },
    ...overrides,
  };
}

/** A chapter track matching a plan: one chapter per scene, titled by scene_no. */
export function chaptersFixture(
  scenes: readonly { scene_no: string; start_ms: number; end_ms: number }[],
): ProbeChapter[] {
  return scenes.map((scene, index) => ({
    id: index,
    start_time: (scene.start_ms / 1000).toFixed(3),
    end_time: (scene.end_ms / 1000).toFixed(3),
    tags: { title: scene.scene_no },
  }));
}

/** Crop geometry out of a `crop=W:H:X:Y` filter string. */
export function parseCrop(
  argument: string,
): { width: number; height: number; x: number; y: number } | null {
  const match = /crop=(\d+):(\d+):(\d+):(\d+)/.exec(argument);
  if (match === null) return null;
  return {
    width: Number(match[1]),
    height: Number(match[2]),
    x: Number(match[3]),
    y: Number(match[4]),
  };
}

export class FakeFfmpegRunner implements FfmpegRunner {
  readonly runs: string[][] = [];
  readonly analyses: string[][] = [];
  readonly probeCalls: string[] = [];

  constructor(private scenario: FakeFfmpegScenario = {}) {}

  setScenario(scenario: FakeFfmpegScenario): void {
    this.scenario = scenario;
  }

  async run(args: readonly string[], options: FfmpegRunOptions = {}): Promise<FfmpegRunResult> {
    this.runs.push([...args]);
    const outputFile = this.scenario.outputFile;
    if (outputFile !== undefined) {
      const target = options.cwd === undefined ? outputFile : join(options.cwd, outputFile);
      writeFileSync(target, this.scenario.outputBytes ?? new Uint8Array([0, 0, 0, 24]));
    }
    return {
      exitCode: 0,
      wallTimeMs: 1234,
      peakRssKb: 512_000,
      timedOut: false,
      stderrTail: [],
      ...this.scenario.run,
    };
  }

  async probe(file: string): Promise<ProbeResult> {
    this.probeCalls.push(file);
    if (this.scenario.probe === undefined)
      throw new Error('FakeFfmpegRunner has no probe scenario');
    return this.scenario.probe;
  }

  async analyse(args: readonly string[]): Promise<string> {
    this.analyses.push([...args]);
    const filter = args.join(' ');
    const lines: string[] = [];
    if (filter.includes('lavfi.signalstats.YAVG')) {
      const values = this.scenario.luminance ?? [];
      values.forEach((value, index) => {
        lines.push(`frame:${index}    pts:${index}       pts_time:${(index / 30).toFixed(6)}`);
        lines.push(`lavfi.signalstats.YAVG=${value}`);
      });
      return lines.join('\n');
    }
    if (filter.includes('lavfi.signalstats.YMAX')) {
      const crop = parseCrop(filter);
      const regions = this.scenario.captionRegions ?? { outside: 0, inside: 255 };
      const inside = crop !== null && crop.x === 54 && crop.y === 96;
      const value = inside ? regions.inside : regions.outside;
      lines.push('frame:0    pts:0       pts_time:0');
      lines.push(`lavfi.signalstats.YMAX=${value}`);
      return lines.join('\n');
    }
    return lines.join('\n');
  }
}
