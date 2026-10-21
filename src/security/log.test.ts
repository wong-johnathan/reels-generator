import { describe, expect, it } from 'vitest';

import { createLogger, type LogLine } from './log.js';
import { scanForSecrets } from './redact.js';

const F = (parts: readonly string[]): string => parts.join('');

const ENV: Record<string, string> = {
  POSTGRES_PASSWORD: F(['pg-', 'password-', '9f8e7d6c5b4a']),
  SESSION_SECRET: F(['session-', 'secret-', '0123456789abcdef0123456789abcdef']),
  DEEPSEEK_API_KEY: F(['sk-', 'synthetic', '0000000000000000000000000000']),
};

function capture() {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
}

/**
 * TECH_DESIGN §8.4(a): the redaction module runs in the structured-logging
 * serializer, so a secret cannot reach a log line even by accident. The
 * assertion is the release-gate one: scan the emitted lines, expect 0 matches.
 */
describe('redacting structured logger (R-015-5)', () => {
  it('writes one JSON object per line with ts/level/event/fields', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ sink, now: () => new Date('2026-10-21T01:02:03.000Z') });
    logger.info('job.claimed', { job_id: 'abc' });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as LogLine;
    expect(parsed.ts).toBe('2026-10-21T01:02:03.000Z');
    expect(parsed.level).toBe('info');
    expect(parsed.event).toBe('job.claimed');
    expect(parsed.job_id).toBe('abc');
  });

  it('emits 0 denylist matches when every secret shape is logged', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ sink, redact: { env: ENV } });
    logger.error('provider.failed', {
      message: `HTTP 401 with key ${F(['sk-', 'synthetic', '0000000000000000000000000000'])}`,
      authorization: 'Basic abc',
      database_url: F(['postgres://reels:', 'pg-password-9f8e7d6c5b4a', '@postgres:5432/reels']),
      password: 'operator-password-1234',
      nested: { apiKey: 'a-shape-that-matches-no-pattern' },
      count: 2,
    });
    const joined = lines.join('\n');
    expect(scanForSecrets(joined, { env: ENV })).toEqual([]);
    for (const secret of Object.values(ENV)) expect(joined).not.toContain(secret);
    expect(joined).not.toContain('operator-password-1234');
    const parsed = JSON.parse(lines[0]!) as LogLine;
    expect(parsed.count).toBe(2);
  });

  it('redacts an Error object without losing its class or message shape', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ sink, redact: { env: ENV } });
    const error = new Error(`upstream rejected key ${ENV.DEEPSEEK_API_KEY}`);
    error.name = 'ProviderAuthError';
    logger.error('provider.failed', { error });
    const line = lines[0]!;
    expect(line).not.toContain(ENV.DEEPSEEK_API_KEY!);
    const parsed = JSON.parse(line) as LogLine;
    const logged = parsed.error as { name: string; message: string };
    expect(logged.name).toBe('ProviderAuthError');
    expect(logged.message).toContain('[REDACTED:deepseek_api_key]');
    expect(scanForSecrets(line, { env: ENV })).toEqual([]);
  });

  it('redacts the event name and child fields too', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ sink, redact: { env: ENV } });
    logger.warn(`login ${ENV.DEEPSEEK_API_KEY}`, { operator: 'owner' });
    const child = logger.child({ request_id: 'r-1' });
    child.info('request.done', { status: 200 });
    expect(scanForSecrets(lines.join('\n'), { env: ENV })).toEqual([]);
    expect(JSON.parse(lines[1]!).request_id).toBe('r-1');
  });

  it('honours the level threshold and never throws on unserialisable fields', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ sink, level: 'warn' });
    logger.debug('dropped');
    logger.info('dropped');
    logger.warn('kept');
    const circular: Record<string, unknown> = { ok: true };
    circular.self = circular;
    expect(() => logger.error('circular', { circular })).not.toThrow();
    expect(lines.map((line) => JSON.parse(line).event)).toEqual(['kept', 'circular']);
  });
});
