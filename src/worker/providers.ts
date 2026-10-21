/**
 * Provider selection for the worker (B-06/B-08 wiring).
 *
 * The dependency graph is built from configuration, never from hardcoded fakes.
 * `PROVIDERS=fake` is an explicit opt-in that selects the deterministic fixtures
 * and logs a loud warning that no real content will be produced. Any other (or
 * unset) value selects the real vendors and requires all three credentials; a
 * missing or blank one throws `ProviderConfigError` naming every missing key at
 * once — the same fail-closed contract as the MinIO binding — so a half-
 * configured stack refuses to start rather than silently rendering fixtures.
 */
import { DeepSeekTextAdapter, type TextAdapter } from '../adapters/text.js';
import { GeminiImageAdapter, type ImageAdapter, type ImageSize } from '../adapters/image.js';
import { ElevenLabsTtsAdapter, FakeTtsAdapter, type TtsAdapter } from '../adapters/tts.js';
import { FakeTextAdapter } from '../adapters/fake-text.js';
import { FakeImageAdapter } from '../adapters/fake-image.js';

/** The explicit opt-in value that selects the fake providers. */
export const FAKE_PROVIDERS = 'fake';

/** The credentials the real vendors require; named together when missing. */
const REQUIRED_KEYS = ['DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'ELEVENLABS_API_KEY'] as const;

/** Raised when the real vendors are selected but a credential is missing or blank. */
export class ProviderConfigError extends Error {
  readonly missingKeys: readonly string[];

  constructor(missingKeys: readonly string[]) {
    super(
      'provider configuration is incomplete: ' +
        missingKeys.join(', ') +
        ' — set every key, or set PROVIDERS=' +
        FAKE_PROVIDERS +
        ' to opt into the fake providers (which produce no real content)',
    );
    this.name = 'ProviderConfigError';
    this.missingKeys = missingKeys;
  }
}

/** An environment source, read-only and index-safe (matches `s3ConfigFromEnv`). */
type Env = Readonly<Record<string, string | undefined>>;

function blank(value: string | undefined): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

/** Blank → undefined, so an unset optional key takes the adapter's own default. */
function nonBlank(value: string | undefined): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? undefined : trimmed;
}

export function isFakeProviderMode(env: Env): boolean {
  return env.PROVIDERS === FAKE_PROVIDERS;
}

function missingCredentials(env: Env): readonly string[] {
  return REQUIRED_KEYS.filter((key) => blank(env[key]));
}

function assertCredentials(env: Env): void {
  const missing = missingCredentials(env);
  if (missing.length > 0) throw new ProviderConfigError(missing);
}

/** Loud and unconditional: the fakes must never reach production silently. */
function warnFakeProviders(): void {
  console.warn(
    `PROVIDERS=${FAKE_PROVIDERS}: the worker will produce no real content — a canned script, ` +
      'gradient placeholder images and a silent WAV. Never run this in production.',
  );
}

export function selectTextAdapter(env: Env): TextAdapter {
  if (isFakeProviderMode(env)) {
    warnFakeProviders();
    return new FakeTextAdapter();
  }
  assertCredentials(env);
  return new DeepSeekTextAdapter({
    apiKey: env.DEEPSEEK_API_KEY!,
    baseUrl: nonBlank(env.DEEPSEEK_BASE_URL),
    model: nonBlank(env.DEEPSEEK_MODEL),
  });
}

export function selectImageAdapter(env: Env): ImageAdapter {
  if (isFakeProviderMode(env)) {
    warnFakeProviders();
    return new FakeImageAdapter();
  }
  assertCredentials(env);
  return new GeminiImageAdapter({
    apiKey: env.GEMINI_API_KEY!,
    model: nonBlank(env.GEMINI_IMAGE_MODEL),
    imageSize: nonBlank(env.GEMINI_IMAGE_SIZE) as ImageSize | undefined,
  });
}

export function selectTtsAdapter(env: Env): TtsAdapter {
  if (isFakeProviderMode(env)) {
    warnFakeProviders();
    return new FakeTtsAdapter();
  }
  assertCredentials(env);
  return new ElevenLabsTtsAdapter({
    apiKey: env.ELEVENLABS_API_KEY!,
    // The voice id is enforced at the env layer for the worker role; the value
    // carried here is only the `qualify()` default, so a blank one passes through.
    voiceId: nonBlank(env.ELEVENLABS_VOICE_ID) ?? '',
    modelId: nonBlank(env.ELEVENLABS_MODEL_ID),
  });
}

/**
 * Resolve the voice id a narration uses: the series snapshot's non-empty
 * `voice_config.voice_id` wins; otherwise `ELEVENLABS_VOICE_ID`. Blank and
 * whitespace-only values are treated as absent (a non-empty check, not `??`).
 */
export function resolveVoiceId(
  seriesVoiceId: string | undefined,
  envVoiceId: string | undefined,
): string | undefined {
  const fromSeries = nonBlank(seriesVoiceId);
  if (fromSeries !== undefined) return fromSeries;
  return nonBlank(envVoiceId);
}
