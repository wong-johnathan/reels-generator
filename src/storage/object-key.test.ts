/**
 * The readable object key builder (deviation D-F). Slug edge cases and the
 * zero-padded batch folder are the contract every asset writer leans on.
 */
import { describe, expect, it } from 'vitest';

import { assetObjectKey, batchFolder, sceneImageName, slugifySeries } from './object-key.js';

describe('slugifySeries', () => {
  it('lower-cases and collapses non-alphanumerics to a single dash', () => {
    expect(slugifySeries('Quiet Machines & Neuro!')).toBe('quiet-machines-neuro');
  });

  it('strips leading and trailing dashes', () => {
    expect(slugifySeries('---quiet---')).toBe('quiet');
  });

  it('falls back to `series` when nothing readable remains', () => {
    expect(slugifySeries('   ---  ')).toBe('series');
    expect(slugifySeries('')).toBe('series');
  });
});

describe('batchFolder', () => {
  it('zero-pads the ordinal to four digits', () => {
    expect(batchFolder(1)).toBe('batch-0001');
    expect(batchFolder(12)).toBe('batch-0012');
    expect(batchFolder(9999)).toBe('batch-9999');
  });
});

describe('assetObjectKey', () => {
  it('builds `<slug>/batch-NNNN/<name>`', () => {
    expect(
      assetObjectKey({ seriesSlug: 'Quiet Machines', batchOrdinal: 1, name: 'video.mp4' }),
    ).toBe('quiet-machines/batch-0001/video.mp4');
  });
});

describe('sceneImageName', () => {
  it('uses the scene number, not an index', () => {
    expect(sceneImageName('S07')).toBe('scenes/S07.png');
  });
});
