import { describe, expect, it } from 'vitest';

import { formatBytes } from '../../src/web/format.js';

/** UI_SPEC §9.6: bytes are binary units with one decimal; counts never round. */
describe('formatBytes', () => {
  it('uses binary units with one decimal', () => {
    expect(formatBytes(48_250_128)).toBe('46.0 MB');
    expect(formatBytes(1_932_735_283)).toBe('1.8 GB');
    expect(formatBytes(6_320)).toBe('6.2 KB');
  });

  it('keeps whole bytes exact, without a decimal', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
  });

  it('never renders a negative or non-finite value as a size', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });
});
