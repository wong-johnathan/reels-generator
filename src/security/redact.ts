/**
 * Secret denylist + redaction — R-015-5, TECH_DESIGN §8.4.
 *
 * Two layers, because either alone is insufficient:
 *   (a) *shape* patterns for credentials that have a recognisable form
 *       (DeepSeek `sk-…`, Google `AIza…`, the ElevenLabs 32-hex key, bearer
 *       tokens, credentials embedded in a database URL);
 *   (b) *value* matching for every configured secret environment value, so a
 *       key whose shape drifts is still caught when it appears verbatim.
 *
 * The scan never returns or logs the secret: a finding carries the kind, the
 * offset, the length and a short sha256 fingerprint. That is enough to prove
 * "0 matches" and to locate a leak, and it cannot be used to reconstruct one.
 *
 * `assertNoSecrets` is the release-gate form (0 matches on logs and export
 * artefacts); `redactText`/`redactValue` are the in-place form used by the
 * structured logger.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface SecretPattern {
  readonly kind: string;
  readonly pattern: RegExp;
}

/** TECH_DESIGN §8.4 verbatim shapes. */
export const DENYLIST_PATTERNS: readonly SecretPattern[] = [
  { kind: 'deepseek_api_key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // ElevenLabs keys are 32 hex characters — indistinguishable from a 32-hex hash,
  // so the shape only counts next to a credential label. The env-value layer
  // (ELEVENLABS_API_KEY) remains the authoritative match for the real key.
  {
    kind: 'elevenlabs_api_key',
    pattern:
      /(?:\bxi-api-key\b|\beleven[a-z]*\b|\bapi[_-]?key\b|\bsecret\b|\btoken\b)["']?\s*[:=]\s*["']?[0-9a-f]{32}\b/gi,
  },
  { kind: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  {
    kind: 'database_url_credentials',
    pattern: /\b(?:postgres(?:ql)?|redis|rediss):\/\/[^:@\s/]+:[^@\s/]+@/gi,
  },
  { kind: 'xi_api_key_header', pattern: /\bxi-api-key["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}/gi },
];

/** Environment keys whose *values* are secrets (TECH_DESIGN §9.6). */
export const SECRET_ENV_KEYS = [
  'SESSION_SECRET',
  'OPERATOR_PASSWORD',
  'POSTGRES_PASSWORD',
  'MINIO_ROOT_PASSWORD',
  'MINIO_ROOT_USER',
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
  'ELEVENLABS_API_KEY',
] as const;

const URL_ENV_KEYS = ['DATABASE_URL', 'POSTGRES_URL', 'REDIS_URL'] as const;

/** Values shorter than this are too likely to be substrings of ordinary text. */
const MIN_ENV_SECRET_LENGTH = 8;

export interface RedactOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Additional literal secrets (e.g. a value read from a file). */
  readonly extraSecrets?: readonly string[];
  readonly replacement?: (kind: string) => string;
}

export interface SecretFinding {
  readonly kind: string;
  readonly index: number;
  readonly length: number;
  /** sha256(value) truncated to 8 hex — lets two findings be compared without the value. */
  readonly fingerprint: string;
}

interface Candidate extends SecretFinding {
  /** 0 = shape pattern, 1 = literal env value; shapes win a tie. */
  readonly specificity: number;
}

/** Credentials embedded in `scheme://user:password@host` URL values. */
function urlPassword(value: string): string | null {
  const match = /\b[a-z][a-z0-9+.-]*:\/\/[^:@\s/]+:([^@\s/]+)@/i.exec(value);
  return match?.[1] && match[1].length >= MIN_ENV_SECRET_LENGTH ? match[1] : null;
}

function literalSecrets(options: RedactOptions): string[] {
  const values = new Set<string>();
  const env = options.env ?? {};
  for (const key of SECRET_ENV_KEYS) {
    const value = env[key];
    if (value && value.length >= MIN_ENV_SECRET_LENGTH) values.add(value);
  }
  for (const key of URL_ENV_KEYS) {
    const value = env[key];
    if (!value) continue;
    const password = urlPassword(value);
    if (password) values.add(password);
  }
  for (const value of options.extraSecrets ?? []) {
    if (value.length >= MIN_ENV_SECRET_LENGTH) values.add(value);
  }
  return [...values];
}

function fingerprintOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
}

function collect(text: string, options: RedactOptions): Candidate[] {
  const candidates: Candidate[] = [];

  for (const { kind, pattern } of DENYLIST_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    for (const match of text.matchAll(regex)) {
      if (match.index === undefined) continue;
      candidates.push({
        kind,
        index: match.index,
        length: match[0].length,
        fingerprint: fingerprintOf(match[0]),
        specificity: 0,
      });
    }
  }

  for (const value of literalSecrets(options)) {
    let from = 0;
    while (from <= text.length - value.length) {
      const index = text.indexOf(value, from);
      if (index === -1) break;
      candidates.push({
        kind: 'env_value',
        index,
        length: value.length,
        fingerprint: fingerprintOf(value),
        specificity: 1,
      });
      from = index + value.length;
    }
  }

  return candidates;
}

function nonOverlapping(candidates: readonly Candidate[]): Candidate[] {
  const ordered = [...candidates].sort(
    (a, b) => a.index - b.index || b.length - a.length || a.specificity - b.specificity,
  );
  const accepted: Candidate[] = [];
  let lastEnd = -1;
  for (const candidate of ordered) {
    if (candidate.index < lastEnd) continue;
    accepted.push(candidate);
    lastEnd = candidate.index + candidate.length;
  }
  return accepted;
}

/** All secret matches in `text`, ordered by position. Never includes the secret. */
export function scanForSecrets(text: string, options: RedactOptions = {}): SecretFinding[] {
  return nonOverlapping(collect(text, options)).map(({ kind, index, length, fingerprint }) => ({
    kind,
    index,
    length,
    fingerprint,
  }));
}

/** Replace every match with `[REDACTED:<kind>]` (or a caller-supplied label). */
export function redactText(text: string, options: RedactOptions = {}): string {
  const matches = nonOverlapping(collect(text, options));
  if (matches.length === 0) return text;
  const label = options.replacement ?? ((kind: string) => `[REDACTED:${kind}]`);
  let output = '';
  let cursor = 0;
  for (const match of matches) {
    output += text.slice(cursor, match.index);
    output += label(match.kind);
    cursor = match.index + match.length;
  }
  return output + text.slice(cursor);
}

const SECRET_FIELD =
  /(pass(word|phrase)?|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key)/i;

/**
 * Deep-redact a value for structured logging: field names that name a secret are
 * replaced wholesale, and every remaining string is scrubbed by shape/value.
 * Cycles become `[Circular]` so a logger can never throw on a hostile object.
 */
export function redactValue(
  value: unknown,
  options: RedactOptions = {},
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === 'string') return redactText(value, options);
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `<buffer:${value.length}>`;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message, options),
      ...(value.stack ? { stack: redactText(value.stack, options) } : {}),
    };
  }
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redactValue(item, options, seen));
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([key, item]) => [
        String(key),
        SECRET_FIELD.test(String(key)) ? '[REDACTED]' : redactValue(item, options, seen),
      ]),
    );
  }
  if (value instanceof Set) return [...value].map((item) => redactValue(item, options, seen));

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] =
      SECRET_FIELD.test(key) && item !== undefined && item !== null && item !== ''
        ? '[REDACTED]'
        : redactValue(item, options, seen);
  }
  return output;
}

