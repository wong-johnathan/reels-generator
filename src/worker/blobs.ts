/**
 * A single backing store that serves *both* blob-store ports.
 *
 * The codebase has two parallel content-addressed ports — `ContentAddressedStore`
 * (image/render, `storage/object-store.ts`) and `AssetBlobStore`
 * (narration/timing, `workers/asset-store.ts`). In production both point at the
 * same MinIO bucket; in the local/CI fake path a single in-memory map must back
 * both, or a narration the NA stage writes would be invisible to the render
 * stage that reads it. This wrapper is that bridge: one map, two facades.
 */
import {
  objectKeyFor,
  sha256Hex,
  ObjectKeyMismatchError,
  type ContentAddressedStore,
} from '../storage/object-store.js';
import { BlobNotFoundError, type AssetBlobStore } from '../workers/asset-store.js';

export class SharedBlobStore {
  private readonly objects = new Map<string, { bytes: Uint8Array; mimeType: string }>();

  readonly content: ContentAddressedStore = {
    put: async (key, bytes, mimeType) => {
      const expected = objectKeyFor(sha256Hex(bytes));
      if (expected !== key) throw new ObjectKeyMismatchError(key, expected);
      if (this.objects.has(key)) return { created: false };
      this.objects.set(key, { bytes: Uint8Array.from(bytes), mimeType });
      return { created: true };
    },
    get: async (key) => {
      const stored = this.objects.get(key);
      if (stored === undefined) return null;
      return { bytes: Uint8Array.from(stored.bytes), mimeType: stored.mimeType };
    },
    has: async (key) => this.objects.has(key),
  };

  readonly asset: AssetBlobStore = {
    put: async (key, bytes, contentType) => {
      const existing = this.objects.get(key);
      if (existing !== undefined) {
        if (sha256Hex(existing.bytes) !== sha256Hex(bytes)) {
          throw new Error(`object ${key} already holds different bytes (R-026: key is the hash)`);
        }
        return;
      }
      this.objects.set(key, { bytes: Uint8Array.from(bytes), mimeType: contentType });
    },
    get: async (key) => {
      const stored = this.objects.get(key);
      if (stored === undefined) throw new BlobNotFoundError(key);
      return Uint8Array.from(stored.bytes);
    },
    has: async (key) => this.objects.has(key),
  };

  /** The number of distinct blobs — the R-026-2 assertion surface. */
  get size(): number {
    return this.objects.size;
  }
}
