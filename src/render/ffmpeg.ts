/**
 * The FFmpeg/ffprobe boundary — a port plus the child-process implementation
 * (TECH_DESIGN §6, §11.2 "fake FFmpeg: an ffmpeg/ffprobe wrapper that writes a
 * minimal valid MP4 + probe JSON").
 *
 * Every render, probe and scan goes through `FfmpegRunner`, so the tests can
 * inject `FakeFfmpegRunner` and no unit test ever needs a 4-minute encode. The
 * real runner measures what the benchmark needs and nothing else:
 *
 * - wall time: monotonic clock around the child process;
 * - peak RAM: `VmHWM` from `/proc/<pid>/status`, sampled while the process runs.
 *   `VmHWM` is the high-water mark of resident set size, so the last sample is
 *   the true peak and the sampler only has to be fast enough to read it once.
 *
 * The child is killed on the runtime ceiling (§6.8: 15 min) and on SIGTERM; a
 * partial output is discarded by the caller, never delivered.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { RENDER_TIMEOUT_MS } from './constants.js';

export interface RenderProgress {
  readonly outTimeMs: number | null;
  readonly frame: number | null;
  readonly fps: number | null;
}

export interface FfmpegRunOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly onProgress?: (progress: RenderProgress) => void;
}

export interface FfmpegRunResult {
  readonly exitCode: number;
  readonly wallTimeMs: number;
  /** Peak resident set size of the ffmpeg process, in kB; null when unreadable. */
  readonly peakRssKb: number | null;
  readonly timedOut: boolean;
  readonly stderrTail: readonly string[];
}

export interface ProbeStream {
  readonly index: number;
  readonly codec_type: string;
  readonly codec_name: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly r_frame_rate: string | null;
  readonly avg_frame_rate: string | null;
  readonly duration: string | null;
  readonly nb_frames: string | null;
  readonly sample_rate: string | null;
  readonly channels: number | null;
}

export interface ProbeChapter {
  readonly id: number;
  readonly start_time: string;
  readonly end_time: string;
  readonly tags: Readonly<Record<string, string>>;
}

export interface ProbeResult {
  readonly streams: readonly ProbeStream[];
  readonly chapters: readonly ProbeChapter[];
  readonly format: {
    readonly duration: string | null;
    readonly size: string | null;
    readonly format_name: string | null;
  };
}

export interface FfmpegRunner {
  run(args: readonly string[], options?: FfmpegRunOptions): Promise<FfmpegRunResult>;
  probe(file: string): Promise<ProbeResult>;
  /**
   * Run a read-only analysis pass and return everything it printed on stdout.
   * Used for `metadata=print:file=-` scans; no media is produced.
   */
  analyse(args: readonly string[]): Promise<string>;
}

/** Parse `-progress pipe:1` key=value output into the latest progress. */
export function parseProgressLine(line: string, current: RenderProgress): RenderProgress | null {
  const separator = line.indexOf('=');
  if (separator < 0) return null;
  const key = line.slice(0, separator).trim();
  const value = line.slice(separator + 1).trim();
  const number = (input: string): number | null => {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? parsed : null;
  };
  switch (key) {
    case 'out_time_us':
      return {
        ...current,
        outTimeMs: number(value) === null ? null : Math.round(number(value)! / 1000),
      };
    case 'frame':
      return { ...current, frame: number(value) };
    case 'fps':
      return { ...current, fps: number(value) };
    default:
      return null;
  }
}

/** Peak resident set size from `/proc/<pid>/status` (`VmHWM`, kB). */
export function readPeakRssKb(pid: number): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /^VmHWM:\s+(\d+)\s+kB$/m.exec(status);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

const STDERR_TAIL_LINES = 40;

/** The real runner: ffmpeg and ffprobe as child processes. */
export class ProcessFfmpegRunner implements FfmpegRunner {
  constructor(
    private readonly binary = 'ffmpeg',
    private readonly probeBinary = 'ffprobe',
  ) {}

