import { describe, expect, it } from 'vitest';

import {
  buildVideoPackage,
  projectFragment,
  slugify,
  SOURCE_MANIFEST_SCHEMA_VERSION,
  VIDEO_METADATA_SCHEMA_VERSION,
} from './package.js';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function build(overrides: Partial<Parameters<typeof buildVideoPackage>[0]> = {}) {
  return buildVideoPackage({
    projectId: '11111111-2222-3333-4444-555555555555',
    seriesSlug: 'Quiet Machines',
    seriesVersionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    videoSlug: 'The Attention Tax',
    video: { bytes: enc('mp4-bytes'), mimeType: 'video/mp4' },
    srt: { bytes: enc('1\n00:00:00,000 --> 00:00:01,000\nhi\n') },
    vtt: { bytes: enc('WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nhi\n') },
    metadata: {
      title: 'The Attention Tax',
      description: 'A short description.',
      hashtags: ['#focus', '#psychology'],
      durationS: 75.1,
      width: 1080,
      height: 1920,
      fps: 30,
    },
    sources: { mode: 'factual', claims: [] },
    generatedAt: new Date('2026-10-21T00:00:00Z'),
    ...overrides,
  });
}

describe('slugify', () => {
  it('produces a lowercase ASCII filename component', () => {
    expect(slugify('Quiet Machines & Neuro-Drama!')).toBe('quiet-machines-neuro-drama');
    expect(slugify('  ---  ')).toBe('video');
    expect(slugify('Café Society')).toBe('cafe-society');
    expect(slugify('x'.repeat(80), 10)).toBe('x'.repeat(10));
  });
});

describe('buildVideoPackage (R-014-1, US-026)', () => {
  it('contains exactly the MP4, .srt, .vtt, metadata.json and sources.json', () => {
    const pkg = build();
    expect(pkg.files.map((file) => file.name)).toEqual([
      'quiet-machines-11111111-the-attention-tax.mp4',
      'quiet-machines-11111111-the-attention-tax.srt',
      'quiet-machines-11111111-the-attention-tax.vtt',
      'metadata.json',
      'sources.json',
    ]);
    expect(pkg.files.map((file) => file.kind)).toEqual([
      'video',
      'srt',
      'vtt',
      'sidecar',
      'sidecar',
    ]);
    expect(pkg.total_bytes).toBe(pkg.files.reduce((sum, file) => sum + file.size_bytes, 0));
  });

  it('records a sha256 and size for every file', () => {
    const pkg = build();
    for (const file of pkg.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.size_bytes).toBeGreaterThan(0);
    }
    const video = pkg.contents.find((entry) => entry.record.kind === 'video');
    expect(video?.bytes).toEqual(enc('mp4-bytes'));
  });

  it('writes the metadata sidecar with title, description and hashtags', () => {
    const pkg = build();
    const sidecar = pkg.contents.find((entry) => entry.record.name === 'metadata.json');
    const document = JSON.parse(new TextDecoder().decode(sidecar!.bytes)) as Record<
      string,
      unknown
    >;
    expect(document).toMatchObject({
      schema_version: VIDEO_METADATA_SCHEMA_VERSION,
      project_id: '11111111-2222-3333-4444-555555555555',
      series_slug: 'quiet-machines',
      series_version_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      title: 'The Attention Tax',
      description: 'A short description.',
      hashtags: ['#focus', '#psychology'],
      duration_s: 75.1,
      width: 1080,
      height: 1920,
      fps: 30,
      generated_at: '2026-10-21T00:00:00.000Z',
    });
    expect(document.captions).toEqual({
      srt: 'quiet-machines-11111111-the-attention-tax.srt',
      vtt: 'quiet-machines-11111111-the-attention-tax.vtt',
    });
  });

  it('copies factual claims into the source manifest', () => {
    const claim = {
      claim_text: 'Attention compounds.',
      url: 'https://example.test/attention',
      retrieved_at: '2026-10-20T10:00:00.000Z',
      status: 'sourced',
      acknowledged_by: null,
      acknowledged_at: null,
    };
    const pkg = build({ sources: { mode: 'factual', claims: [claim] } });
    expect(pkg.sources).toEqual({
      schema_version: SOURCE_MANIFEST_SCHEMA_VERSION,
      mode: 'factual',
      claims: [claim],
    });
  });

  it('records no citation rows in creative mode (R-027-4)', () => {
    const pkg = build({
      sources: {
        mode: 'creative',
        claims: [
          {
            claim_text: 'Invented but true to life.',
            url: '',
            retrieved_at: null,
            status: 'unsourced',
            acknowledged_by: null,
            acknowledged_at: null,
          },
        ],
      },
    });
    expect(pkg.sources.mode).toBe('creative');
    expect(pkg.sources.claims).toEqual([]);
  });

  it('is unique per project even when two videos share a title', () => {
    const first = build();
    const second = build({ projectId: '99999999-2222-3333-4444-555555555555' });
    expect(first.stem).not.toBe(second.stem);
    expect(first.files[0]!.name).not.toBe(second.files[0]!.name);
  });

  it('takes the first eight characters of the project id', () => {
    expect(projectFragment('11111111-2222-3333-4444-555555555555')).toBe('11111111');
  });
});
