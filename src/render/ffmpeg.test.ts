import { describe, expect, it } from 'vitest';

import {
  parseFrameRate,
  parseProgressLine,
  parseProbeJson,
  parseSeconds,
  parseSignalStats,
  readPeakRssKb,
} from './ffmpeg.js';

describe('progress parsing', () => {
  it('reads out_time_us, frame and fps out of -progress output', () => {
    let progress = {
      outTimeMs: null as number | null,
      frame: null as number | null,
      fps: null as number | null,
    };
    for (const line of ['frame=12', 'fps=28.5', 'out_time_us=412000', 'progress=continue']) {
      progress = parseProgressLine(line, progress) ?? progress;
    }
    expect(progress).toEqual({ outTimeMs: 412, frame: 12, fps: 28.5 });
  });

  it('ignores lines it does not own', () => {
    expect(
      parseProgressLine('bitrate=N/A', { outTimeMs: null, frame: null, fps: null }),
    ).toBeNull();
    expect(
      parseProgressLine('out_time_us=N/A', { outTimeMs: null, frame: null, fps: null }),
    ).toEqual({
      outTimeMs: null,
      frame: null,
      fps: null,
    });
  });
});

describe('metadata scans', () => {
  it('collects every YAVG value in frame order', () => {
    const output = [
      'frame:0    pts:0       pts_time:0',
      'lavfi.signalstats.YAVG=0',
      'frame:1    pts:512     pts_time:0.0333333',
      'lavfi.signalstats.YAVG=255',
    ].join('\n');
    expect(parseSignalStats(output, 'lavfi.signalstats.YAVG')).toEqual([0, 255]);
  });

  it('returns an empty list when the scan printed nothing', () => {
    expect(parseSignalStats('', 'lavfi.signalstats.YMAX')).toEqual([]);
  });
});

describe('ffprobe parsing', () => {
  it('reads streams, chapters and format from ffprobe JSON', () => {
    const probe = parseProbeJson(
      JSON.stringify({
        streams: [
          {
            index: 0,
            codec_type: 'video',
            codec_name: 'h264',
            width: 1080,
            height: 1920,
            r_frame_rate: '30/1',
          },
          { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' },
        ],
        chapters: [{ id: 0, start_time: '0.000000', end_time: '2.500000', tags: { title: 'S01' } }],
        format: { duration: '8.600000', size: '100', format_name: 'mov,mp4,m4a' },
      }),
    );
    expect(probe.streams[0]).toMatchObject({ width: 1080, height: 1920, r_frame_rate: '30/1' });
    expect(probe.streams[1]).toMatchObject({ codec_type: 'audio', channels: 2 });
    expect(probe.chapters[0]!.tags.title).toBe('S01');
    expect(probe.format.duration).toBe('8.600000');
  });

  it('parses rational frame rates', () => {
    expect(parseFrameRate('30/1')).toBe(30);
    expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseFrameRate('0/0')).toBeNull();
    expect(parseFrameRate(null)).toBeNull();
  });

  it('parses second strings and rejects junk', () => {
    expect(parseSeconds('75.100')).toBeCloseTo(75.1, 3);
    expect(parseSeconds('')).toBeNull();
    expect(parseSeconds('N/A')).toBeNull();
    expect(parseSeconds(null)).toBeNull();
  });
});

describe('peak RSS', () => {
  it('reads this process high-water mark from /proc', () => {
    const peak = readPeakRssKb(process.pid);
    expect(peak === null || peak > 0).toBe(true);
  });

  it('returns null for a process that does not exist', () => {
    expect(readPeakRssKb(999_999_999)).toBeNull();
  });
});
