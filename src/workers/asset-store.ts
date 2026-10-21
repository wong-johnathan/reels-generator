/**
 * Content-addressed object store port for the media the NA/TC stages produce
 * (TECH_DESIGN §3.4, R-026).
 *
 * The database row is the authority: `object_key` is a pure function of
 * `content_sha256` (`'sha256:' || hash`) and is enforced by the
 * `asset_object_key_matches_hash` CHECK constraint. The store therefore only has
 * to hold bytes under a key the caller already derived — there is no naming
 * decision left to the storage layer, and storing the same bytes twice is a
 * no-op by construction.
 *
 * Milestone A ships the port plus a deterministic in-memory implementation.
 * The MinIO binding is deliberately *not* here: B-01's scaffold has no S3/MinIO
 * client dependency, and adding one is an image/dependency change outside this
 * card. `src/worker/main.ts` injects the real store once that binding lands.
 */
import { createHash } from 'node:crypto';

/** The one prefix the `asset.object_key` constraint allows. */
export const OBJECT_KEY_PREFIX = 'sha256:';

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function objectKeyFor(contentSha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(contentSha256)) {
    throw new RangeError('content_sha256 must be 64 lowercase hex characters (R-026)');
  }
  return `${OBJECT_KEY_PREFIX}${contentSha256}`;
}

/** UTF-8 JSON bytes — the sidecar documents are stored content-addressed too. */
export function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface AssetBlobStore {
  /** Idempotent: the same key (same content) may be written any number of times. */
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
    const copy = new Uint8Array(bytes);
    const existing = this.objects.get(objectKey);
    if (existing !== undefined) {
      if (sha256Hex(existing.bytes) !== sha256Hex(copy)) {
        throw new Error(
          `object ${objectKey} already holds different bytes (R-026: key is the hash)`,
        );
      }
      return;
    }
    this.objects.set(objectKey, { bytes: copy, contentType });
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
