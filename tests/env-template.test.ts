import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ENV_KEYS, ROLES, validateEnv } from '../src/config/env.js';

/**
 * `.env.template` is generated from the validator (scripts/generate-env-template.ts)
 * and CI fails if it is stale. These assertions cover the properties a human
 * relies on when they copy it: every key in the code is present, required keys
 * are blank, and no credential is pre-filled.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const template = readFileSync(join(ROOT, '.env.template'), 'utf8');

const assignments = template
  .split('\n')
  .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
  .map((line) => {
    const index = line.indexOf('=');
    return { key: line.slice(0, index), value: line.slice(index + 1) };
  });

/** Compose-level names that the validator never sees: read by compose.yaml during
 * interpolation (release pins, object-store image) or by the Docker Hub override. */
const COMPOSE_ONLY = [
  'RELEASE_TAG',
  'WEB_DIGEST',
  'WORKER_DIGEST',
  'OPS_DIGEST',
  'MINIO_IMAGE',
  'DOCKERHUB_USER',
];

describe('.env.template', () => {
  it('lists every key the validator knows, exactly once', () => {
    const keys = assignments.map((entry) => entry.key);
    expect(new Set(keys).size, 'duplicate keys').toBe(keys.length);
    expect([...keys].sort()).toEqual([...ENV_KEYS, ...COMPOSE_ONLY].sort());
  });

  it('leaves every required key blank so a copy cannot look complete', () => {
    const required = new Set<string>();
    for (const role of ROLES) {
      for (const issue of validateEnv({}, role).issues) {
        if (issue.problem === 'missing') required.add(issue.key);
      }
    }
    expect(required.size).toBeGreaterThan(0);

    const blank = new Set(
      assignments.filter((entry) => entry.value === '').map((entry) => entry.key),
    );
    // Every required key must be blank; anything pre-filled would be a value the
    // operator did not choose and the validator would accept as configured.
    expect([...required].filter((key) => !blank.has(key))).toEqual([]);
  });

  it('never pre-fills a credential', () => {
    for (const key of [
      'SESSION_SECRET',
      'OPERATOR_PASSWORD',
      'POSTGRES_PASSWORD',
      'MINIO_ROOT_PASSWORD',
      'DEEPSEEK_API_KEY',
      'GEMINI_API_KEY',
      'ELEVENLABS_API_KEY',
    ]) {
      const entry = assignments.find((candidate) => candidate.key === key);
      expect(entry, key).toBeDefined();
      expect(entry?.value, `${key} must be blank`).toBe('');
    }
  });

  it('states whether each key is required or defaulted', () => {
    const documented = template
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('# REQUIRED') ||
          line.startsWith('# optional') ||
          line.startsWith('# docker compose only'),
      ).length;
    expect(documented).toBe(assignments.length);
  });

  it('carries the Docker Hub organisation the compose variant expects', () => {
    const entry = assignments.find((candidate) => candidate.key === 'DOCKERHUB_USER');
    expect(entry?.value).toBe('wongjohnathanwh741');
  });
});
