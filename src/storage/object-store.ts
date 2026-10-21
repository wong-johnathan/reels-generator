/**
 * Content-addressed blob store — TECH_DESIGN 3.4 / 11.2, R-026.
 *
 * The object key is a pure function of the content hash ("sha256:<64 hex>"), so
 * the store can never hold two blobs for one hash and the object count equals
 * the unique-hash count (R-026-2). put() verifies the key against the bytes it
 * was handed: a caller that hashes one thing and stores another fails loudly
 * instead of writing an object nothing can reach.
 *
 * MinIO is the production backend (TECH_DESIGN 2.1). The stage depends on this
 * port, not on an S3 client, and the in-memory implementation is the
 * "fake object store (in-memory, content-addressed)" of TECH_DESIGN 11.1.
 */
import { createHash } from 'node:crypto';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class InvalidContentHashError extends Error {
  constructor(readonly value: string) {
    super('content hash must be 64 lowercase hex characters, got "' + value + '"');
    this.name = 'InvalidContentHashError';
  }
}

export class ObjectKeyMismatchError extends Error {
  constructor(
    readonly objectKey: string,
    readonly expectedKey: string,
  ) {
    super(
      'object key "' +
        objectKey +
        '" does not match sha256(bytes) ("' +
        expectedKey +
        '"): R-026-2 ' +
        'requires object_key to be a pure function of the content hash',
    );
    this.name = 'ObjectKeyMismatchError';
  }
}

/** TECH_DESIGN 3.1: object_key = "sha256:" || content_sha256. */
export function objectKeyFor(contentSha256: string): string {
  if (!SHA256_PATTERN.test(contentSha256)) throw new InvalidContentHashError(contentSha256);
  return 'sha256:' + contentSha256;
}

export interface StoredObject {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

export interface PutResult {
  /** false when the content-addressed key already held these bytes (dedupe hit). */
  readonly created: boolean;
}

export interface ContentAddressedStore {
  /** Idempotent by key: storing the same bytes twice creates one object. */
  put(objectKey: string, bytes: Uint8Array, mimeType: string): Promise<PutResult>;
  get(objectKey: string): Promise<StoredObject | null>;
  has(objectKey: string): Promise<boolean>;
}

/** In-memory store: the deterministic fake, usable without MinIO or a network. */
export class InMemoryContentAddressedStore implements ContentAddressedStore {
  private readonly objects = new Map<string, StoredObject>();

  async put(objectKey: string, bytes: Uint8Array, mimeType: string): Promise<PutResult> {
    const expected = objectKeyFor(sha256Hex(bytes));
    if (expected !== objectKey) throw new ObjectKeyMismatchError(objectKey, expected);
    if (this.objects.has(objectKey)) return { created: false };
    this.objects.set(objectKey, { bytes: Uint8Array.from(bytes), mimeType });
    return { created: true };
  }

  async get(objectKey: string): Promise<StoredObject | null> {
    const stored = this.objects.get(objectKey);
    if (stored === undefined) return null;
    return { bytes: Uint8Array.from(stored.bytes), mimeType: stored.mimeType };
  }

  async has(objectKey: string): Promise<boolean> {
    return this.objects.has(objectKey);
  }

  /** The number of distinct blobs — the R-026-2 assertion surface. */
  get size(): number {
    return this.objects.size;
  }

  keys(): string[] {
    return [...this.objects.keys()];
  }
}
