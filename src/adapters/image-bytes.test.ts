import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  encodePng,
  readImageDimensions,
  readPngText,
  UnsupportedImageFormatError,
} from './image-bytes.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

/** A syntactically valid JPEG header carrying a SOF0 with the given geometry. */
function jpegWithSof0(width: number, height: number): Uint8Array {
  const high = (value: number) => Math.floor(value / 256) % 256;
  const low = (value: number) => value % 256;
  return new Uint8Array(
    Buffer.from([
      0xff,
      0xd8, // SOI
      0xff,
      0xc0,
      0x00,
      0x11, // SOF0, length 17
      0x08, // precision
      high(height),
      low(height),
      high(width),
      low(width),
      0x03, // three components
      0x01,
      0x11,
      0x00,
      0x02,
      0x11,
      0x01,
      0x03,
      0x11,
      0x01,
      0xff,
      0xd9, // EOI
    ]),
  );
}

describe('encodePng', () => {
  it('writes a PNG signature and an IHDR the geometry parser reads back', () => {
    const bytes = encodePng({
      width: 768,
      height: 1376,
      pixel: (x, y) => [x % 256, y % 256, (x + y) % 256],
    });

    expect([...bytes.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(readImageDimensions(bytes)).toEqual({ format: 'png', width: 768, height: 1376 });
  });

  it('is deterministic for the same pixels and carries tEXt chunks', () => {
    const pixel = (x: number, y: number) => [x % 7, y % 11, 3] as const;
    const first = encodePng({ width: 16, height: 8, pixel, text: { reels_refs: 'abc123' } });
    const second = encodePng({ width: 16, height: 8, pixel, text: { reels_refs: 'abc123' } });

    expect(bytesEqual(first, second)).toBe(true);
    expect(readPngText(first, 'reels_refs')).toBe('abc123');
    expect(readPngText(first, 'absent')).toBeNull();
  });

  it('writes a real zlib stream: one filter byte plus RGB per pixel per row', () => {
    const width = 5;
    const height = 3;
    const bytes = encodePng({
      width,
      height,
      pixel: () => [1, 2, 3],
      text: { marker: 'x' },
    });

    const view = Buffer.from(bytes);
    let offset = 8;
    let idat: Buffer | null = null;
    while (offset < view.length) {
      const length = view.readUInt32BE(offset);
      const type = view.toString('ascii', offset + 4, offset + 8);
      if (type === 'IDAT') idat = view.subarray(offset + 8, offset + 8 + length);
      offset += 12 + length;
    }

    expect(idat).not.toBeNull();
    const raw = inflateSync(idat as Buffer);
    expect(raw.length).toBe(height * (1 + width * 3));
    expect(raw[0]).toBe(0); // filter type "none" on row 0
  });
});

describe('readImageDimensions', () => {
  it('reads a JPEG SOF0 geometry', () => {
    expect(readImageDimensions(jpegWithSof0(768, 1376))).toEqual({
      format: 'jpeg',
      width: 768,
      height: 1376,
    });
  });

  it('rejects an unsupported container instead of guessing', () => {
    const webp = new Uint8Array(Buffer.from('RIFF....WEBPVP8 ', 'ascii'));
    expect(() => readImageDimensions(webp)).toThrow(UnsupportedImageFormatError);
  });

  it('rejects a truncated PNG', () => {
    const bytes = encodePng({ width: 2, height: 2, pixel: () => [0, 0, 0] });
    expect(() => readImageDimensions(bytes.subarray(0, 12))).toThrow(UnsupportedImageFormatError);
  });
});
