import { describe, expect, it } from 'vitest';

import { formatIssues, validateEnv } from '../config/env.js';
import { parseArgs, run, type SpawnLike } from './validate-env.js';

function validEnv(): Record<string, string> {
  return {
    APP_PORT: '8080',
    APP_BASE_URL: 'http://localhost:8080',
    SESSION_SECRET: 'y'.repeat(40),
    OPERATOR_USERNAME: 'operator',
    OPERATOR_PASSWORD: 'fixture-password',
    POSTGRES_HOST: 'postgres',
    POSTGRES_DB: 'reels',
    POSTGRES_USER: 'reels',
    POSTGRES_PASSWORD: 'fixture-db-password',
    REDIS_URL: 'redis://redis:6379',
    MINIO_ENDPOINT: 'http://minio:9000',
    MINIO_ROOT_USER: 'minio',
    MINIO_ROOT_PASSWORD: 'fixture-minio-password',
    MINIO_BUCKET: 'reels',
  };
}

function fakeSpawn(exitCode = 0) {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const spawn: SpawnLike = (command, args) => {
    calls.push({ command, args });
    return {
      once: (_event, listener) => {
        queueMicrotask(() => listener(exitCode, null));
      },
      kill: () => true,
    };
  };
  return { calls, spawn };
}

describe('validate-env entrypoint (R-016-5)', () => {
  it('parses the role and the command tail', () => {
    expect(parseArgs(['--role', 'worker', '--exec', 'node', 'server.js'])).toEqual({
      role: 'worker',
      command: ['node', 'server.js'],
    });
    expect(parseArgs(['--role=ops', '--', 'sh', '-c', 'backup']).command).toEqual([
      'sh',
      '-c',
      'backup',
    ]);
    expect(parseArgs([], 'migrate').role).toBe('migrate');
    expect(parseArgs(['--bogus']).error).toContain('unexpected argument');
  });

  it('refuses to start a command when a required key is missing', async () => {
    const env = validEnv();
    delete env.POSTGRES_PASSWORD;
    delete env.SESSION_SECRET;
    const { calls, spawn } = fakeSpawn();
    const errors: string[] = [];

    const code = await run(['--role', 'web', '--exec', 'node', 'server.js'], {
      env,
      out: () => {},
      err: (line) => errors.push(line),
      spawn,
    });

    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    const message = errors.join('\n');
    expect(message).toContain('POSTGRES_PASSWORD');
    expect(message).toContain('SESSION_SECRET');
    expect(message).toContain('.env.example');
    expect(message).not.toContain('fixture-db-password');
  });

  it('execs the command only after a clean validation and returns its exit code', async () => {
    const { calls, spawn } = fakeSpawn(7);
    const code = await run(['--role', 'web', '--exec', 'node', 'dist/src/api/server.js'], {
      env: validEnv(),
      out: () => {},
      err: () => {},
      spawn,
    });

    expect(code).toBe(7);
    expect(calls).toEqual([{ command: 'node', args: ['dist/src/api/server.js'] }]);
  });

  it('validates only and exits 0 when no command follows', async () => {
    const { calls, spawn } = fakeSpawn();
    const out: string[] = [];
    const code = await run(['--role=web'], {
      env: validEnv(),
      out: (line) => out.push(line),
      err: () => {},
      spawn,
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(out.join('\n')).toContain('Configuration valid for role "web"');
  });

  it('rejects an unknown role with a usage error before validating', async () => {
    const errors: string[] = [];
    const code = await run(['--role', 'nobody'], {
      env: {},
      out: () => {},
      err: (line) => errors.push(line),
      spawn: fakeSpawn().spawn,
    });
    expect(code).toBe(2);
    expect(errors.join('\n')).toContain('unknown role "nobody"');
  });

  it('keeps the formatted message free of values when an int is malformed', () => {
    const result = validateEnv({ ...validEnv(), APP_PORT: 'eighty' }, 'web');
    const message = formatIssues(result.issues, 'web');
    expect(message).toContain('INVALID');
    expect(message).toContain('APP_PORT');
    expect(message).not.toContain('eighty');
  });
});
