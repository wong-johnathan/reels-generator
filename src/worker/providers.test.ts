import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeImageAdapter } from '../adapters/fake-image.js';
import { FakeTextAdapter } from '../adapters/fake-text.js';
import { ElevenLabsTtsAdapter, FakeTtsAdapter } from '../adapters/tts.js';
import { GeminiImageAdapter } from '../adapters/image.js';
import { DeepSeekTextAdapter } from '../adapters/text.js';
import {
  ProviderConfigError,
  resolveVoiceId,
  selectImageAdapter,
  selectTextAdapter,
  selectTtsAdapter,
} from './providers.js';

const REAL_KEYS: Readonly<Record<string, string>> = {
  DEEPSEEK_API_KEY: 'fixture-deepseek-key',
  GEMINI_API_KEY: 'fixture-gemini-key',
  ELEVENLABS_API_KEY: 'fixture-elevenlabs-key',
};

function env(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return { ...REAL_KEYS, ...overrides };
}

describe('provider selection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('PROVIDERS=fake selects the fakes and logs a loud warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fakeEnv = env({ PROVIDERS: 'fake' });

    expect(selectTextAdapter(fakeEnv)).toBeInstanceOf(FakeTextAdapter);
    expect(selectImageAdapter(fakeEnv)).toBeInstanceOf(FakeImageAdapter);
    expect(selectTtsAdapter(fakeEnv)).toBeInstanceOf(FakeTtsAdapter);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('no real content'))).toBe(true);
  });

  it('throws naming the single missing key', () => {
    expect(() => selectTextAdapter(env({ DEEPSEEK_API_KEY: undefined }))).toThrow(
      ProviderConfigError,
    );
    try {
      selectTextAdapter(env({ DEEPSEEK_API_KEY: undefined }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderConfigError);
      expect((error as ProviderConfigError).missingKeys).toEqual(['DEEPSEEK_API_KEY']);
      expect((error as ProviderConfigError).message).toContain('DEEPSEEK_API_KEY');
    }
  });

  it('throws naming every missing key when all three are absent', () => {
    const none = env({
      DEEPSEEK_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      ELEVENLABS_API_KEY: undefined,
    });
    for (const select of [selectTextAdapter, selectImageAdapter, selectTtsAdapter]) {
      expect(() => select(none)).toThrow(ProviderConfigError);
    }
    try {
      selectTextAdapter(none);
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as ProviderConfigError;
      expect(err.missingKeys).toEqual(['DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'ELEVENLABS_API_KEY']);
      for (const key of ['DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'ELEVENLABS_API_KEY']) {
        expect(err.message).toContain(key);
      }
    }
  });

  it('treats a blank-string key as missing', () => {
    expect(() => selectTextAdapter(env({ DEEPSEEK_API_KEY: '' }))).toThrow(ProviderConfigError);
    try {
      selectTextAdapter(env({ DEEPSEEK_API_KEY: '' }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ProviderConfigError).missingKeys).toEqual(['DEEPSEEK_API_KEY']);
    }
  });

  it('selects the real adapters when PROVIDERS is unset and all three keys are present', () => {
    const real = env();
    expect(selectTextAdapter(real)).toBeInstanceOf(DeepSeekTextAdapter);
    expect(selectImageAdapter(real)).toBeInstanceOf(GeminiImageAdapter);
    expect(selectTtsAdapter(real)).toBeInstanceOf(ElevenLabsTtsAdapter);
  });

  it('reads model names from env', () => {
    const real = env({
      DEEPSEEK_MODEL: 'deepseek-reasoner',
      GEMINI_IMAGE_MODEL: 'gemini-2.0-flash',
      ELEVENLABS_MODEL_ID: 'eleven_turbo_v2_5',
    });
    expect(selectTextAdapter(real).model).toBe('deepseek-reasoner');
    expect(selectImageAdapter(real).model).toBe('gemini-2.0-flash');
    expect(selectTtsAdapter(real).modelId).toBe('eleven_turbo_v2_5');
  });

  it("falls back to the adapters' own defaults when model names are unset", () => {
    const real = env();
    expect(selectTextAdapter(real).model).toBe('deepseek-chat');
    expect(selectImageAdapter(real).model).toBe('gemini-nano-banana-2.1');
    expect(selectTtsAdapter(real).modelId).toBe('eleven_multilingual_v2');
  });
});

describe('resolveVoiceId', () => {
  it('falls back to ELEVENLABS_VOICE_ID when the series voice id is empty', () => {
    expect(resolveVoiceId('', 'fixture-voice')).toBe('fixture-voice');
  });

  it('treats whitespace-only as absent', () => {
    expect(resolveVoiceId('   ', 'fixture-voice')).toBe('fixture-voice');
  });

  it('lets a real series voice id win over the environment fallback', () => {
    expect(resolveVoiceId('series-voice', 'fixture-voice')).toBe('series-voice');
  });

  it('returns undefined when both are absent', () => {
    expect(resolveVoiceId(undefined, undefined)).toBeUndefined();
  });
});
