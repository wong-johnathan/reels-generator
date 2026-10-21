/**
 * Environment contract + validator — R-016-5.
 *
 * "Startup validates missing required config values and prints an actionable
 * error naming the missing key." TECH_DESIGN §9.2 sharpens it: the validator
 * lists *every* missing key before any work starts, in each service's
 * entrypoint. Values are never echoed — several of these keys are secrets and
 * the log is shipped to the operator (R-015-5).
 *
 * Required-ness is per role because the six containers do not need the same
 * keys: `web` never holds provider keys, `migrate` needs only the database.
 */

/** The process roles that validate their own environment. */
export const ROLES = ['web', 'worker', 'ops', 'migrate'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

type ValueKind = 'string' | 'url' | 'int' | 'secret' | 'enum';

interface EnvKeySpec {
  readonly key: string;
  readonly kind: ValueKind;
  /** Roles in which this key is required (no default available). */
  readonly roles: readonly Role[];
  readonly secret?: boolean;
  readonly default?: string;
  readonly min?: number;
  readonly max?: number;
  readonly choices?: readonly string[];
  readonly expected: string;
  readonly hint?: string;
}

const STORES: readonly Role[] = ['web', 'worker', 'ops', 'migrate'];

/**
 * The keys of TECH_DESIGN §9.6, in the same order as `.env.example`.
 * A key with a `default` is never reported missing: an absent optional key is
 * configured by its documented default, not by a silently invented value.
 */
const SPECS = [
  // ── app / session (web only) ──
  {
    key: 'APP_PORT',
    kind: 'int',
    roles: ['web'],
    default: '8080',
    min: 1,
    max: 65535,
    expected: 'integer 1-65535',
  },
  {
    key: 'APP_BASE_URL',
    kind: 'url',
    roles: ['web'],
    default: 'http://localhost:8080',
    expected: 'absolute http(s) URL',
  },
  {
    key: 'SESSION_SECRET',
    kind: 'secret',
    roles: ['web'],
    secret: true,
    min: 32,
    expected: 'at least 32 characters of random data',
    hint: 'openssl rand -hex 32',
  },
  {
    key: 'SESSION_TTL_HOURS',
    kind: 'int',
    roles: ['web'],
    default: '720',
    min: 1,
    max: 8760,
    expected: 'integer 1-8760',
  },
  {
    key: 'OPERATOR_USERNAME',
    kind: 'string',
    roles: ['web'],
    expected: 'non-empty string',
  },
  {
    key: 'OPERATOR_PASSWORD',
    kind: 'secret',
    roles: ['web'],
    secret: true,
    min: 12,
    expected: 'at least 12 characters (hashed to argon2id at seed)',
  },

  // ── stores (every role) ──
  { key: 'POSTGRES_HOST', kind: 'string', roles: STORES, expected: 'non-empty host name' },
  {
    key: 'POSTGRES_PORT',
    kind: 'int',
    roles: STORES,
    default: '5432',
    min: 1,
    max: 65535,
    expected: 'integer 1-65535',
  },
  { key: 'POSTGRES_DB', kind: 'string', roles: STORES, expected: 'non-empty database name' },
  { key: 'POSTGRES_USER', kind: 'string', roles: STORES, expected: 'non-empty user name' },
  {
    key: 'POSTGRES_PASSWORD',
    kind: 'secret',
    roles: STORES,
    secret: true,
    expected: 'non-empty secret',
  },
  {
    key: 'REDIS_URL',
    kind: 'url',
    roles: ['web', 'worker'],
    expected: 'redis:// or rediss:// URL',
  },
  {
    key: 'MINIO_ENDPOINT',
    kind: 'url',
    roles: STORES,
    expected: 'absolute http(s) URL',
  },
  {
    key: 'MINIO_ROOT_USER',
    kind: 'string',
    roles: STORES,
    expected: 'non-empty access key',
  },
  {
    key: 'MINIO_ROOT_PASSWORD',
    kind: 'secret',
    roles: STORES,
    secret: true,
    min: 8,
    expected: 'at least 8 characters',
  },
  { key: 'MINIO_BUCKET', kind: 'string', roles: STORES, expected: 'non-empty bucket name' },
  {
    key: 'MINIO_PUBLIC_ENDPOINT',
    kind: 'url',
    roles: [],
    default: 'http://localhost:8080/asset',
    expected: 'absolute http(s) URL served by the web process',
  },

  // ── provider credentials (worker only) ──
  {
    key: 'DEEPSEEK_API_KEY',
    kind: 'secret',
    roles: ['worker'],
    secret: true,
    expected: 'non-empty API key',
  },
  {
    key: 'DEEPSEEK_BASE_URL',
    kind: 'url',
    roles: [],
    default: 'https://api.deepseek.com/v1',
    expected: 'absolute http(s) URL',
  },
  {
    key: 'DEEPSEEK_MODEL',
    kind: 'string',
    roles: [],
    default: 'deepseek-chat',
    expected: 'non-empty model id',
  },
  {
    key: 'MIGRATE_ON_START',
    kind: 'enum',
    roles: [],
    default: 'true',
    choices: ['true', 'false'],
    expected:
      'true or false: apply pending migrations when web/worker boot. Default true — a pull-and-up must not leave the schema behind the code. Set false only when migrations are run deliberately as a separate step',
  },
  {
    key: 'RESEARCH_PROVIDER',
    kind: 'enum',
    roles: [],
    default: 'deepseek',
    choices: ['deepseek', 'gemini'],
    expected:
      'one of deepseek, gemini (TECH_DESIGN 5.2: deepseek is the default, gemini is the documented fallback)',
  },
  {
    key: 'GEMINI_GROUNDING_MODEL',
    kind: 'string',
    roles: [],
    expected: 'non-empty Gemini model id, required only when RESEARCH_PROVIDER=gemini',
  },
  {
    key: 'GEMINI_API_KEY',
    kind: 'secret',
    roles: ['worker'],
    secret: true,
    expected: 'non-empty API key',
  },
  {
    key: 'GEMINI_IMAGE_MODEL',
    kind: 'string',
    roles: [],
    default: 'gemini-nano-banana-2.1',
    expected: 'non-empty model id',
  },
  {
    key: 'GEMINI_IMAGE_SIZE',
    kind: 'enum',
    roles: [],
    default: '1K',
    choices: ['1K', '2K'],
    expected: 'one of 1K, 2K',
  },
  {
    key: 'ELEVENLABS_API_KEY',
    kind: 'secret',
    roles: ['worker'],
    secret: true,
    expected: 'non-empty API key',
  },
  {
    key: 'ELEVENLABS_VOICE_ID',
    kind: 'string',
    roles: ['worker'],
    expected: 'non-empty voice id',
  },
  {
    key: 'ELEVENLABS_MODEL_ID',
    kind: 'string',
    roles: [],
    default: 'eleven_multilingual_v2',
    expected: 'non-empty model id',
  },
  {
    key: 'PROVIDER_RATE_LIMIT_PER_MIN',
    kind: 'int',
    roles: [],
    default: '10',
    min: 1,
    max: 600,
    expected: 'integer 1-600',
  },
  {
    key: 'PROVIDER_TIMEOUT_IMAGE_S',
    kind: 'int',
    roles: [],
    default: '60',
    min: 1,
    max: 600,
    expected: 'integer 1-600',
  },
  {
    key: 'PROVIDER_TIMEOUT_TTS_S',
    kind: 'int',
    roles: [],
    default: '60',
    min: 1,
    max: 600,
    expected: 'integer 1-600',
  },
  {
    key: 'PROVIDER_TIMEOUT_SEARCH_S',
    kind: 'int',
    roles: [],
    default: '30',
    min: 1,
    max: 600,
    expected: 'integer 1-600',
  },

  // ── retention / render limits ──
  {
    key: 'RETENTION_DAYS',
    kind: 'int',
    roles: [],
    // R-025-1: originals and renders are kept at least 365 days by default.
    default: '365',
    min: 1,
    max: 3650,
    expected: 'integer 1-3650',
  },
  {
    key: 'MAX_RENDER_CONCURRENCY',
    kind: 'int',
    roles: [],
    default: '1',
    min: 1,
    max: 2,
    expected: 'integer 1-2 (the NAS renders one video at a time)',
  },
  {
    key: 'RENDER_MEM_LIMIT_MB',
    kind: 'int',
    roles: [],
    default: '2048',
    min: 512,
    max: 8192,
    expected: 'integer 512-8192',
  },
  {
    key: 'RENDER_TIMEOUT_MIN',
    kind: 'int',
    roles: ['worker'],
    default: '30',
    min: 1,
    max: 240,
    expected: 'integer 1-240',
  },
  {
    key: 'LOG_LEVEL',
    kind: 'enum',
    roles: [],
    default: 'info',
    choices: ['debug', 'info', 'warn', 'error'],
    expected: 'one of debug, info, warn, error',
  },
  { key: 'TZ', kind: 'string', roles: [], default: 'UTC', expected: 'IANA timezone name' },
] as const satisfies readonly EnvKeySpec[];

/** Every key the application reads, in `.env.example` order. */
/** Typed as the interface (not the literal union) so optional fields stay readable when iterating. */
const SPEC_LIST: readonly EnvKeySpec[] = SPECS;

export const ENV_KEYS: readonly string[] = SPEC_LIST.map((spec) => spec.key);
export type EnvKey = (typeof SPECS)[number]['key'];

export interface EnvIssue {
  readonly key: string;
  readonly problem: 'missing' | 'invalid';
  readonly expected: string;
  readonly secret: boolean;
  readonly hint?: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly role: Role;
  readonly issues: readonly EnvIssue[];
  /** Configured value for every key that resolved (explicit or defaulted). */
  readonly values: Readonly<Record<string, string>>;
}

type EnvSource = Readonly<Record<string, string | undefined>>;

function readValue(source: EnvSource, spec: EnvKeySpec): string | undefined {
  const raw = source[spec.key];
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed === '') return spec.default;
  return trimmed;
}

