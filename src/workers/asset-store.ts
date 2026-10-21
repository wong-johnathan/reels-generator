/**
 * Blob store port for the media the NA/TC/SB stages produce.
 *
 * The database row is the authority: `object_key` is a readable path
 * (`<series-slug>/batch-0001/…`, deviation D-F), not a hash. The store only
 * holds bytes under the key the caller already derived from `object-key.ts` —
 * there is no naming decision left to the storage layer, and a re-render that
 * writes different bytes under the same path overwrites rather than refuses.
 *
 * `sha256Hex` stays: it feeds the `content_sha256` provenance column, which no
 * longer dedupes but still records what the bytes were.
 *
 * Milestone A ships the port plus a deterministic in-memory implementation.
 * The MinIO binding is deliberately *not* here: B-01's scaffold has no S3/MinIO
 * client dependency, and adding one is an image/dependency change outside this
 * card. `src/worker/main.ts` injects the real store once that binding lands.
 */
import { createHash } from 'node:crypto';

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** UTF-8 JSON bytes — the sidecar documents are stored as JSON. */
export function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface AssetBlobStore {
  /** Writes bytes under `objectKey`; the same key written again overwrites. */
  put(objectKey: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(objectKey: string): Promise<Uint8Array>;
  has(objectKey: string): Promise<boolean>;
}

export class BlobNotFoundError extends Error {
  constructor(objectKey: string) {
    super(`no object is stored under ${objectKey}`);
    this.name = 'BlobNotFoundError';
  }
}

/**
 * Deterministic, process-local store used by the tests and by the local
 * (non-compose) execution path. It copies bytes on the way in and out so a
 * caller cannot mutate stored content through an aliased buffer.
 */
export class InMemoryBlobStore implements AssetBlobStore {
  private readonly objects = new Map<string, StoredObject>();

  get size(): number {
    return this.objects.size;
  }

  keys(): readonly string[] {
    return [...this.objects.keys()].sort();
  }

  async put(objectKey: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(objectKey, { bytes: new Uint8Array(bytes), contentType });
  }

  async get(objectKey: string): Promise<Uint8Array> {
    const stored = this.objects.get(objectKey);
    if (stored === undefined) throw new BlobNotFoundError(objectKey);
    return new Uint8Array(stored.bytes);
  }

  async has(objectKey: string): Promise<boolean> {
    return this.objects.has(objectKey);
  }
}