/** JSON for a log line or sidecar, redacted and cycle-safe. */
export function redactJson(value: unknown, options: RedactOptions = {}): string {
  return JSON.stringify(redactValue(value, options));
}

/** A leak that names what and where — never the secret. */
export class SecretLeakError extends Error {
  constructor(
    readonly count: number,
    readonly kinds: readonly string[],
    readonly label: string,
  ) {
    super(
      `secret denylist scan found ${count} match(es) in ${label}` +
        (kinds.length > 0 ? ` (${[...new Set(kinds)].join(', ')})` : ''),
    );
    this.name = 'SecretLeakError';
  }
}

/** Release-gate form: throw unless the content scans clean. */
export function assertNoSecrets(
  text: string,
  options: RedactOptions = {},
  label = 'content',
): void {
  const findings = scanForSecrets(text, options);
  if (findings.length > 0) {
    throw new SecretLeakError(
      findings.length,
      findings.map((finding) => finding.kind),
      label,
    );
  }
}

export interface DirectoryScanFinding extends SecretFinding {
  readonly file: string;
}

export interface DirectoryScanResult {
  readonly filesScanned: number;
  readonly findings: readonly DirectoryScanFinding[];
}

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules']);

/** A file is treated as text unless its first 4 KiB contain a NUL byte. */
function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 4096).includes(0);
}

/**
 * Scan a log directory or an unpacked export tree (TECH_DESIGN §8.4b). The
 * result names files and kinds so an operator can act, and never echoes a value.
 */
export function scanDirectory(root: string, options: RedactOptions = {}): DirectoryScanResult {
  const findings: DirectoryScanFinding[] = [];
  let filesScanned = 0;

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const buffer = readFileSync(full);
        if (looksBinary(buffer)) continue;
        filesScanned += 1;
        for (const finding of scanForSecrets(buffer.toString('utf8'), options)) {
          findings.push({ ...finding, file: full });
        }
      }
    }
  };

  walk(root);
  return { filesScanned, findings };
}
