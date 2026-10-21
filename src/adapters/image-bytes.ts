/**
 * Minimal image byte plumbing shared by the fake and the paid image adapter.
 *
 * Two jobs only:
 * - encode a real, decodable RGB PNG (the deterministic fake's output — FFmpeg
 *   and the later QC stage can actually read it, unlike random bytes);
 * - read the geometry of what came back (PNG IHDR / JPEG SOF) instead of
 *   trusting the provider's claim, plus tEXt chunks for the fake's provenance.
 *
 * No image library is added: a PNG writer is ~50 lines and a header parse is
 * smaller than the dependency would be (B-01 keeps the runtime to pg + zod).
 */
import { deflateSync } from 'node:zlib';

export class UnsupportedImageFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedImageFormatError';
  }
}

export interface ImageDimensions {
  readonly format: 'png' | 'jpeg';
  readonly width: number;
  readonly height: number;
}

export interface EncodePngOptions {
  readonly width: number;
  readonly height: number;
  readonly pixel: (x: number, y: number) => readonly [number, number, number];
  /** tEXt chunks, written in object order (deterministic for string keys). */
  readonly text?: Readonly<Record<string, string>>;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const SOF_MARKERS = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf];

const STANDALONE_MARKERS = [0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7];

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c % 2 === 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    const index = ((crc ^ byte) >>> 0) % 256;
    crc = (CRC_TABLE[index]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, checksum]);
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function assertDimension(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 16_384) {
    throw new RangeError(`${name} must be an integer 1..16384, got ${String(value)}`);
  }
}

/** Encode a filter-0 (none), 8-bit truecolour PNG. Deterministic for equal input. */
export function encodePng(options: EncodePngOptions): Uint8Array {
  assertDimension('width', options.width);
  assertDimension('height', options.height);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(options.width, 0);
  ihdr.writeUInt32BE(options.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none

  const raw = Buffer.alloc(options.height * (1 + options.width * 3));
  let offset = 0;
  for (let y = 0; y < options.height; y += 1) {
    raw[offset] = 0; // filter type "none"
    offset += 1;
    for (let x = 0; x < options.width; x += 1) {
      const [r, g, b] = options.pixel(x, y);
      raw[offset] = clampByte(r);
      raw[offset + 1] = clampByte(g);
      raw[offset + 2] = clampByte(b);
      offset += 3;
    }
  }

  const chunks: Buffer[] = [pngChunk('IHDR', ihdr)];
  for (const [keyword, value] of Object.entries(options.text ?? {})) {
    chunks.push(
      pngChunk(
        'tEXt',
        Buffer.concat([
          Buffer.from(keyword, 'latin1'),
          Buffer.from([0]),
          Buffer.from(value, 'latin1'),
        ]),
      ),
    );
  }
  chunks.push(pngChunk('IDAT', deflateSync(raw)));
  chunks.push(pngChunk('IEND', Buffer.alloc(0)));

  return new Uint8Array(Buffer.concat([PNG_SIGNATURE, ...chunks]));
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) * 256 + (bytes[offset + 1] ?? 0);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) * 16_777_216 +
    (bytes[offset + 1] ?? 0) * 65_536 +
    (bytes[offset + 2] ?? 0) * 256 +
    (bytes[offset + 3] ?? 0)
  );
}

function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) return false;
  }
  return true;
}

/** Read the geometry of a PNG or JPEG, or throw rather than guess. */
export function readImageDimensions(bytes: Uint8Array): ImageDimensions {
  if (isPng(bytes)) {
    if (bytes.length < 33) {
      throw new UnsupportedImageFormatError('PNG is truncated before its IHDR');
    }
    const chunkType = Buffer.from(bytes.subarray(12, 16)).toString('ascii');
    if (chunkType !== 'IHDR') {
      throw new UnsupportedImageFormatError(`PNG does not start with IHDR (found "${chunkType}")`);
    }
    const width = readU32(bytes, 16);
    const height = readU32(bytes, 20);
    if (width === 0 || height === 0) {
      throw new UnsupportedImageFormatError('PNG IHDR carries a zero dimension');
    }
    return { format: 'png', width, height };
  }

  if (bytes.length >= 2) {
    const isJpegSoi = bytes[0] === 0xff;
    if (isJpegSoi) {
      const second = bytes[1];
      if (second === 0xd8) return readJpegDimensions(bytes);
    }
  }

  throw new UnsupportedImageFormatError(
    'unsupported image container: expected a PNG or JPEG (the only formats the image provider returns)',
  );
}

function readJpegDimensions(bytes: Uint8Array): ImageDimensions {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      throw new UnsupportedImageFormatError('JPEG marker stream is malformed: expected 0xFF');
    }
    let marker = bytes[offset + 1] ?? 0;
    while (marker === 0xff) {
      offset += 1;
      marker = bytes[offset + 1] ?? 0;
    }

    if (marker === 0xd9 || marker === 0xda) break;
    if (STANDALONE_MARKERS.includes(marker)) {
      offset += 2;
      continue;
    }

    const segmentLength = readU16(bytes, offset + 2);
    if (segmentLength < 2) {
      throw new UnsupportedImageFormatError('JPEG segment length is malformed');
    }

    if (SOF_MARKERS.includes(marker)) {
      if (offset + 9 > bytes.length) {
        throw new UnsupportedImageFormatError('JPEG is truncated inside its SOF segment');
      }
      const height = readU16(bytes, offset + 5);
      const width = readU16(bytes, offset + 7);
      if (width === 0 || height === 0) {
        throw new UnsupportedImageFormatError('JPEG SOF carries a zero dimension');
      }
      return { format: 'jpeg', width, height };
    }

    offset += 2 + segmentLength;
  }

  throw new UnsupportedImageFormatError('JPEG contains no SOF marker; geometry cannot be read');
}

/** Read a tEXt chunk by keyword (the fake's provenance marker), or null. */
export function readPngText(bytes: Uint8Array, keyword: string): string | null {
  if (!isPng(bytes)) return null;

  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = readU32(bytes, offset);
    const type = Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString('ascii');
    const dataStart = offset + 8;
    if (dataStart + length > bytes.length) return null;

    if (type === 'tEXt') {
      const data = Buffer.from(bytes.subarray(dataStart, dataStart + length));
      const separator = data.indexOf(0);
      if (separator > 0) {
        const foundKeyword = data.subarray(0, separator).toString('latin1');
        if (foundKeyword === keyword) return data.subarray(separator + 1).toString('latin1');
      }
    }

    if (type === 'IEND') return null;
    offset = dataStart + length + 4;
  }

  return null;
}
