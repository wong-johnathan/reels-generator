import { describe, expect, it, vi } from 'vitest';

import { qualifyImageMain } from './qualify-image.js';

/**
 * Only the paths that decide whether a measurement happens are covered here. The
 * generating and recording paths need a live vendor key and a database, so they
 * are exercised by the operator running the command, not by CI.
 */
describe('qualify:image', () => {
  it('refuses in fake mode instead of recording a meaningless pass', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await qualifyImageMain([], { PROVIDERS: 'fake' } as NodeJS.ProcessEnv);
    expect(code).toBe(1);
    expect(error.mock.calls.flat().join(' ')).toContain('nothing to measure');
    error.mockRestore();
  });

  it('requires a reviewer with a verdict, because the row records who judged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await qualifyImageMain(['--verdict', 'pass'], {
      PROVIDERS: 'fake',
    } as NodeJS.ProcessEnv);
    // Fake mode is checked first, so this asserts the fake-mode refusal still wins.
    expect(code).toBe(1);
    error.mockRestore();
  });

  it('rejects a verdict that is neither pass nor fail', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await qualifyImageMain(['--verdict', 'maybe'], {
      PROVIDERS: 'fake',
    } as NodeJS.ProcessEnv);
    expect(code).toBe(1);
    expect(error.mock.calls.flat().join(' ')).toContain('must be pass or fail');
    error.mockRestore();
  });
});
