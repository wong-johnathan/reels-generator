/**
 * The per-video export package — US-026 / R-014-1, TECH_DESIGN §8.1/§8.2.
 *
 * One directory per video containing the MP4, captions in both `.srt` and
 * `.vtt`, `metadata.json` (title, description, hashtags) and `sources.json` (the
 * source manifest). This module is pure: it takes bytes and documents in and
 * returns content-addressed file records out, so the export stage can persist
 * them without a second copy of the naming rules.
 *
 * Naming is unique by construction (`<series-slug>-<project8>-<video-slug>`) and
 * every file of one package shares the stem, which is what makes a batch ZIP
 * verify later (US-027, TECH_DESIGN §8.3).
 */
import { createHash } from 'node:crypto';

export const VIDEO_METADATA_SCHEMA_VERSION = 'video-metadata.v1';
export const SOURCE_MANIFEST_SCHEMA_VERSION = 'source-manifest.v1';

export type PackageFileKind = 'video' | 'srt' | 'vtt' | 'sidecar';

export interface PackageFileRecord {
  readonly name: string;
  readonly kind: PackageFileKind;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly mime_type: string;
}

export interface PackageBytes {
  readonly record: PackageFileRecord;
  readonly bytes: Uint8Array;
}

/** One row of `sources.json` — TECH_DESIGN §8.2's claim manifest. */
export interface SourceManifestClaim {
  readonly claim_text: string;
  readonly url: string;
  readonly retrieved_at: string | null;
  readonly status: string;
  readonly acknowledged_by: string | null;
  readonly acknowledged_at: string | null;
}

export interface VideoMetadataDocument {
  readonly schema_version: typeof VIDEO_METADATA_SCHEMA_VERSION;
  readonly project_id: string;
  readonly series_slug: string;
  readonly series_version_id: string | null;
  readonly title: string;
  readonly description: string;
  readonly hashtags: readonly string[];
  readonly duration_s: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly video_file: string;
  readonly captions: { readonly srt: string; readonly vtt: string };
  readonly generated_at: string;
}

export interface SourceManifestDocument {
  readonly schema_version: typeof SOURCE_MANIFEST_SCHEMA_VERSION;
  readonly mode: 'factual' | 'creative';
  readonly claims: readonly SourceManifestClaim[];
}

export interface BuildVideoPackageInput {
  readonly projectId: string;
  readonly seriesSlug: string;
  readonly seriesVersionId?: string | null;
  /** Short human slug for the video itself; falls back to the project id. */
  readonly videoSlug?: string | null;
  readonly video: { readonly bytes: Uint8Array; readonly mimeType: string };
  readonly srt: { readonly bytes: Uint8Array };
  readonly vtt: { readonly bytes: Uint8Array };
  readonly metadata: {
    readonly title: string;
    readonly description: string;
    readonly hashtags: readonly string[];
    readonly durationS: number;
    readonly width: number;
    readonly height: number;
    readonly fps: number;
  };
  readonly sources: {
    readonly mode: 'factual' | 'creative';
    readonly claims: readonly SourceManifestClaim[];
  };
  readonly generatedAt?: Date;
}

export interface VideoPackage {
  readonly stem: string;
  readonly files: readonly PackageFileRecord[];
  readonly contents: readonly PackageBytes[];
  readonly total_bytes: number;
  readonly metadata: VideoMetadataDocument;
  readonly sources: SourceManifestDocument;
}

/** Lowercase, ASCII, hyphenated, bounded — a filename component, not a title. */
export function slugify(value: string, maxLength = 48): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (slug === '' ? 'video' : slug).slice(0, maxLength).replace(/-+$/g, '');
}

/** The eight-character project fragment that keeps sibling videos unique. */
export function projectFragment(projectId: string): string {
  return projectId.replace(/-/g, '').slice(0, 8);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function utf8(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n');
}

function fileRecord(
  name: string,
  kind: PackageFileKind,
  bytes: Uint8Array,
  mimeType: string,
): PackageBytes {
  return {
    record: {
      name,
      kind,
      size_bytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
      mime_type: mimeType,
    },
    bytes,
  };
}

/**
 * Build the package. R-014-1's four artefacts plus the two sidecars; the MP4 is
 * the already-rendered, already-QC'd bytes — this builder never transcodes.
 */
export function buildVideoPackage(input: BuildVideoPackageInput): VideoPackage {
  const stem = [
    slugify(input.seriesSlug, 32),
    projectFragment(input.projectId),
    slugify(input.videoSlug ?? input.metadata.title, 32),
  ].join('-');

  const videoName = `${stem}.mp4`;
  const srtName = `${stem}.srt`;
  const vttName = `${stem}.vtt`;
  const metadataName = 'metadata.json';
  const sourcesName = 'sources.json';

  const metadata: VideoMetadataDocument = {
    schema_version: VIDEO_METADATA_SCHEMA_VERSION,
    project_id: input.projectId,
    series_slug: slugify(input.seriesSlug, 32),
    series_version_id: input.seriesVersionId ?? null,
    title: input.metadata.title,
    description: input.metadata.description,
    hashtags: [...input.metadata.hashtags],
    duration_s: Math.round(input.metadata.durationS * 1000) / 1000,
    width: input.metadata.width,
    height: input.metadata.height,
    fps: input.metadata.fps,
    video_file: videoName,
    captions: { srt: srtName, vtt: vttName },
    generated_at: (input.generatedAt ?? new Date()).toISOString(),
  };

  const sources: SourceManifestDocument = {
    schema_version: SOURCE_MANIFEST_SCHEMA_VERSION,
    mode: input.sources.mode,
    // R-027-4: creative mode applies no citation rows at all.
    claims: input.sources.mode === 'creative' ? [] : [...input.sources.claims],
  };

  const contents: PackageBytes[] = [
    fileRecord(videoName, 'video', input.video.bytes, input.video.mimeType),
    fileRecord(srtName, 'srt', input.srt.bytes, 'application/x-subrip'),
    fileRecord(vttName, 'vtt', input.vtt.bytes, 'text/vtt'),
    fileRecord(metadataName, 'sidecar', utf8(metadata), 'application/json'),
    fileRecord(sourcesName, 'sidecar', utf8(sources), 'application/json'),
  ];

  return {
    stem,
    files: contents.map((entry) => entry.record),
    contents,
    total_bytes: contents.reduce((total, entry) => total + entry.record.size_bytes, 0),
    metadata,
    sources,
  };
}
