/**
 * Blob store port — TECH_DESIGN 3.4 / 11.2.
 *
 * The name `ContentAddressedStore` is historical (deviation D-F): object keys
 * were once a pure function of the content hash (`sha256:<64 hex>`, R-026), and
 * this port carried the dedupe-by-hash contract. Keys are now readable paths
 * (`<series-slug>/batch-0001/video.mp4`, see `object-key.ts`) and `put()` no
 * longer derives or verifies the key against the bytes — a re-render may write
 * different bytes under the same path. The port shape (put/get/has) is
 * unchanged; `sha256Hex` stays for the `content_sha256` provenance column.
 *
 * MinIO is the production backend (TECH_DESIGN 2.1). The stage depends on this
 * port, not on an S3 client, and the in-memory implementation is the
 * deterministic fake of TECH_DESIGN 11.1.
 */
import { createHash } from 'node:crypto';

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface StoredObject {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

export interface PutResult {
  /** false when the key already held an object (the write was a no-op replace). */
  readonly created: boolean;
}

export interface ContentAddressedStore {
  /** Writes bytes under `objectKey`; the same key written again overwrites. */
  put(objectKey: string, bytes: Uint8Array, mimeType: string): Promise<PutResult>;
  get(objectKey: string): Promise<StoredObject | null>;
  has(objectKey: string): Promise<boolean>;
}

/** In-memory store: the deterministic fake, usable without MinIO or a network. */
export class InMemoryContentAddressedStore implements ContentAddressedStore {
  private readonly objects = new Map<string, StoredObject>();

  async put(objectKey: string, bytes: Uint8Array, mimeType: string): Promise<PutResult> {
    const had = this.objects.has(objectKey);
    this.objects.set(objectKey, { bytes: Uint8Array.from(bytes), mimeType });
    return { created: !had };
  }

  async get(objectKey: string): Promise<StoredObject | null> {
    const stored = this.objects.get(objectKey);
    if (stored === undefined) return null;
    return { bytes: Uint8Array.from(stored.bytes), mimeType: stored.mimeType };
  }

  async has(objectKey: string): Promise<boolean> {
    return this.objects.has(objectKey);
  }

  /** The number of distinct keys. */
  get size(): number {
    return this.objects.size;
  }

  keys(): string[] {
    return [...this.objects.keys()];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bucket lifecycle — TECH_DESIGN §2.1 (MinIO), boot-time ensure (R-018)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The smallest object-storage *bucket* surface the worker needs at boot: check
 * the bucket exists and create it when it does not. Kept separate from
 * `ContentAddressedStore` on purpose — a blob store has no bucket concept, and
 * forcing `makeBucket` onto it would conflate two concerns.
 *
 * There is no MinIO/S3 client in this repo and `@aws-sdk/client-s3` is not a
 * dependency, so this milestone ships the deterministic in-memory binding and
 * records the gap: a real MinIO binding (against `MINIO_ENDPOINT` /
 * `MINIO_BUCKET`) is an image/dependency change, not an orchestration change.
 */
export interface ObjectBucketStore {
  bucketExists(name: string): Promise<boolean>;
  makeBucket(name: string): Promise<void>;
}

/** Deterministic in-memory bucket set; `makeBucket` is idempotent by construction. */
export class InMemoryBucketStore implements ObjectBucketStore {
  private readonly buckets = new Set<string>();

  async bucketExists(name: string): Promise<boolean> {
    return this.buckets.has(name);
  }

  async makeBucket(name: string): Promise<void> {
    this.buckets.add(name);
  }
}

/**
 * Idempotent boot-time ensure: create the bucket only when it is absent.
 * Returns `true` when this call created it, `false` when it already existed —
 * the caller logs which happened, and re-running at every boot is safe.
 */
export async function ensureBucket(
  store: ObjectBucketStore,
  name: string,
): Promise<{ created: boolean }> {
  if (name.trim().length === 0) throw new RangeError('bucket name must not be empty');
  if (await store.bucketExists(name)) return { created: false };
  await store.makeBucket(name);
  return { created: true };
}
