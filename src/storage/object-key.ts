/**
 * Readable object keys — deviation D-F from R-026's content addressing.
 *
 * Objects are addressed by where they belong rather than by the hash of their
 * bytes, so a human browsing the MinIO bucket can read the library:
 *
 *   <series-slug>/batch-0001/script.json
 *   <series-slug>/batch-0001/storyboard.json
 *   <series-slug>/batch-0001/scenes/S01.png … S17.png
 *   <series-slug>/batch-0001/narration.mp3
 *   <series-slug>/batch-0001/narration-alignment.json
 *   <series-slug>/batch-0001/video.mp4
 *
 * `content_sha256` stays on the `asset` row as provenance; it just no longer
 * decides the key. The slug here is normalised exactly like `downloadFilename`
 * (src/web/download/postgres.ts) so the bucket folder and the downloaded
 * filename agree on the series name.
 */

/** Normalise a series slug: lower-case, non-alphanumerics collapse to `-`, no
 * leading/trailing `-`, and `series` as the empty fallback (same rule as the
 * download filename, without the position suffix). */
export function slugifySeries(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'series'
  );
}

/** `batch-0001`, `batch-0012`, … — zero-padded so the bucket lists in order. */
export function batchFolder(batchOrdinal: number): string {
  return 'batch-' + String(batchOrdinal).padStart(4, '0');
}

export interface AssetObjectKey {
  readonly seriesSlug: string;
  readonly batchOrdinal: number;
  /** The file path inside the batch folder, e.g. `scenes/S07.png`. */
  readonly name: string;
}

/** `<series-slug>/batch-0001/<name>` — the one key shape every asset writer uses. */
export function assetObjectKey({ seriesSlug, batchOrdinal, name }: AssetObjectKey): string {
  return slugifySeries(seriesSlug) + '/' + batchFolder(batchOrdinal) + '/' + name;
}

/** Scene image: `scenes/S07.png`. The scene number is the stable storyboard id
 * (R-007-2), not an array index — a reorder moves the scene, not its image. */
export function sceneImageName(sceneNo: string): string {
  return 'scenes/' + sceneNo + '.png';
}

// The primary layout files, named in DEVIATIONS D-F.
export const SCRIPT_OBJECT_NAME = 'script.json';
export const STORYBOARD_OBJECT_NAME = 'storyboard.json';
export const NARRATION_OBJECT_NAME = 'narration.mp3';
export const NARRATION_ALIGNMENT_OBJECT_NAME = 'narration-alignment.json';
export const VIDEO_OBJECT_NAME = 'video.mp4';

// Secondary artefacts written later in the rail. They were never part of the six
// primary layout files but still live in the batch folder so the bucket stays
// browsable end to end.
export const TIMING_OBJECT_NAME = 'timing.json';
export const QC_REPORT_OBJECT_NAME = 'qc-report.json';
export const CAPTIONS_SRT_OBJECT_NAME = 'captions.srt';
export const CAPTIONS_VTT_OBJECT_NAME = 'captions.vtt';
export const CAPTIONS_ASS_OBJECT_NAME = 'captions.ass';
export const RENDER_MANIFEST_OBJECT_NAME = 'render-manifest.json';
export const RENDER_BENCHMARK_OBJECT_NAME = 'render-benchmark.json';
export const PACKAGE_MANIFEST_OBJECT_NAME = 'package-manifest.json';