  async run(args: readonly string[], options: FfmpegRunOptions = {}): Promise<FfmpegRunResult> {
    const timeoutMs = options.timeoutMs ?? RENDER_TIMEOUT_MS;
    const startedAt = process.hrtime.bigint();
    const stderrTail: string[] = [];
    const timeout = AbortSignal.timeout(timeoutMs);

    const child = spawn(this.binary, [...args], {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: timeout,
    });

    let peakRssKb: number | null = null;
    const sampler = setInterval(() => {
      if (child.pid === undefined) return;
      const sample = readPeakRssKb(child.pid);
      if (sample !== null && (peakRssKb === null || sample > peakRssKb)) peakRssKb = sample;
    }, 100);
    // Never keep the event loop alive because of the sampler.
    sampler.unref?.();

    let progress: RenderProgress = { outTimeMs: null, frame: null, fps: null };
    let stdoutBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const next = parseProgressLine(line, progress);
        if (next !== null) {
          progress = next;
          options.onProgress?.(progress);
        }
      }
    });

    let stderrBuffer = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrBuffer += chunk;
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === '') continue;
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
      }
    });

    let timedOut = false;
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on('error', (error) => {
        clearInterval(sampler);
        reject(error);
      });
      timeout.addEventListener('abort', () => {
        timedOut = true;
        child.kill('SIGKILL');
      });
      child.on('close', (code, signal) => {
        clearInterval(sampler);
        if (stderrBuffer.trim() !== '') stderrTail.push(stderrBuffer.trim());
        if (code === null) {
          resolve(signal === 'SIGKILL' ? 137 : 1);
          return;
        }
        resolve(code);
      });
    });

    const wallTimeMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    return { exitCode, wallTimeMs, peakRssKb, timedOut, stderrTail };
  }

  async probe(file: string): Promise<ProbeResult> {
    const output = await this.execute(this.probeBinary, [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '-show_chapters',
      file,
    ]);
    return parseProbeJson(output);
  }

  async analyse(args: readonly string[]): Promise<string> {
    return this.execute(this.binary, args);
  }

  /** Run a read-only child to completion and return its stdout. */
  private async execute(binary: string, args: readonly string[]): Promise<string> {
    const child = spawn(binary, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    const code = await new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (exitCode) => resolve(exitCode ?? 1));
    });
    if (code !== 0) {
      throw new Error(`${binary} exited ${code}: ${stderr.split('\n').slice(-6).join(' | ')}`);
    }
    return stdout;
  }
}

/** Validate and normalise the ffprobe JSON. */
export function parseProbeJson(raw: string): ProbeResult {
  const parsed = JSON.parse(raw) as {
    streams?: Array<Record<string, unknown>>;
    chapters?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  const numberOrNull = (value: unknown): number | null =>
    typeof value === 'number' ? value : null;
  const stringOrNull = (value: unknown): string | null =>
    typeof value === 'string' ? value : null;

  const streams: ProbeStream[] = (parsed.streams ?? []).map((stream, index) => ({
    index: typeof stream.index === 'number' ? stream.index : index,
    codec_type: String(stream.codec_type ?? ''),
    codec_name: stringOrNull(stream.codec_name),
    width: numberOrNull(stream.width),
    height: numberOrNull(stream.height),
    r_frame_rate: stringOrNull(stream.r_frame_rate),
    avg_frame_rate: stringOrNull(stream.avg_frame_rate),
    duration: stringOrNull(stream.duration),
    nb_frames: stringOrNull(stream.nb_frames),
    sample_rate: stringOrNull(stream.sample_rate),
    channels: numberOrNull(stream.channels),
  }));

  const chapters: ProbeChapter[] = (parsed.chapters ?? []).map((chapter, index) => ({
    id: typeof chapter.id === 'number' ? chapter.id : index,
    start_time: String(chapter.start_time ?? '0'),
    end_time: String(chapter.end_time ?? '0'),
    tags: (chapter.tags as Record<string, string> | undefined) ?? {},
  }));

  const format = parsed.format ?? {};
  return {
    streams,
    chapters,
    format: {
      duration: stringOrNull(format.duration),
      size: stringOrNull(format.size),
      format_name: stringOrNull(format.format_name),
    },
  };
}

/** Parse `lavfi.signalstats.Y*` values out of a metadata=print pass. */
export function parseSignalStats(output: string, key: string): number[] {
  const values: number[] = [];
  const pattern = new RegExp(`^${key}=(-?[0-9.]+)$`, 'gm');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(output)) !== null) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

/** `30000/1001` → 29.97. */
export function parseFrameRate(value: string | null): number | null {
  if (value === null) return null;
  const [numerator, denominator] = value.split('/');
  const n = Number(numerator);
  const d = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  return n / d;
}

/** A duration string in seconds, or null. */
export function parseSeconds(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
