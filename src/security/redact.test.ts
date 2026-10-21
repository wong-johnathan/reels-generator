import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertNoSecrets,
  redactJson,
  redactText,
  redactValue,
  scanDirectory,
  scanForSecrets,
  SecretLeakError,
} from './redact.js';

/**
 * TECH_DESIGN §8.4: the denylist holds the secret shapes (DeepSeek `sk-…`,
 * Google `AIza…`, the ElevenLabs 32-hex key, DB passwords) plus the actual
 * values of the secret environment keys, so a key that appears verbatim in a
 * log is caught even if its shape drifts.
 *
 * Every value below is synthetic and assembled at runtime, so this file never
 * contains a credential-shaped literal (R-015-5 applies to the repo too).
 */
const F = (parts: readonly string[]): string => parts.join('');

const FAKE = {
  deepseek: F(['sk-', 'synthetic', '0000000000000000000000000000']),
  google: F(['AI', 'za', 'SyNTHETIC', '0'.repeat(26)]),
  elevenlabs: '0123456789abcdef'.repeat(2),
  postgres: F(['pg-', 'password-', '9f8e7d6c5b4a']),
  session: F(['session-', 'secret-', '0123456789abcdef0123456789abcdef']),
  operator: F(['operator-', 'password-', '1234']),
  bearer: F(['Bearer ', 'synthetic-token-', '0123456789']),
  databaseUrl: F(['postgres://reels:', 'url-embedded-password-77', '@postgres:5432/reels']),
} as const;

const ENV: Record<string, string> = {
  POSTGRES_PASSWORD: FAKE.postgres,
  SESSION_SECRET: FAKE.session,
  OPERATOR_PASSWORD: FAKE.operator,
  DEEPSEEK_API_KEY: FAKE.deepseek,
  GEMINI_API_KEY: FAKE.google,
  ELEVENLABS_API_KEY: FAKE.elevenlabs,
  POSTGRES_HOST: 'postgres',
  LOG_LEVEL: 'info',
};

function harness(text: string) {
  return scanForSecrets(text, { env: ENV });
}

