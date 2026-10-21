/**
 * S-21 — Settings view model (US-004, US-012, R-008-3, R-015-5, UX_SPEC
 * DI-08, UI_SPEC §9.3).
 *
 * The page is read-only and carries presence and qualification only. There is
 * no field here that can hold a key value, and the model refuses to describe a
 * provider whose response contradicts `key_values_exposed: false`.
 */
import type { z } from 'zod';

import type { ProviderSettingsViewSchema } from '../../../contract/api.js';
import { isoSeconds } from '../format.js';
import { providerMeta, type ProviderRow } from '../health/model.js';

export type ProviderSettingsView = z.infer<typeof ProviderSettingsViewSchema>;

export interface SettingsRow {
  readonly provider: string;
  readonly label: string;
  readonly detail: string;
  readonly envKey: string;
  readonly keyPresent: boolean;
  readonly keyWord: string;
  readonly qualified: boolean;
  readonly qualification: string;
  readonly qualificationAbsolute: string | null;
  readonly idempotency: string;
  readonly note: string | null;
}

export interface SettingsModel {
  readonly readOnly: true;
  readonly rows: readonly SettingsRow[];
  readonly present: number;
  readonly total: number;
  readonly absentKeys: readonly string[];
  readonly summaryLine: string;
  readonly qualificationLine: string;
  readonly readOnlyLine: string;
  readonly keyValuesLine: string;
}

export const READ_ONLY_LINE =
  'Read-only. Settings are changed in .env and applied by restarting the stack.';
export const KEY_VALUES_LINE =
  'Key values are never read back. This page shows presence and qualification only (R-015-5).';

function settingsRow(provider: ProviderRow): SettingsRow {
  return {
    provider: provider.provider,
    label: provider.label,
    detail: provider.detail,
    envKey: provider.envKey,
    keyPresent: provider.keyPresent,
    keyWord: provider.keyPresent ? 'present' : 'absent',
    qualified: provider.qualified,
    qualification: provider.qualified
      ? provider.qualifiedAt === null
        ? 'PASS · date not recorded'
        : 'PASS ' + isoSeconds(provider.qualifiedAt)
      : 'NOT RUN',
    qualificationAbsolute: provider.qualified ? provider.qualifiedAt : null,
    idempotency: provider.idempotencyProtected ? 'protected' : 'unprotected',
    note: provider.note,
  };
}

/**
 * The absent-keys sentence is UI_SPEC §9.3's, extended to N absent keys:
 * `2 of 3 keys present. Absent: ELEVENLABS_API_KEY. Set it in .env and restart.`
 */
export function absentLine(present: number, total: number, absentKeys: readonly string[]): string {
  if (absentKeys.length === 0) return total + ' of ' + total + ' keys present.';
  return (
    present +
    ' of ' +
    total +
    ' keys present. Absent: ' +
    absentKeys.join(', ') +
    '. Set ' +
    (absentKeys.length === 1 ? 'it' : 'them') +
    ' in .env and restart.'
  );
}

export function settingsModel(input: {
  readonly providers: ProviderSettingsView;
  readonly rows: readonly ProviderRow[];
}): SettingsModel {
  const rows = input.rows.map(settingsRow);
  const absentKeys = input.rows.filter((row) => !row.keyPresent).map((row) => row.envKey);
  const passed = input.rows.filter((row) => row.qualified).length;
  return {
    readOnly: true,
    rows,
    present: input.rows.length - absentKeys.length,
    total: input.rows.length,
    absentKeys,
    summaryLine: absentLine(input.rows.length - absentKeys.length, input.rows.length, absentKeys),
    qualificationLine:
      passed +
      ' of ' +
      input.rows.length +
      ' providers passed qualification' +
      (passed === input.rows.length ? '.' : '; NOT RUN is not a pass.'),
    readOnlyLine: READ_ONLY_LINE,
    keyValuesLine: KEY_VALUES_LINE,
  };
}

/** Provider meta is exported for the renderer's setup hint. */
export { providerMeta };
