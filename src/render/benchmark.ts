/**
 * Render benchmark record — TECH_DESIGN §6.8, CTO risk #2.
 *
 * The budget is ~5 min ± 3 min wall time and ≤ 2 GB peak RAM for a 75 s video
 * on the DS923+. A **budget is not a benchmark**: the number only exists once a
 * render has actually run on the target hardware and its wall time and peak RSS
 * were measured. This module defines the record that run produces and the host
 * facts it is only meaningful with — a number without the host it came from is
 * not evidence.
 *
 * `host_label` exists because a developer machine or CI runner must never be
 * misread as the NAS. The Milestone A exit criterion is a DS923+ run; any other
 * host is recorded as such, in the record itself.
 */
import { cpus, totalmem } from 'node:os';

import { X264_CRF, X264_PRESET } from './constants.js';
import type { RenderPlan } from './plan.js';
import type { RenderVideoResult } from './render.js';

export const RENDER_BENCHMARK_SCHEMA_VERSION = 'render-benchmark.v1';

export interface BenchmarkHost {
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
  readonly cpu_model: string;
  readonly cpu_cores: number;
  readonly total_memory_mb: number;
}

export interface RenderBenchmarkRecord {
  readonly schema_version: typeof RENDER_BENCHMARK_SCHEMA_VERSION;
  readonly recorded_at: string;
  /** Where the numbers came from, e.g. `Synology DS923+ (render-worker)` or `dev host`. */
  readonly host_label: string;
  readonly host: BenchmarkHost;
  readonly video: {
    readonly duration_s: number;
    readonly scene_count: number;
    readonly frame_count: number;
    readonly width: number;
    readonly height: number;
    readonly fps: number;
    readonly source_resolution: '1K' | '2K';
  };
  readonly wall_time_s: number;
  /** Wall time ÷ video duration: < 1 is faster than real time. */
  readonly realtime_factor: number;
  readonly peak_ram_mb: number | null;
  readonly encoder: {
    readonly video: string;
    readonly preset: string;
    readonly crf: number;
    readonly audio: string;
  };
  readonly notes: readonly string[];
}

export function hostFacts(): BenchmarkHost {
  const processors = cpus();
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu_model: processors[0]?.model.trim() ?? 'unknown',
    cpu_cores: processors.length,
    total_memory_mb: Math.round(totalmem() / (1024 * 1024)),
  };
}

export interface BuildBenchmarkInput {
  readonly plan: RenderPlan;
  readonly result: Pick<RenderVideoResult, 'wallTimeMs' | 'peakRssKb'>;
  readonly hostLabel: string;
  readonly sourceResolution: '1K' | '2K';
  readonly now?: Date;
  readonly notes?: readonly string[];
}

export function buildRenderBenchmark(input: BuildBenchmarkInput): RenderBenchmarkRecord {
  const durationS = input.plan.durationMs / 1000;
  const wallTimeS = Math.round(input.result.wallTimeMs / 100) / 10;
  return {
    schema_version: RENDER_BENCHMARK_SCHEMA_VERSION,
    recorded_at: (input.now ?? new Date()).toISOString(),
    host_label: input.hostLabel,
    host: hostFacts(),
    video: {
      duration_s: Math.round(durationS * 1000) / 1000,
      scene_count: input.plan.scenes.length,
      frame_count: input.plan.totalFrames,
      width: input.plan.width,
      height: input.plan.height,
      fps: input.plan.fps,
      source_resolution: input.sourceResolution,
    },
    wall_time_s: wallTimeS,
    realtime_factor: durationS === 0 ? 0 : Math.round((wallTimeS / durationS) * 100) / 100,
    peak_ram_mb: input.result.peakRssKb === null ? null : Math.round(input.result.peakRssKb / 1024),
    encoder: { video: 'libx264', preset: X264_PRESET, crf: X264_CRF, audio: 'aac' },
    notes: input.notes ?? [],
  };
}

/** One human line for the run log / evidence file. */
export function formatBenchmark(record: RenderBenchmarkRecord): string {
  return (
    `render benchmark: ${record.video.duration_s} s / ${record.video.scene_count} scenes / ` +
    `${record.video.frame_count} frames → wall ${record.wall_time_s} s ` +
    `(${record.realtime_factor}x realtime), peak RAM ${record.peak_ram_mb ?? 'n/a'} MB ` +
    `on ${record.host_label} [${record.host.cpu_model}, ${record.host.cpu_cores} cores]`
  );
}
