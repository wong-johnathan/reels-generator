/**
 * Content-addressed store (R-026): one object per hash, key derived from
 * content, and a mismatched key refused instead of written.
 */
import { describe, expect, it } from 'vitest';

import {
  ensureBucket,
  InMemoryBucketStore,
  InMemoryContentAddressedStore,
  InvalidContentHashError,
  ObjectKeyMismatchError,
  objectKeyFor,
  sha256Hex,
} from './object-store.js';

const BYTES = new Uint8Array([1, 2, 3, 4]);

describe('object store (R-026)', () => {
  it('derives the object key from the content hash only', () => {
    const hash = sha256Hex(BYTES);
    expect(objectKeyFor(hash)).toBe('sha256:' + hash);
  });

  it('rejects a hash that is not 64 lowercase hex characters', () => {
    for (const bad of ['', 'xyz', 'A'.repeat(64), 'a'.repeat(63)]) {
      expect(() => objectKeyFor(bad), bad).toThrow(InvalidContentHashError);
    }
  });

  it('stores one object per hash and reports the dedupe hit', async () => {
    const store = new InMemoryContentAddressedStore();
    const key = objectKeyFor(sha256Hex(BYTES));
    expect(await store.put(key, BYTES, 'image/png')).toEqual({ created: true });
    expect(await store.put(key, BYTES, 'image/png')).toEqual({ created: false });
    expect(store.size).toBe(1);
    expect(await store.has(key)).toBe(true);
    expect((await store.get(key))?.bytes).toEqual(BYTES);
  });

  it('refuses bytes whose hash does not match the key (no unreachable object)', async () => {
    const store = new InMemoryContentAddressedStore();
    const wrongKey = objectKeyFor(sha256Hex(new Uint8Array([9, 9, 9])));
    await expect(store.put(wrongKey, BYTES, 'image/png')).rejects.toThrow(ObjectKeyMismatchError);
    expect(store.size).toBe(0);
  });

  it('returns a copy so a caller cannot mutate stored bytes', async () => {
    const store = new InMemoryContentAddressedStore();
    const key = objectKeyFor(sha256Hex(BYTES));
    await store.put(key, BYTES, 'image/png');
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
