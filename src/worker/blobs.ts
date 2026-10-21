/**
 * A single backing store that serves *both* blob-store ports.
 *
 * The codebase has two parallel ports — `ContentAddressedStore`
 * (image/render, `storage/object-store.ts`) and `AssetBlobStore`
 * (narration/timing, `workers/asset-store.ts`). In production both point at the
 * same MinIO bucket; in the local/CI fake path a single in-memory map must back
 * both, or a narration the NA stage writes would be invisible to the render
 * stage that reads it. This wrapper is that bridge: one map, two facades.
 *
 * Keys are readable paths now (deviation D-F), so neither facade verifies the
 * key against the bytes; a write under an existing key simply overwrites.
 */
import { type ContentAddressedStore } from '../storage/object-store.js';
import { BlobNotFoundError, type AssetBlobStore } from '../workers/asset-store.js';

export class SharedBlobStore {
  private readonly objects = new Map<string, { bytes: Uint8Array; mimeType: string }>();

  readonly content: ContentAddressedStore = {
    put: async (key, bytes, mimeType) => {
      const had = this.objects.has(key);
      this.objects.set(key, { bytes: Uint8Array.from(bytes), mimeType });
      return { created: !had };
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
      this.objects.set(key, { bytes: Uint8Array.from(bytes), mimeType: contentType });
    },
    get: async (key) => {
      const stored = this.objects.get(key);
      if (stored === undefined) throw new BlobNotFoundError(key);
      return Uint8Array.from(stored.bytes);
    },
    has: async (key) => this.objects.has(key),
  };

  /** The number of distinct keys. */
  get size(): number {
    return this.objects.size;
  }
}