function checkValue(spec: EnvKeySpec, value: string): boolean {
  switch (spec.kind) {
    case 'int': {
      if (!/^-?\d+$/.test(value)) return false;
      const n = Number.parseInt(value, 10);
      if (spec.min !== undefined && n < spec.min) return false;
      if (spec.max !== undefined && n > spec.max) return false;
      return true;
    }
    case 'url': {
      try {
        const url = new URL(value);
        if (spec.key === 'REDIS_URL')
          return url.protocol === 'redis:' || url.protocol === 'rediss:';
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    }
    case 'enum':
      return (spec.choices ?? []).includes(value);
    case 'secret':
      return spec.min === undefined || value.length >= spec.min;
    case 'string':
      return value.length > 0;
  }
}

/**
 * Validate a process environment for one role.
 *
 * Reports *all* problems at once (R-016-5 + TECH_DESIGN §9.2) and never returns
 * a value for a key that failed validation, so a caller cannot start work on a
 * half-validated environment.
 */
export function validateEnv(source: EnvSource, role: Role): ValidationResult {
  const issues: EnvIssue[] = [];
  const values: Record<string, string> = {};

  for (const spec of SPEC_LIST) {
    const value = readValue(source, spec);
    const requiredHere = (spec.roles as readonly Role[]).includes(role);
    const base = {
      key: spec.key,
      expected: spec.expected,
      secret: spec.secret === true,
      ...(spec.hint === undefined ? {} : { hint: spec.hint }),
    };

    if (value === undefined) {
      if (requiredHere) issues.push({ ...base, problem: 'missing' });
      continue;
    }
    if (!checkValue(spec, value)) {
      issues.push({ ...base, problem: 'invalid' });
      continue;
    }
    values[spec.key] = value;
  }

  return { ok: issues.length === 0, role, issues, values };
}

/**
 * Render the actionable startup message. Key names, never values: a secret that
 * is *wrong* is still a secret (R-015-5).
 */
export function formatIssues(issues: readonly EnvIssue[], role: Role): string {
  if (issues.length === 0) return `Configuration valid for role "${role}".`;
  const lines = [
    `Configuration invalid for role "${role}" — ${issues.length} problem(s) found before startup:`,
    '',
  ];
  const width = Math.max(...issues.map((issue) => issue.key.length));
  for (const issue of issues) {
    const tag = issue.problem === 'missing' ? 'MISSING' : 'INVALID';
    const detail =
      issue.problem === 'missing'
        ? `required, expected ${issue.expected}`
        : `expected ${issue.expected}`;
    const hint = issue.hint ? ` [hint: ${issue.hint}]` : '';
    const secretMark = issue.secret ? ' (secret — value never printed)' : '';
    lines.push(`  ${tag.padEnd(8)}${issue.key.padEnd(width + 2)}${detail}${hint}${secretMark}`);
  }
  lines.push(
    '',
    'Fix these in .env (every name is listed in .env.example, names only) and restart the service.',
  );
  return lines.join('\n');
}
