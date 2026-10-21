/**
 * S-19 — Failures & health view model (US-003, US-011, US-012, US-013,
 * R-008-3, R-011-2, R-012-1/2/4, R-018-1…3, UX_SPEC IP-07/IP-08, J-10,
 * UI_SPEC §6.10 W-09, §9.6).
 *
 * Everything is a derivation of the frozen contract's `HealthReportSchema` and
 * `AttemptRowSchema`. Three honesty rules drive it:
 *
 *  - a provider is only `ok` when the key is present *and* qualification
 *    passed; anything else is named (`key absent`, `not qualified`), never
 *    softened to a green dot;
 *  - an attempt that timed out, or whose charge status is unknown, always
 *    reads `unknown charge` — never `unbilled` (R-012-4, AX-26);
 *  - the attempt list is a debug list: newest first, 50 rows, a stage filter,
 *    no totals, no averages (D2, IP-08). The contract's attempt row carries no
 *    `billed_units`, so this surface does not invent a units column.
 */
import type { z } from 'zod';

import { STAGE_CODES, STAGE_LABELS, type StageCode } from '../../shared/stages.js';
import { PROVIDER_NAMES, type ProviderName } from '../../shared/states.js';
import type {
  AttemptRowSchema,
  HealthComponentSchema,
  HealthReportSchema,
  ProviderHealthSchema,
} from '../../../contract/api.js';
import { describeAge, formatBytes, isoSeconds } from '../format.js';

export type HealthReport = z.infer<typeof HealthReportSchema>;
export type HealthComponent = z.infer<typeof HealthComponentSchema>;
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;
export type AttemptRow = z.infer<typeof AttemptRowSchema>;

/** `attempts.list` caps a page at 50 (`AttemptsQuerySchema.limit`). */
export const ATTEMPT_PAGE_SIZE = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Providers and qualification
// ─────────────────────────────────────────────────────────────────────────────

export interface ProviderMeta {
  readonly label: string;
  /** The environment key named in S-21's setup copy (src/config/env.ts). */
  readonly envKey: string;
  readonly detail: string;
}

export const PROVIDER_META: Readonly<Record<ProviderName, ProviderMeta>> = {
  deepseek: {
    label: 'Text and research',
    envKey: 'DEEPSEEK_API_KEY',
    detail: 'DeepSeek chat · Search · Fetch',
  },
  gemini: {
    label: 'Image',
    envKey: 'GEMINI_API_KEY',
    detail: 'gemini-nano-banana-2.1',
  },
  elevenlabs: {
    label: 'Narration (TTS)',
    envKey: 'ELEVENLABS_API_KEY',
    detail: 'convert-with-timestamps',
  },
};

export function providerMeta(provider: string): ProviderMeta {
  const known = (PROVIDER_NAMES as readonly string[]).includes(provider)
    ? PROVIDER_META[provider as ProviderName]
    : undefined;
  return known ?? { label: provider, envKey: provider.toUpperCase() + '_API_KEY', detail: '' };
}

export type ProviderState = 'ok' | 'key_absent' | 'not_qualified';

export interface ProviderRow {
  readonly provider: string;
  readonly label: string;
  readonly detail: string;
  readonly envKey: string;
  readonly keyPresent: boolean;
  readonly qualified: boolean;
  readonly qualifiedAt: string | null;
  readonly idempotencyProtected: boolean;
  readonly note: string | null;
  readonly state: ProviderState;
  readonly stateWord: string;
  readonly qualifiedLine: string;
}

export function providerRows(providers: readonly ProviderHealth[]): ProviderRow[] {
  return providers.map((provider) => {
    const meta = providerMeta(provider.provider);
    const state: ProviderState = !provider.key_present
      ? 'key_absent'
      : !provider.qualified
        ? 'not_qualified'
        : 'ok';
    return {
      provider: provider.provider,
      label: meta.label,
      detail: meta.detail,
      envKey: meta.envKey,
      keyPresent: provider.key_present,
      qualified: provider.qualified,
      qualifiedAt: provider.qualified_at,
      idempotencyProtected: provider.idempotency_protected,
      note: provider.note,
      state,
      stateWord: state === 'ok' ? 'ok' : state === 'key_absent' ? 'key absent' : 'not qualified',
      qualifiedLine: provider.qualified
        ? provider.qualified_at === null
          ? 'PASS · date not recorded'
          : 'PASS ' + isoSeconds(provider.qualified_at)
        : 'NOT RUN',
    };
  });
}

export interface QualificationRow {
  readonly provider: string;
  readonly label: string;
  readonly passed: boolean;
  readonly line: string;
}