describe('denylist scan (R-015-5)', () => {
  it('detects every secret shape and every secret env value', () => {
    const kinds = harness(
      [
        `key=${FAKE.deepseek}`,
        `google=${FAKE.google}`,
        `eleven=${FAKE.elevenlabs}`,
        `db=${FAKE.postgres}`,
        `session=${FAKE.session}`,
        `operator=${FAKE.operator}`,
        `auth=${FAKE.bearer}`,
        `url=${FAKE.databaseUrl}`,
      ].join('\n'),
    ).map((finding) => finding.kind);

    expect(new Set(kinds)).toEqual(
      new Set([
        'deepseek_api_key',
        'google_api_key',
        'elevenlabs_api_key',
        'env_value',
        'bearer_token',
        'database_url_credentials',
      ]),
    );
  });

  it('finds 0 matches in realistic clean logs and export sidecars', () => {
    const clean = [
      '{"ts":"2026-10-21T00:00:00.000Z","level":"info","event":"job.claimed","job_id":"8f14e45f-ceea-467f-a1c0-1b2c3d4e5f60"}',
      '{"event":"asset.persisted","object_key":"sha256:3b1f2c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809"}',
      '{"event":"provider.call","provider":"gemini","model":"gemini-nano-banana-2.1","prompt_hash":"0f1e2d3c4b5a69788796a5b4c3d2e1f0"}',
      '{"manifest.csv":"posting_order,filename,title,srt,vtt,sidecar,duration_s,posted_flag"}',
      '{"metadata":{"title":"Why we remember faces","hashtags":["psychology","comics"],"duration_s":75}}',
      'PASSWORD policy: at least 12 characters. API key presence: present.',
    ].join('\n');
    expect(harness(clean)).toEqual([]);
  });

  it('does not flag a sha256 content hash or a bare 32-hex digest as an ElevenLabs key', () => {
    expect(harness(`object_key=sha256:${'a'.repeat(64)}`)).toEqual([]);
    expect(harness(`{"prompt_hash":"${'0f'.repeat(16)}"}`)).toEqual([]);
    expect(harness(`xi-api-key: ${FAKE.elevenlabs}`)).toHaveLength(1);
  });

  it('never returns the secret itself — only a fingerprint and a position', () => {
    const findings = harness(`token=${FAKE.deepseek}`);
    expect(findings).toHaveLength(1);
    const serialised = JSON.stringify(findings);
    expect(serialised).not.toContain(FAKE.deepseek);
    expect(serialised).not.toContain('synthetic00000000000000000000000000');
    expect(findings[0]?.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(findings[0]?.index).toBe(6);
  });

  it('reports each match once when patterns overlap', () => {
    const findings = harness(FAKE.databaseUrl);
    expect(findings.map((finding) => finding.kind)).toEqual(['database_url_credentials']);
  });

  it('redacts in place, keeping the surrounding log readable', () => {
    const line = `login failed for owner db=${FAKE.postgres} key=${FAKE.deepseek}`;
    const redacted = redactText(line, { env: ENV });
    expect(redacted).toBe(
      'login failed for owner db=[REDACTED:env_value] key=[REDACTED:deepseek_api_key]',
    );
    expect(harness(redacted)).toEqual([]);
  });

  it('redacts by field name as well as by value, at any depth', () => {
    const record = {
      event: 'settings.read',
      operator: 'owner',
      password: 'a-plaintext-that-matches-no-pattern',
      nested: {
        apiKey: 'another-shape',
        authorization: 'Basic abc',
        values: ['safe', F(['sk-', 'x'.repeat(24)])],
      },
      count: 3,
      present: true,
    };
    const redacted = redactValue(record, { env: ENV }) as Record<string, unknown>;
    expect(redacted.event).toBe('settings.read');
    expect(redacted.operator).toBe('owner');
    expect(redacted.count).toBe(3);
    expect(redacted.present).toBe(true);
    expect(redacted.password).toBe('[REDACTED]');
    const nested = redacted.nested as Record<string, unknown>;
    expect(nested.apiKey).toBe('[REDACTED]');
    expect(nested.authorization).toBe('[REDACTED]');
    expect((nested.values as unknown[])[0]).toBe('safe');
    expect((nested.values as unknown[])[1]).toBe('[REDACTED:deepseek_api_key]');
    expect(harness(JSON.stringify(redacted))).toEqual([]);
  });

  it('redactJson produces JSON that scans clean', () => {
    const json = redactJson(
      { event: 'provider.error', message: `bad key ${FAKE.google}` },
      { env: ENV },
    );
    expect(JSON.parse(json).message).toBe('bad key [REDACTED:google_api_key]');
    expect(harness(json)).toEqual([]);
  });

  it('assertNoSecrets throws a value-free SecretLeakError', () => {
    expect(() => assertNoSecrets('clean', { env: ENV }, 'log line')).not.toThrow();
    let caught: unknown;
    try {
      assertNoSecrets(`bad ${FAKE.postgres}`, { env: ENV }, 'export manifest.csv');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SecretLeakError);
    const error = caught as SecretLeakError;
    expect(error.message).toContain('export manifest.csv');
    expect(error.message).toContain('1');
    expect(error.message).not.toContain(FAKE.postgres);
    expect(error.kinds.length).toBeGreaterThan(0);
  });
});

describe('export/log tree scan (TECH_DESIGN §8.4)', () => {
  it('scans every file under a directory and reports the offending path', () => {
    const root = mkdtempSync(join(tmpdir(), 'reels-redact-'));
    mkdirSync(join(root, 'logs'), { recursive: true });
    mkdirSync(join(root, 'exports', 'batch'), { recursive: true });
    writeFileSync(join(root, 'logs', 'web.log'), '{"event":"ok"}\n');
    writeFileSync(
      join(root, 'exports', 'batch', 'metadata.json'),
      '{"title":"ok","duration_s":75}',
    );
    writeFileSync(
      join(root, 'exports', 'batch', 'video.srt'),
      '1\n00:00:00,000 --> 00:00:02,000\nok\n',
    );

    expect(scanDirectory(root, { env: ENV })).toEqual({ filesScanned: 3, findings: [] });

    writeFileSync(
      join(root, 'exports', 'batch', 'video.srt'),
      `1\n00:00:00,000 --> 00:00:02,000\nkey ${FAKE.deepseek}\n`,
    );
    const result = scanDirectory(root, { env: ENV });
    expect(result.filesScanned).toBe(3);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.file.endsWith(join('exports', 'batch', 'video.srt'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(FAKE.deepseek);
  });

  it('skips binary files rather than reporting mojibake', () => {
    const root = mkdtempSync(join(tmpdir(), 'reels-redact-bin-'));
    writeFileSync(join(root, 'video.mp4'), Buffer.from([0x00, 0xff, 0x1c, 0x80, 0x00]));
    expect(scanDirectory(root, { env: ENV }).filesScanned).toBe(0);
  });
});
