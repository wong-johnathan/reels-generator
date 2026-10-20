import { describe, expect, it } from 'vitest';

import { ENV_KEYS, formatIssues, validateEnv, type Role } from './env.js';

const SECRET = 'x'.repeat(32);

/** A complete, valid environment for every role (values are fixtures, never real). */
function fullEnv(): Record<string, string> {
  return {
    APP_PORT: '8080',
    APP_BASE_URL: 'http://localhost:8080',
    SESSION_SECRET: SECRET,
    SESSION_TTL_HOURS: '720',
    OPERATOR_USERNAME: 'operator',
    OPERATOR_PASSWORD: 'fixture-password-hash',
    POSTGRES_HOST: 'postgres',
    POSTGRES_PORT: '5432',
    POSTGRES_DB: 'reels',
    POSTGRES_USER: 'reels',
    POSTGRES_PASSWORD: 'fixture-db-password',
    REDIS_URL: 'redis://redis:6379',
    MINIO_ENDPOINT: 'http://minio:9000',
    MINIO_ROOT_USER: 'fixture-minio-user',
    MINIO_ROOT_PASSWORD: 'fixture-minio-password',
    MINIO_BUCKET: 'reels',
    MINIO_PUBLIC_ENDPOINT: 'http://localhost:8080/asset',
    DEEPSEEK_API_KEY: 'fixture-deepseek-key',
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
    DEEPSEEK_MODEL: 'deepseek-chat',
    GEMINI_API_KEY: 'fixture-gemini-key',
    GEMINI_IMAGE_MODEL: 'gemini-nano-banana-2.1',
    GEMINI_IMAGE_SIZE: '1K',
    ELEVENLABS_API_KEY: 'fixture-elevenlabs-key',
    ELEVENLABS_VOICE_ID: 'fixture-voice',
    ELEVENLABS_MODEL_ID: 'eleven_multilingual_v2',
    PROVIDER_RATE_LIMIT_PER_MIN: '10',
    PROVIDER_TIMEOUT_IMAGE_S: '60',
    PROVIDER_TIMEOUT_TTS_S: '60',
    PROVIDER_TIMEOUT_SEARCH_S: '30',
    RETENTION_DAYS: '30',
    MAX_RENDER_CONCURRENCY: '1',
    RENDER_MEM_LIMIT_MB: '2048',
    RENDER_TIMEOUT_MIN: '30',
    LOG_LEVEL: 'info',
    TZ: 'UTC',
  };
}

function envWithout(...keys: string[]): Record<string, string> {
  const env = fullEnv();
  for (const key of keys) delete env[key];
  return env;
}

describe('env validator (R-016-5)', () => {
  it('accepts a complete environment for every role', () => {
    for (const role of ['web', 'worker', 'ops', 'migrate'] as Role[]) {
      const result = validateEnv(fullEnv(), role);
      expect(result.issues, `role ${role}`).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });

  it('names every missing required key, not just the first', () => {
    const result = validateEnv(envWithout('SESSION_SECRET', 'POSTGRES_PASSWORD'), 'web');
    expect(result.ok).toBe(false);
    const missing = result.issues.filter((i) => i.problem === 'missing').map((i) => i.key);
    expect(missing).toEqual(['SESSION_SECRET', 'POSTGRES_PASSWORD']);
  });

  it('prints an actionable message naming each missing key and the file to fix', () => {
    const env = envWithout('SESSION_SECRET', 'POSTGRES_PASSWORD');
    const message = formatIssues(validateEnv(env, 'web').issues, 'web');
    expect(message).toContain('SESSION_SECRET');
    expect(message).toContain('POSTGRES_PASSWORD');
    expect(message).toContain('.env.example');
    expect(message).toContain('role "web"');
    expect(message.split('\n').filter((line) => line.includes('MISSING'))).toHaveLength(2);
  });

  it('never echoes a secret value, even when the value itself is invalid', () => {
    const tooShort = 'hunter2-short';
    const result = validateEnv({ ...fullEnv(), SESSION_SECRET: tooShort }, 'web');
    const message = formatIssues(result.issues, 'web');
    expect(result.issues.map((i) => i.key)).toContain('SESSION_SECRET');
    expect(message).not.toContain(tooShort);
    expect(message).not.toContain(fullEnv().POSTGRES_PASSWORD);
  });

  it('rejects a malformed integer and names the key and the expected shape', () => {
    const result = validateEnv({ ...fullEnv(), POSTGRES_PORT: 'not-a-port' }, 'web');
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.key === 'POSTGRES_PORT');
    expect(issue?.problem).toBe('invalid');
    expect(issue?.expected).toContain('integer');
    expect(formatIssues(result.issues, 'web')).toContain('POSTGRES_PORT');
  });

  it('applies documented defaults for absent optional keys', () => {
    const env = envWithout(
      'LOG_LEVEL',
      'TZ',
      'PROVIDER_RATE_LIMIT_PER_MIN',
      'RENDER_TIMEOUT_MIN',
      'RETENTION_DAYS',
    );
    const result = validateEnv(env, 'worker');
    expect(result.ok).toBe(true);
    expect(result.values.LOG_LEVEL).toBe('info');
    expect(result.values.TZ).toBe('UTC');
    expect(result.values.PROVIDER_RATE_LIMIT_PER_MIN).toBe('10');
    expect(result.values.RENDER_TIMEOUT_MIN).toBe('30');
    // R-025-1: the retention default is 365 days, not the accepted minimum.
    expect(result.values.RETENTION_DAYS).toBe('365');
  });

  it('requires the provider keys for the worker and not for the web process', () => {
    const env = envWithout('DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'ELEVENLABS_API_KEY');
    expect(validateEnv(env, 'web').ok).toBe(true);
    const worker = validateEnv(env, 'worker');
    expect(worker.ok).toBe(false);
    expect(worker.issues.map((i) => i.key)).toEqual([
      'DEEPSEEK_API_KEY',
      'GEMINI_API_KEY',
      'ELEVENLABS_API_KEY',
    ]);
  });

  it('requires only the stores for the migrate/ops one-shots', () => {
    const env = envWithout(
      'APP_BASE_URL',
      'SESSION_SECRET',
      'OPERATOR_USERNAME',
      'OPERATOR_PASSWORD',
      'DEEPSEEK_API_KEY',
      'GEMINI_API_KEY',
      'ELEVENLABS_API_KEY',
    );
    expect(validateEnv(env, 'migrate').ok).toBe(true);
    expect(validateEnv(env, 'ops').ok).toBe(true);
    expect(validateEnv(env, 'web').ok).toBe(false);
    expect(validateEnv(env, 'worker').ok).toBe(false);
  });

  it('treats an empty string as missing (compose passes through unset vars as empty)', () => {
    const result = validateEnv({ ...fullEnv(), SESSION_SECRET: '   ' }, 'web');
    expect(result.issues.map((i) => i.key)).toContain('SESSION_SECRET');
  });

  it('exposes every key it knows about, unique and upper-case', () => {
    expect(new Set(ENV_KEYS).size).toBe(ENV_KEYS.length);
    for (const key of ENV_KEYS) expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
    expect(ENV_KEYS).toContain('MINIO_PUBLIC_ENDPOINT');
    expect(ENV_KEYS).toContain('RENDER_MEM_LIMIT_MB');
  });
});
