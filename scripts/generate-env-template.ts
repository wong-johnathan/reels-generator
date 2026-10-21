/**
 * Generates `.env.template` from the startup validator, so the template cannot
 * drift from the code that actually enforces it.
 *
 * The validator is the single source of truth: run it with an empty environment
 * for every role and it reports exactly which keys are required (and why) and
 * which resolve to a documented default.
 *
 *   npx tsx scripts/generate-env-template.ts
 *
 * `npm run verify` runs this and fails if the checked-in file is stale.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENV_KEYS, ROLES, validateEnv } from '../src/config/env.js';
import type { Role } from '../src/config/env.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.env.template');

/** Groups are editorial; anything not listed lands in "other" rather than vanishing. */
const GROUPS: readonly { readonly title: string; readonly keys: readonly string[] }[] = [
  {
    title: 'app / session (web)',
    keys: [
      'APP_PORT',
      'APP_BASE_URL',
      'SESSION_SECRET',
      'SESSION_TTL_HOURS',
      'OPERATOR_USERNAME',
      'OPERATOR_PASSWORD',
    ],
  },
  {
    title: 'stores',
    keys: [
      'POSTGRES_HOST',
      'POSTGRES_PORT',
      'POSTGRES_DB',
      'POSTGRES_USER',
      'POSTGRES_PASSWORD',
      'REDIS_URL',
      'MINIO_ENDPOINT',
      'MINIO_ROOT_USER',
      'MINIO_ROOT_PASSWORD',
      'MINIO_BUCKET',
      'MINIO_PUBLIC_ENDPOINT',
    ],
  },
  {
    title: 'providers (worker)',
    keys: [
      'DEEPSEEK_API_KEY',
      'DEEPSEEK_BASE_URL',
      'DEEPSEEK_MODEL',
      'RESEARCH_PROVIDER',
      'GEMINI_GROUNDING_MODEL',
      'GEMINI_API_KEY',
      'GEMINI_IMAGE_MODEL',
      'GEMINI_IMAGE_SIZE',
      'ELEVENLABS_API_KEY',
      'ELEVENLABS_VOICE_ID',
      'ELEVENLABS_MODEL_ID',
      'PROVIDER_RATE_LIMIT_PER_MIN',
      'PROVIDER_TIMEOUT_IMAGE_S',
      'PROVIDER_TIMEOUT_TTS_S',
      'PROVIDER_TIMEOUT_SEARCH_S',
    ],
  },
  {
    title: 'retention / render limits',
    keys: ['RETENTION_DAYS', 'MAX_RENDER_CONCURRENCY', 'RENDER_MEM_LIMIT_MB', 'RENDER_TIMEOUT_MIN'],
  },
  { title: 'logging', keys: ['LOG_LEVEL', 'TZ'] },
  { title: 'image source', keys: ['DOCKERHUB_USER'] },
];

interface Requirement {
  readonly roles: Role[];
  readonly expected: string;
  readonly secret: boolean;
  readonly hint?: string;
}

const required = new Map<string, Requirement>();
const defaults = new Map<string, string>();

/**
 * Compose-level variables that the startup validator never sees: they are read
 * by compose.yaml / compose.dockerhub.yaml during interpolation, not by a
 * running process. Documented here so the template is complete in one place.
 */
const COMPOSE_ONLY: Readonly<Record<string, { readonly comment: string; readonly value: string }>> =
  {
    DOCKERHUB_USER: {
      comment: 'Docker Hub organisation for the application images · default wongjohnathanwh741',
      value: 'wongjohnathanwh741',
    },
  };

for (const role of ROLES) {
  const result = validateEnv({}, role);
  for (const issue of result.issues) {
    if (issue.problem !== 'missing') continue;
    const existing = required.get(issue.key);
    if (existing) {
      if (!existing.roles.includes(role)) existing.roles.push(role);
      continue;
    }
    required.set(issue.key, {
      roles: [role],
      expected: issue.expected,
      secret: issue.secret,
      hint: issue.hint,
    });
  }
  for (const [key, value] of Object.entries(result.values)) {
    if (!defaults.has(key)) defaults.set(key, value);
  }
}

const grouped = new Set(GROUPS.flatMap((group) => group.keys));
const strays = ENV_KEYS.filter((key) => !grouped.has(key));
if (strays.length > 0) {
  (GROUPS as { title: string; keys: readonly string[] }[]).push({
    title: 'ungrouped — add these to a group in scripts/generate-env-template.ts',
    keys: strays,
  });
}

const lines: string[] = [
  '# reels-generator — environment template.',
  '#',
  '# Generated from src/config/env.ts by scripts/generate-env-template.ts.',
  '# Do not hand-edit: `npm run verify` fails if this file is stale.',
  '#',
  '#   cp .env.template .env        then fill every REQUIRED line',
  '#',
  '# Lines marked `optional` already carry their working default, so a copied',
  '# template boots with the defaults in place. Lines marked REQUIRED are blank',
  '# on purpose — the startup validator names each one that is still empty when',
  '# a container starts, and refuses to start it.',
  '',
];

for (const group of GROUPS) {
  lines.push(`# ── ${group.title} ${'─'.repeat(Math.max(4, 74 - group.title.length))}`);
  for (const key of group.keys) {
    const requirement = required.get(key);
    const fallback = defaults.get(key);
    if (requirement) {
      const roles = requirement.roles.join(', ');
      const parts = [`REQUIRED for ${roles}`, requirement.expected];
      if (requirement.secret && !/secret/i.test(requirement.expected)) parts.push('secret');
      if (requirement.hint) parts.push(requirement.hint);
      lines.push(`# ${parts.join(' · ')}`);
      lines.push(`${key}=`);
    } else if (COMPOSE_ONLY[key]) {
      lines.push(`# ${COMPOSE_ONLY[key].comment}`);
      lines.push(`${key}=${COMPOSE_ONLY[key].value}`);
    } else {
      lines.push(
        `# optional · ${fallback === undefined ? 'no default, only needed for the documented fallback' : `default ${fallback}`}`,
      );
      lines.push(`${key}=${fallback ?? ''}`);
    }
  }
  lines.push('');
}

lines.push(
  '# ── notes ───────────────────────────────────────────────────────────────────',
  '# Application images are pulled as :latest on every deploy, so there are no',
  '# release tags or digests to paste here. Store credentials are all above.',
  '#',
  '#   docker compose pull     # fetch the newest builds',
  '#   ./deploy/up.sh          # migrate, then start',
  '',
);

const rendered = lines.join('\n');
writeFileSync(OUT, rendered, 'utf8');
process.stdout.write(
  `.env.template written: ${ENV_KEYS.length} keys, ${required.size} required, ${defaults.size} defaulted\n`,
);
