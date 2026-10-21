/**
 * Blob store port (deviation D-F): keys are readable paths now, so put() does
 * not derive or verify the key against the bytes — a write under an existing
 * key overwrites. `sha256Hex` stays for the provenance column.
 */
import { describe, expect, it } from 'vitest';

import {
  ensureBucket,
  InMemoryBucketStore,
  InMemoryContentAddressedStore,
  sha256Hex,
} from './object-store.js';

const BYTES = new Uint8Array([1, 2, 3, 4]);

describe('object store (D-F readable keys)', () => {
  it('hashes bytes for the provenance column', () => {
    expect(sha256Hex(BYTES)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores bytes under any key and reports the first write', async () => {
    const store = new InMemoryContentAddressedStore();
    expect(await store.put('series/batch-0001/scenes/S01.png', BYTES, 'image/png')).toEqual({
      created: true,
    });
    expect(store.size).toBe(1);
    expect(await store.has('series/batch-0001/scenes/S01.png')).toBe(true);
    expect((await store.get('series/batch-0001/scenes/S01.png'))?.bytes).toEqual(BYTES);
  });

  it('overwrites the same key rather than refusing (a re-render writes new bytes)', async () => {
    const store = new InMemoryContentAddressedStore();
    const key = 'series/batch-0001/video.mp4';
    await store.put(key, BYTES, 'video/mp4');
    const replacement = new Uint8Array([9, 9, 9]);
    expect(await store.put(key, replacement, 'video/mp4')).toEqual({ created: false });
    expect(store.size).toBe(1);
    expect((await store.get(key))?.bytes).toEqual(replacement);
  });

  it('returns a copy so a caller cannot mutate stored bytes', async () => {
    const store = new InMemoryContentAddressedStore();
    const key = 'series/batch-0001/narration.mp3';
    await store.put(key, BYTES, 'audio/wav');
    const first = await store.get(key);
    first?.bytes.fill(0);
    expect((await store.get(key))?.bytes).toEqual(BYTES);
  });
});

describe('bucket ensure at boot (R-018)', () => {
  it('creates the bucket on first call and reports it', async () => {
    const store = new InMemoryBucketStore();
    expect(await ensureBucket(store, 'reels')).toEqual({ created: true });
    expect(await store.bucketExists('reels')).toBe(true);
  });

  it('is idempotent on re-run (no duplicate create)', async () => {
    const store = new InMemoryBucketStore();
    await ensureBucket(store, 'reels');
    expect(await ensureBucket(store, 'reels')).toEqual({ created: false });
  });

  it('refuses an empty bucket name', async () => {
    const store = new InMemoryBucketStore();
    await expect(ensureBucket(store, '   ')).rejects.toThrow(RangeError);
  });
});