export function qualificationRows(providers: readonly ProviderHealth[]): QualificationRow[] {
  return providers.map((provider) => ({
    provider: provider.provider,
    label: providerMeta(provider.provider).label,
    passed: provider.qualified,
    line: provider.qualified
      ? provider.qualified_at === null
        ? 'PASS · date not recorded'
        : 'PASS ' + isoSeconds(provider.qualified_at)
      : 'NOT RUN',
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Queue, disk, migration
// ─────────────────────────────────────────────────────────────────────────────

export interface QueueView {
  readonly waiting: number;
  readonly active: number;
  readonly failed: number;
  readonly line: string;
  readonly note: string | null;
}

export function queueView(report: HealthReport): QueueView | null {
  const queue = report.queue;
  if (queue === null) return null;
  return {
    waiting: queue.waiting,
    active: queue.active,
    failed: queue.failed,
    line: 'waiting ' + queue.waiting + ' · active ' + queue.active + ' · failed ' + queue.failed,
    note:
      queue.waiting > 0
        ? 'A queue is an attention reason (`waiting: <slot>`), not an error.'
        : null,
  };
}

export interface DiskView {
  readonly usedPercent: number;
  readonly free: string;
  readonly total: string;
  readonly headroomOk: boolean;
  readonly line: string;
  readonly warning: string | null;
}

export function diskView(report: HealthReport): DiskView | null {
  const disk = report.disk;
  if (disk === null) return null;
  const usedPercent =
    disk.total_bytes === 0
      ? 0
      : Math.round(((disk.total_bytes - disk.free_bytes) / disk.total_bytes) * 100);
  return {
    usedPercent,
    free: formatBytes(disk.free_bytes),
    total: formatBytes(disk.total_bytes),
    headroomOk: disk.headroom_ok,
    line:
      usedPercent +
      '% full · ' +
      formatBytes(disk.free_bytes) +
      ' free of ' +
      formatBytes(disk.total_bytes),
    warning: disk.headroom_ok
      ? null
      : 'Disk headroom is below the safety margin. New renders and image downloads will fail below it.',
  };
}

export interface MigrationView {
  readonly status: string;
  readonly version: string | null;
  readonly line: string;
  readonly failed: boolean;
}

export function migrationView(report: HealthReport): MigrationView {
  const status = report.migration.status;
  const word =
    status === 'up_to_date'
      ? 'up to date'
      : status === 'pending'
        ? 'pending'
        : status === 'failed'
          ? 'failed'
          : 'unknown';
  return {
    status,
    version: report.migration.version,
    line:
      'Migration ' +
      word +
      (report.migration.version === null ? '' : ' · ' + report.migration.version),
    failed: status === 'failed',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Attempt rows
// ─────────────────────────────────────────────────────────────────────────────

export type ChargeTone = 'billed' | 'unbilled' | 'pending' | 'unknown';

export interface AttemptRowModel {
  readonly id: string;
  readonly stage: StageCode;
  readonly stageLabel: string;
  readonly provider: string;
  readonly model: string;
  readonly requestId: string;
  readonly promptHash: string;
  readonly idempotency: 'protected' | 'unprotected';
  readonly charge: string;
  readonly chargeTone: ChargeTone;
  readonly status: string;
  readonly attempt: string;
  readonly errorLine: string | null;
  readonly backoff: string | null;
  readonly createdAbsolute: string;
  readonly createdRelative: string;
  readonly startedLine: string | null;
  readonly endedLine: string | null;
}

const CHARGE_WORD: Readonly<Record<ChargeTone, string>> = {
  billed: 'billed',
  unbilled: 'unbilled',
  pending: 'pending',
  unknown: 'unknown charge',
};

/**
 * R-012-4 / AX-26: a timeout may still have billed. Whatever the row's
 * `charge_status` says, a timed-out or unknown-charge attempt reads
 * `unknown charge`; the word `unbilled` is never attached to one.
 */
export function chargeFor(row: AttemptRow): { readonly tone: ChargeTone; readonly word: string } {
  if (
    row.status === 'timed_out' ||
    row.status === 'unknown_charge' ||
    row.charge_status === 'unknown'
  ) {
    return { tone: 'unknown', word: CHARGE_WORD.unknown };
  }
  const tone: ChargeTone =
    row.charge_status === 'billed'
      ? 'billed'
      : row.charge_status === 'pending'
        ? 'pending'
        : 'unbilled';
  return { tone, word: CHARGE_WORD[tone] };
}

const ATTEMPT_STATUS_WORD: Readonly<Record<string, string>> = {
  pending: 'pending',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  timed_out: 'timed out',
  unknown_charge: 'unknown charge',
  cancelled: 'cancelled',
};

export function attemptRowModel(row: AttemptRow, now: number): AttemptRowModel {
  const charge = chargeFor(row);
  const age = describeAge(now, row.created_at);
  return {
    id: row.id,
    stage: row.stage,
    stageLabel: STAGE_LABELS[row.stage],
    provider: row.provider,
    model: row.model,
    requestId: row.provider_request_id ?? '—',
    promptHash: row.prompt_hash,
    idempotency: row.idempotency_protected ? 'protected' : 'unprotected',
    charge: charge.word,
    chargeTone: charge.tone,
    status: ATTEMPT_STATUS_WORD[row.status] ?? row.status,
    attempt: row.attempt_no + ' of ' + row.max_attempts,
    errorLine:
      row.error_class === null
        ? row.http_status !== null && row.http_status >= 400
          ? 'error · HTTP ' + row.http_status
          : null
        : row.error_class + (row.http_status === null ? '' : ' · HTTP ' + row.http_status),
    backoff: row.backoff_s === null ? null : row.backoff_s + ' s',
    createdAbsolute: row.created_at,
    createdRelative: age.text,
    startedLine: row.started_at === null ? null : isoSeconds(row.started_at),
    endedLine: row.ended_at === null ? null : isoSeconds(row.ended_at),
  };
}

/** Newest first by `created_at`; ties keep the order the server sent. */
export function sortAttempts(rows: readonly AttemptRow[]): AttemptRow[] {
  return rows
    .map((row, index) => ({ row, index, at: Date.parse(row.created_at) }))
    .sort((left, right) => {
      const delta = (Number.isNaN(right.at) ? 0 : right.at) - (Number.isNaN(left.at) ? 0 : left.at);
      return delta === 0 ? left.index - right.index : delta;
    })
    .map((entry) => entry.row);
}

export function attemptRows(
  rows: readonly AttemptRow[],
  input: { readonly stage: StageCode | null; readonly now: number; readonly limit?: number },
): AttemptRowModel[] {
  const limit = input.limit ?? ATTEMPT_PAGE_SIZE;
  const filtered =
    input.stage === null ? [...rows] : rows.filter((row) => row.stage === input.stage);
  return sortAttempts(filtered)
    .slice(0, limit)
    .map((row) => attemptRowModel(row, input.now));
}

export interface StageOption {
  readonly code: StageCode;
  readonly label: string;
}

export const STAGE_OPTIONS: readonly StageOption[] = STAGE_CODES.map((code) => ({
  code,
  label: STAGE_LABELS[code],
}));

export interface AttemptsView {
  readonly videoId: string | null;
  readonly videoLabel: string | null;
  readonly stage: StageCode | null;
  readonly stageOptions: readonly StageOption[];
  readonly rows: readonly AttemptRowModel[];
  /** True when the page is full: older rows exist but cannot be requested. */
  readonly truncated: boolean;
  readonly limitLine: string;
  readonly errorLine: string | null;
  readonly emptyLine: string | null;
  readonly disabledLine: string | null;
}

export function attemptsView(input: {
  readonly videoId: string | null;
  readonly videoLabel: string | null;
  readonly stage: StageCode | null;
  readonly rows: readonly AttemptRow[] | null;
  readonly now: number;
  readonly error: boolean;
}): AttemptsView {
  const rows =
    input.rows === null ? [] : attemptRows(input.rows, { stage: input.stage, now: input.now });
  const selected = input.videoId !== null;
  return {
    videoId: input.videoId,
    videoLabel: input.videoLabel,
    stage: input.stage,
    stageOptions: STAGE_OPTIONS,
    rows,
    truncated: rows.length >= ATTEMPT_PAGE_SIZE,
    limitLine: selected
      ? rows.length >= ATTEMPT_PAGE_SIZE
        ? 'Showing the newest 50 attempt rows. The attempts endpoint takes a limit but no offset, so older rows are not paged here.'
        : 'Newest first, up to 50 rows.'
      : 'Attempt rows are listed per video, newest first, up to 50.',
    errorLine: input.error ? 'The attempt rows could not be loaded. Nothing was changed.' : null,
    emptyLine:
      !selected && input.error === false
        ? 'Choose a video to list its attempt rows. Attempts are recorded per video, not per service.'
        : selected && rows.length === 0 && !input.error
          ? input.stage === null
            ? 'No attempt rows for this video.'
            : 'No attempt rows for this video at ' +
              input.stage +
              ' (' +
              STAGE_LABELS[input.stage] +
              ').'
          : null,
    disabledLine: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Page model
// ─────────────────────────────────────────────────────────────────────────────

export interface HealthSummary {
  readonly readyWord: string;
  readonly ready: boolean;
  readonly checkedLine: string;
  readonly serviceLine: string;
  readonly migration: MigrationView;
  readonly providers: readonly ProviderRow[];
  readonly qualification: readonly QualificationRow[];
  readonly queue: QueueView | null;
  readonly disk: DiskView | null;
  readonly degradedReasons: readonly string[];
}

export function healthSummary(report: HealthReport): HealthSummary {
  return {
    ready: report.ready,
    readyWord: report.ready ? 'Service ready' : 'Service not ready',
    checkedLine: 'Checked ' + isoSeconds(report.checked_at),
    serviceLine: 'Reported by the ' + report.service + ' process',
    migration: migrationView(report),
    providers: providerRows(report.providers),
    qualification: qualificationRows(report.providers),
    queue: queueView(report),
    disk: diskView(report),
    degradedReasons: report.degraded_reasons,
  };
}
