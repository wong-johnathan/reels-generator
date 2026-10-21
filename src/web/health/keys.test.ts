import { describe, expect, it } from 'vitest';

import { providerKeyConfigured } from './postgres.js';

describe('providerKeyConfigured', () => {
  it('maps each provider to its environment key', () => {
    const seen: string[] = [];
    const present = (envKey: string): boolean => {
      seen.push(envKey);
      return true;
    };

    expect(providerKeyConfigured('deepseek', present)).toBe(true);
    expect(providerKeyConfigured('gemini', present)).toBe(true);
    expect(providerKeyConfigured('elevenlabs', present)).toBe(true);
    expect(seen).toEqual(['DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'ELEVENLABS_API_KEY']);
  });

  it('reports absence when the key is missing', () => {
    expect(providerKeyConfigured('deepseek', () => false)).toBe(false);
  });

  it('does not claim a key for an unknown provider', () => {
    expect(providerKeyConfigured('nope', () => true)).toBe(false);
  });

  it('reads a real configured key from the environment', () => {
    // The settings page is the only surface that reports this, and it used to
    // hardcode false — so a fully configured stack announced 0 of 3 keys.
    const previous = process.env['DEEPSEEK_API_KEY'];
    process.env['DEEPSEEK_API_KEY'] = 'sk-test';
    try {
      expect(providerKeyConfigured('deepseek', (key) => Boolean(process.env[key]?.trim()))).toBe(
        true,
      );
    } finally {
      if (previous === undefined) delete process.env['DEEPSEEK_API_KEY'];
      else process.env['DEEPSEEK_API_KEY'] = previous;
    }
  });
});
